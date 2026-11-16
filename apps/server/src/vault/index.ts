/**
 * Local SecretVault (ARCHITECTURE 7.3): XChaCha20-Poly1305 per secret under a random data key; the data key is
 * wrapped by a master key from the OS keychain, a passphrase (argon2id), or `vault.key` (0600). Host runner mode
 * never uses a `vault.key` file: an agent CLI shares the server's OS user there, so a key file would be one `cat`
 * away (7.2). Plus the redaction filter every outbound text passes.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  type AccessReason,
  type ScopedVault,
  type SecretMeta,
  type SecretRef,
  type SecretVault,
  ulid,
  type VaultBackend,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import { deriveKey } from '../auth/password.js';
import {
  dpapiMasterKey,
  fallbackKeyFile,
  type KeyToolRunner,
  OsKeyError,
  secretToolMasterKey,
} from './os-key.js';

/**
 * keychain: macOS login keychain. dpapi: Windows DPAPI (CurrentUser). os-keyring: the Linux desktop keyring
 * (secret-tool), else a 0600 key file the owner is told about. passphrase: argon2id. file: `vault.key` (non-host).
 * home-file: host mode with a data folder that is not the standard one (a temp or test server): a 0600 `vault.key`
 * inside that folder, never the user's own key store (a vault such a folder made with the OS store before keeps it).
 */
export type MasterKeySource = 'keychain' | 'dpapi' | 'os-keyring' | 'passphrase' | 'file' | 'home-file';

export class VaultConfigError extends Error {}

/** What the owner should know about how the vault key is kept (a startup card). */
export type VaultNotice = 'vault-key-file';

export interface VaultOptions {
  db: Sqlite;
  home: string;
  serverId: string;
  /** runner mode decides whether a key file is acceptable */
  runnerMode: string;
  source?: MasterKeySource;
  passphrase?: string;
  /** the keychain's `security` tool; tests pass a fake so they never touch the real keychain */
  security?: SecurityRunner;
  /** PowerShell (DPAPI) and secret-tool runner; tests pass a fake */
  keyTool?: KeyToolRunner;
  onNotice?: (n: VaultNotice) => void;
}

/**
 * The OS key store for host mode by platform (the `pasabot-server` entry passes it; library and test boots never
 * touch a real key store): macOS keychain, Windows DPAPI, Linux desktop keyring (else a key file). A passphrase,
 * when given, wins everywhere.
 */
export function osMasterKeySource(platform: NodeJS.Platform = process.platform): MasterKeySource | undefined {
  if (platform === 'darwin') return 'keychain';
  if (platform === 'win32') return 'dpapi';
  if (platform === 'linux') return 'os-keyring';
  return undefined;
}

/**
 * The master-key source the `pasabot-server` entry asks for. The OS key store (login keychain, DPAPI, desktop keyring)
 * belongs to the standard data folder only: a server on another `PASABOT_HOME` (a temp folder, a QA or test server) or
 * under a test runner keeps its key inside its own folder (`home-file`), so it never writes an item such as
 * `pasabot-<server id>` into the user's keychain. A passphrase, when given, wins (undefined: the default rules).
 */
export function hostMasterKeySource(o: {
  home: string;
  hostMode: boolean;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  platform?: NodeJS.Platform;
}): MasterKeySource | undefined {
  const env = o.env ?? process.env;
  if (!o.hostMode || env.PASABOT_VAULT_PASSPHRASE) return undefined;
  const same = (a: string, b: string) => {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    return resolve(a) === resolve(b) || real(a) === real(b);
  };
  const standard = same(o.home, join(o.userHome ?? homedir(), '.pasabot'));
  const underTests = !!env.VITEST || env.NODE_ENV === 'test';
  if (!standard || underTests) return 'home-file';
  return osMasterKeySource(o.platform);
}

const seal = (key: Uint8Array, plain: Uint8Array) => {
  const nonce = randomBytes(24);
  return { nonce, ct: Buffer.from(xchacha20poly1305(key, nonce).encrypt(plain)) };
};
const open = (key: Uint8Array, nonce: Uint8Array, ct: Uint8Array) =>
  Buffer.from(xchacha20poly1305(key, nonce).decrypt(ct));

const getSetting = <T>(db: Sqlite, key: string): T | undefined => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : undefined;
};
const setSetting = (db: Sqlite, key: string, value: unknown) =>
  db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, JSON.stringify(value));

/**
 * Pick the master-key source: explicit > passphrase > (host modes) passphrase required > file (non-host).
 * The OS keychain is used only when asked for explicitly (the `pasabot-server` entry does on macOS), so library
 * and test boots never touch the user's keychain.
 */
export function chooseMasterKeySource(o: {
  runnerMode: string;
  source?: MasterKeySource;
  passphrase?: string;
}) {
  if (o.source) return o.source;
  if (o.passphrase) return 'passphrase';
  if (o.runnerMode === 'host' || o.runnerMode === 'host-unsandboxed') return 'passphrase';
  return 'file';
}

async function loadMasterKey(o: VaultOptions): Promise<Buffer> {
  const source = chooseMasterKeySource(o);
  const hostMode = o.runnerMode === 'host' || o.runnerMode === 'host-unsandboxed';
  if (source === 'file') {
    if (hostMode)
      throw new VaultConfigError(
        'host runner mode never uses a vault.key file; use the OS keychain or a passphrase',
      );
    const p = join(o.home, 'vault.key');
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('base64'), { mode: 0o600 });
    chmodSync(p, 0o600);
    return Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
  }
  const hasDataKey = getSetting(o.db, 'vault.dataKey') !== undefined;
  if (source === 'home-file') {
    const keyFile = existsSync(join(o.home, 'vault.key'));
    if (hasDataKey && !keyFile && getSetting(o.db, 'vault.keySource') !== 'home-file') {
      // a vault this folder made before with a passphrase or the OS key store: it opens only there
      if (getSetting(o.db, 'vault.kdfSalt') !== undefined)
        throw new VaultConfigError('vault passphrase required (PASABOT_VAULT_PASSPHRASE)');
      const os = osMasterKeySource();
      if (os) return loadMasterKey({ ...o, source: os });
    }
    try {
      const key = fallbackKeyFile(o.home, hasDataKey);
      if (getSetting(o.db, 'vault.keySource') !== 'home-file')
        setSetting(o.db, 'vault.keySource', 'home-file');
      return key;
    } catch (e) {
      if (e instanceof OsKeyError) throw new VaultConfigError(e.message);
      throw e;
    }
  }
  if (source === 'dpapi') {
    try {
      return dpapiMasterKey(o.home, hasDataKey, o.keyTool);
    } catch (e) {
      if (e instanceof OsKeyError) throw new VaultConfigError(e.message);
      throw e;
    }
  }
  if (source === 'os-keyring') {
    // Linux desktop: the keyring when it works; else (first start only) a 0600 key file, and the owner is told
    const used = getSetting<string>(o.db, 'vault.keySource');
    try {
      if (used !== 'file') {
        const key = secretToolMasterKey(
          `pasabot-${o.serverId}`,
          { hasDataKey, usedBefore: used === 'secret-tool' },
          o.keyTool,
        );
        if (key) {
          if (used !== 'secret-tool') setSetting(o.db, 'vault.keySource', 'secret-tool');
          return key;
        }
      }
      const key = fallbackKeyFile(o.home, hasDataKey);
      if (used !== 'file') setSetting(o.db, 'vault.keySource', 'file');
      o.onNotice?.('vault-key-file');
      return key;
    } catch (e) {
      if (e instanceof OsKeyError) throw new VaultConfigError(e.message);
      throw e;
    }
  }
  if (hostMode && existsSync(join(o.home, 'vault.key')))
    throw new VaultConfigError('a vault.key file exists but host runner mode refuses key files; remove it');
  if (source === 'passphrase') {
    if (!o.passphrase) throw new VaultConfigError('vault passphrase required (PASABOT_VAULT_PASSPHRASE)');
    let salt = getSetting<string>(o.db, 'vault.kdfSalt');
    if (!salt) {
      salt = randomBytes(16).toString('base64');
      setSetting(o.db, 'vault.kdfSalt', salt);
    }
    return deriveKey(o.passphrase, Buffer.from(salt, 'base64'));
  }
  return keychainMasterKey(`pasabot-${o.serverId}`, o.security);
}

/** One `security` call: exit status (null when it could not run) and stdout. Never through a shell. */
export type SecurityRunner = (args: string[], input?: string) => { status: number | null; stdout: string };
const runSecurity: SecurityRunner = (args, input) => {
  const r = spawnSync('security', args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};
/** `security` exits with the low byte of the OSStatus: errSecItemNotFound (-25300) is 44. */
const ITEM_NOT_FOUND = 44;
const KEYCHAIN_SERVICE = 'pasabot-vault';

/**
 * The vault master key from the macOS keychain via the `security` tool (no shell; the key never touches disk in
 * clear). A new key is made only when the item is certainly missing (exit 44): a locked keychain, a refused or
 * cancelled prompt, or any other failure is a VaultConfigError (the vault is unavailable for this run) and the
 * item is left alone. A new key is added without `-U`, so an existing item is never replaced, and is used only
 * once it reads back from the keychain: the master key returned is always the one the next boot will find.
 */
export function keychainMasterKey(account: string, security: SecurityRunner = runSecurity): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(account))
    throw new VaultConfigError('vault: unexpected keychain account name');
  const find = () => security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
  const decode = (r: { stdout: string }, what: string) => {
    const key = Buffer.from(r.stdout.trim(), 'base64');
    if (key.length !== 32)
      throw new VaultConfigError(`the keychain's vault master key is malformed (${what})`);
    return key;
  };
  const found = find();
  if (found.status === 0) return decode(found, 'stored item');
  if (found.status !== ITEM_NOT_FOUND)
    throw new VaultConfigError(
      `the keychain could not be read (security exit ${found.status ?? 'none'}: locked, prompt refused, or ` +
        'unavailable); unlock the login keychain and start again. The vault master key was left untouched',
    );
  // the key goes over stdin (`security -i`), never in argv where `ps` could see it; no -U: never replace an item
  security(
    ['-i'],
    `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w ${randomBytes(32).toString('base64')}\n`,
  );
  const stored = find();
  if (stored.status !== 0)
    throw new VaultConfigError(
      `the vault master key could not be stored in the keychain (security exit ${stored.status ?? 'none'}); ` +
        'unlock the login keychain and start again',
    );
  // whatever reads back is the persisted key (ours, or one another process added first): never an unstored one
  return decode(stored, 'read back after create');
}

interface SecretRow {
  id: string;
  name: string;
  scope: string;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  key_version: number;
  backend: string;
  ref: string | null;
  created_at: number;
  rotated_at: number | null;
}

export class LocalVault implements SecretVault {
  private backends = new Map<string, VaultBackend>();
  private known = new Map<string, string>(); // value -> name
  private current = new Map<string, string>(); // `${scope}\0${name}` -> value
  private constructor(
    private readonly db: Sqlite,
    private master: Buffer,
    private dataKey: Uint8Array,
    private keyVersion: number,
  ) {}

  static async open(o: VaultOptions): Promise<LocalVault> {
    const master = await loadMasterKey(o);
    let wrapped = getSetting<{ nonce: string; ct: string; v: number }>(o.db, 'vault.dataKey');
    if (!wrapped) {
      const dk = randomBytes(32);
      const s = seal(master, dk);
      wrapped = { nonce: s.nonce.toString('base64'), ct: s.ct.toString('base64'), v: 1 };
      setSetting(o.db, 'vault.dataKey', wrapped);
    }
    let dataKey: Buffer;
    try {
      dataKey = open(master, Buffer.from(wrapped.nonce, 'base64'), Buffer.from(wrapped.ct, 'base64'));
    } catch {
      throw new VaultConfigError(
        'vault master key does not match this database (wrong passphrase or keychain item)',
      );
    }
    const v = new LocalVault(o.db, master, dataKey, wrapped.v);
    for (const r of o.db.prepare("SELECT * FROM secrets WHERE backend = 'local'").all() as SecretRow[]) {
      if (r.ciphertext && r.nonce)
        v.remember(r.scope, r.name, open(dataKey, r.nonce, r.ciphertext).toString('utf8'));
    }
    return v;
  }

  /**
   * The redaction set holds each entry's current value only, as after a restart: an overwrite (a rotated key, a
   * channel session saved again and again) retires the old value unless another entry still holds it, so the set
   * never grows with every save.
   */
  private remember(scope: string, name: string, value: string) {
    const key = `${scope}\0${name}`;
    const old = this.current.get(key);
    this.current.set(key, value);
    if (old !== undefined && old !== value) {
      let holder: string | undefined;
      for (const [k, v] of this.current) if (v === old) holder = k.slice(k.indexOf('\0') + 1);
      if (holder === undefined) this.known.delete(old);
      else this.known.set(old, holder);
    }
    this.known.set(value, name);
  }

  async put(scope: string, name: string, value: string): Promise<SecretRef> {
    const { nonce, ct } = seal(this.dataKey, Buffer.from(value, 'utf8'));
    const existing = this.db
      .prepare('SELECT id FROM secrets WHERE scope = ? AND name = ?')
      .get(scope, name) as { id: string } | undefined;
    const id = existing?.id ?? ulid();
    this.db
      .prepare(
        `INSERT INTO secrets (id, name, scope, ciphertext, nonce, key_version, backend, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'local', ?)
         ON CONFLICT(scope, name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
           key_version = excluded.key_version, backend = 'local', ref = NULL, rotated_at = ?`,
      )
      .run(id, name, scope, ct, nonce, this.keyVersion, Date.now(), Date.now());
    this.remember(scope, name, value);
    return { id, scope, name };
  }

  async get(ref: SecretRef, why: AccessReason): Promise<string> {
    const r = this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(ref.id) as SecretRow | undefined;
    if (!r) throw new Error('secret not found');
    this.db
      .prepare(
        "INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target, data) VALUES (?, ?, 'system', ?, 'vault.read', ?, ?)",
      )
      .run(
        ulid(),
        Date.now(),
        why.actor,
        `${r.scope}/${r.name}`,
        JSON.stringify({ purpose: why.purpose, runId: why.runId }),
      );
    if (r.backend !== 'local') {
      const b = this.backends.get(r.backend);
      if (!b || !r.ref) throw new Error(`vault backend "${r.backend}" is not available`);
      const value = await b.resolve(r.ref);
      // a backend value is known only once fetched; from then on it is redacted like a local one (W14)
      if (value) this.remember(r.scope, r.name, value);
      return value;
    }
    return open(this.dataKey, r.nonce!, r.ciphertext!).toString('utf8');
  }

  /** A read-only backend reference (W14): only the ref is stored; the value is fetched on every `get`. */
  async putRef(scope: string, name: string, backend: string, ref: string): Promise<SecretRef> {
    if (backend === 'local' || !ref) throw new Error('a reference needs a backend and a ref');
    const existing = this.db
      .prepare('SELECT id FROM secrets WHERE scope = ? AND name = ?')
      .get(scope, name) as { id: string } | undefined;
    const id = existing?.id ?? ulid();
    this.db
      .prepare(
        `INSERT INTO secrets (id, name, scope, ciphertext, nonce, key_version, backend, ref, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(scope, name) DO UPDATE SET ciphertext = NULL, nonce = NULL, backend = excluded.backend,
           ref = excluded.ref, rotated_at = ?`,
      )
      .run(id, name, scope, this.keyVersion, backend, ref, Date.now(), Date.now());
    // the old local value (if any) stays redacted until a restart: it may already be out in the world
    this.current.delete(`${scope}\0${name}`);
    return { id, scope, name };
  }

  /** Deletes one entry; its last value stays in the redaction set until a restart. */
  async remove(id: string): Promise<boolean> {
    const r = this.db.prepare('SELECT scope, name FROM secrets WHERE id = ?').get(id) as
      | { scope: string; name: string }
      | undefined;
    if (!r) return false;
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
    this.current.delete(`${r.scope}\0${r.name}`);
    return true;
  }

  async list(scope?: string): Promise<SecretMeta[]> {
    const rows = (
      scope
        ? this.db.prepare('SELECT * FROM secrets WHERE scope = ? ORDER BY name').all(scope)
        : this.db.prepare('SELECT * FROM secrets ORDER BY scope, name').all()
    ) as SecretRow[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      name: r.name,
      backend: r.backend,
      createdAt: r.created_at,
      rotatedAt: r.rotated_at,
    }));
  }

  /** New data key; every local secret is re-encrypted and the key re-wrapped, in one transaction. */
  async rotateKey(): Promise<void> {
    const next = randomBytes(32);
    const version = this.keyVersion + 1;
    const rows = this.db.prepare("SELECT * FROM secrets WHERE backend = 'local'").all() as SecretRow[];
    this.db.transaction(() => {
      for (const r of rows) {
        if (!r.ciphertext || !r.nonce) continue;
        const plain = open(this.dataKey, r.nonce, r.ciphertext);
        const s = seal(next, plain);
        this.db
          .prepare(
            'UPDATE secrets SET ciphertext = ?, nonce = ?, key_version = ?, rotated_at = ? WHERE id = ?',
          )
          .run(s.ct, s.nonce, version, Date.now(), r.id);
      }
      const w = seal(this.master, next);
      setSetting(this.db, 'vault.dataKey', {
        nonce: w.nonce.toString('base64'),
        ct: w.ct.toString('base64'),
        v: version,
      });
    })();
    this.dataKey = next;
    this.keyVersion = version;
  }

  knownValues(): Iterable<string> {
    return this.known.keys();
  }
  nameOf(value: string): string | undefined {
    return this.known.get(value);
  }
  addBackend(b: VaultBackend): void {
    this.backends.set(b.id, b);
  }
}

// ---------- agent references (7.3, W14) ----------
/** `{{secret:NAME}}`: how an agent names a secret granted to it. */
export const SECRET_REF_RE = /^\{\{secret:([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}$/;

/**
 * What tool handlers get as `ctx.vault`: a `{{secret:name}}` reference (or the bare name) resolves only to an entry
 * in the agent's own scope `agent:<id>`, i.e. one the owner granted to this agent; every read is audited.
 */
export function agentScopedVault(vault: SecretVault, agentId: string, runId?: string): ScopedVault {
  return {
    async resolve(ref) {
      const t = ref.trim();
      const name = SECRET_REF_RE.exec(t)?.[1] ?? t;
      const hit = (await vault.list(`agent:${agentId}`)).find((s) => s.name === name);
      if (!hit) throw new Error(`no secret named "${name.slice(0, 64)}" is granted to this agent`);
      return vault.get(hit, { actor: `agent:${agentId}`, purpose: 'tool', runId });
    },
  };
}

// ---------- redaction (7.3) ----------
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI/Anthropic-style keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * The redaction filter. `stream` (W14) is for text that is still growing (a streamed reply): it also holds back a
 * tail that could be the first part of a known secret, so a value split across deltas never shows its first half.
 */
export type Redact = ((text: string) => string) & { stream?: (text: string) => string };

/** Shortest secret prefix held back at the end of streamed text. */
const MIN_HOLD = 3;
/** Anchor length used to jump between candidate starts of a long partial match. */
const ANCHOR = 8;
/**
 * Length of the longest tail of `out` that is a proper prefix of one of `forms` (0 when none). There is no cap on
 * the hold: a 3 KB key streamed in small deltas stays held back in full until it is complete. Candidate starts are
 * found with `indexOf` on the form's first chars (an anchor), so the cost is the search, never a shorter hold.
 */
function partialTail(out: string, forms: Iterable<string>): number {
  let cut = 0;
  for (const f of forms) {
    const maxK = Math.min(f.length - 1, out.length);
    if (maxK < MIN_HOLD || maxK <= cut) continue;
    // earliest start first: the first full match is the longest tail
    let i = out.length - maxK;
    const last = out.length - Math.max(MIN_HOLD, cut + 1);
    while (i <= last) {
      const k = out.length - i;
      if (k >= ANCHOR) {
        // a long candidate starts where the form's first ANCHOR chars occur
        const at = out.indexOf(f.slice(0, ANCHOR), i);
        if (at >= 0) {
          if (at > last) break;
          const kk = out.length - at;
          if (out.startsWith(f.slice(0, kk), at)) {
            cut = kk;
            break;
          }
          i = at + 1;
        } else i = out.length - ANCHOR + 1; // none: only the short tails are left to check
        continue;
      }
      if (out.startsWith(f.slice(0, k), i)) {
        cut = k;
        break;
      }
      i++;
    }
  }
  return cut;
}

const isWordCode = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // [A-Za-z0-9_]
const isTokenCode = (c: number) => isWordCode(c) || c === 45; // [A-Za-z0-9_-]
const isUpperOrSpace = (c: number) => (c >= 65 && c <= 90) || c === 32;
/** Prefixes of the TOKEN_SHAPES that start with a fixed text (kept in step with the list above). */
const TOKEN_PREFIXES = [
  'sk-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'xoxr-',
  'xoxs-',
  'AKIA',
];
const PEM_BEGIN = '-----BEGIN ';
const PEM_TYPE_END = 'PRIVATE KEY';
/** Telegram bot token: 8–10 digit id, ':', 35 token chars. */
const TG_SECRET_LEN = 35;

/**
 * Where an unterminated token shape starts at the end of streamed text (`out.length` when none), found with a
 * plain linear scan (no regex over agent text). Any complete shape was already replaced by `apply`, so what is left
 * here is still growing: an open private-key block, or a run that starts with a known token prefix, or a bot token
 * whose secret half has not fully arrived.
 */
function openTokenStart(out: string): number {
  let start = out.length;
  // an open `-----BEGIN [A-Z ]*PRIVATE KEY-----` (no END yet: a complete block is already `[secret]`)
  for (let i = out.indexOf(PEM_BEGIN); i >= 0 && i < start; i = out.indexOf(PEM_BEGIN, i + 1)) {
    let j = i + PEM_BEGIN.length;
    while (j < out.length && isUpperOrSpace(out.charCodeAt(j))) j++;
    const label = out.slice(i + PEM_BEGIN.length, j);
    // the label run reaches the end (may still become a private key) or it is one and its dashes follow
    const open =
      j === out.length || (label.endsWith(PEM_TYPE_END) && '-----'.startsWith(out.slice(j, j + 5)));
    if (open) {
      start = i;
      break;
    }
  }
  // a tail that is the start of the BEGIN marker itself
  for (let k = Math.min(PEM_BEGIN.length - 1, out.length); k >= 5; k--) {
    if (out.endsWith(PEM_BEGIN.slice(0, k))) {
      start = Math.min(start, out.length - k);
      break;
    }
  }
  // the trailing run of token chars [A-Za-z0-9_-]
  let r = out.length;
  while (r > 0 && isTokenCode(out.charCodeAt(r - 1))) r--;
  if (r < out.length) {
    for (let p = r; p < out.length && p < start; p++) {
      if (p > 0 && isWordCode(out.charCodeAt(p - 1))) continue; // the shapes start at a word boundary
      const rest = out.length - p;
      const hit = TOKEN_PREFIXES.some((pre) =>
        rest >= pre.length ? out.startsWith(pre, p) : rest >= 2 && pre.startsWith(out.slice(p)),
      );
      if (hit) {
        start = p;
        break;
      }
    }
  }
  // Telegram: `\d{8,10}:` then fewer than 35 token chars at the end
  const colon = r - 1;
  if (colon >= 8 && out.charCodeAt(colon) === 58 && out.length - r < TG_SECRET_LEN) {
    let d = colon;
    while (d > 0 && out.charCodeAt(d - 1) >= 48 && out.charCodeAt(d - 1) <= 57) d--;
    const digits = colon - d;
    if (digits >= 8 && digits <= 10 && (d === 0 || !isWordCode(out.charCodeAt(d - 1))))
      start = Math.min(start, d);
  }
  return start;
}

/**
 * The forms a value may take on its way out (W14 hardening): as is, JSON-escaped (event payloads are redacted as
 * JSON text, where a quote, backslash or newline inside a value is escaped), URL-encoded, and base64 / base64url.
 */
export function secretForms(v: string): string[] {
  const b64 = Buffer.from(v, 'utf8').toString('base64');
  const forms = [
    v,
    JSON.stringify(v).slice(1, -1),
    encodeURIComponent(v),
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(v, 'utf8').toString('base64url'),
  ];
  return [...new Set(forms)].filter((f) => f.length >= 4);
}

/** Replace every known secret value (len >= 4) with `[secret:name]` and common token shapes with `[secret]`. */
export function createRedactor(source: {
  knownValues(): Iterable<string>;
  nameOf?(v: string): string | undefined;
}): Redact {
  const formsOf = new Map<string, string[]>();
  const pairsNow = () => {
    const pairs: [string, string][] = [];
    for (const v of source.knownValues()) {
      if (v.length < 4) continue;
      let forms = formsOf.get(v);
      if (!forms) {
        if (formsOf.size > 10_000) formsOf.clear();
        forms = secretForms(v);
        formsOf.set(v, forms);
      }
      const label = `[secret:${source.nameOf?.(v) ?? 'value'}]`;
      for (const f of forms) pairs.push([f, label]);
    }
    return pairs.sort((a, b) => b[0].length - a[0].length);
  };
  const apply = (text: string, pairs: [string, string][]) => {
    let out = text;
    for (const [f, label] of pairs) {
      if (out.includes(f)) out = out.split(f).join(label);
    }
    for (const re of TOKEN_SHAPES) out = out.replace(re, '[secret]');
    return out;
  };
  const redact: Redact = (text) => (text ? apply(text, pairsNow()) : text);
  redact.stream = (text) => {
    if (!text) return text;
    const pairs = pairsNow();
    const out = apply(text, pairs);
    const cut = partialTail(
      out,
      pairs.map(([f]) => f),
    );
    const end = Math.min(out.length - cut, openTokenStart(out));
    return end < out.length ? out.slice(0, end) : out;
  };
  return redact;
}

/** Deep-redact every string inside a JSON-able value. */
export function redactDeep<T>(value: T, redact: Redact): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'function' ? v : redactDeep(v, redact);
    return out as T;
  }
  return value;
}
