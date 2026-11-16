/**
 * Read-only password-manager backends (ARCHITECTURE 7.3): the Bitwarden CLI (`bw`) and the 1Password CLI (`op`).
 * PasaBot stores only a reference; the value is fetched through the CLI each time the server resolves it. Each CLI
 * is spawned directly (no shell) with a scrubbed environment: a fixed PATH, HOME and the one session variable it
 * needs, whose value lives in the vault. A reference is validated before it reaches argv, so it can never be read
 * as a flag. CLI output never appears in an error message (it may hold the value).
 *
 * The binary is pinned once, at boot (W14 review): never looked up on the server's PATH, resolved to its real
 * path, and refused when that file or any folder above it can be changed by the server's OS user. In host runner
 * mode an agent CLI runs as that same user, so a user-writable `bw`/`op` (e.g. under ~/.local/bin or a Homebrew
 * prefix) could be swapped for a program that keeps the session key it is handed.
 */
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { type VaultBackend, windowsEnv } from '@pasabot/core';

export type BackendState = 'ready' | 'locked' | 'not_installed' | 'unsafe_bin' | 'error';
export interface BackendCheck {
  state: BackendState;
}

export interface CliBackendOptions {
  /**
   * the CLI binary: an absolute path, or a bare name looked up once in CLI_DIRS (never the server's PATH); set by
   * the server's operator, never from the web
   */
  bin: string;
  /** the session variable for the CLI, read from the vault on every call ('' = none) */
  session?: () => Promise<string>;
  timeoutMs?: number;
  /**
   * Skip the "not writable by the server's user" check. Code-level only (tests with stub CLIs they wrote
   * themselves); there is deliberately no environment variable for it.
   */
  allowWritableBin?: boolean;
}

/** Where a bare CLI name is looked up, once, at boot: fixed system folders, never the server's PATH. */
export const CLI_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
/** The PATH a CLI child gets after the pinned binary's own folder. */
const CHILD_PATH = ['/usr/bin', '/bin'];

export type PinProblem = 'not_installed' | 'unsafe_bin';
export interface PinnedCli {
  /** the real path that is spawned, or null when the backend is off */
  path: string | null;
  problem: PinProblem | null;
}

/** Can the server's OS user change this file or folder (write it, or chmod it as its owner)? */
function changeableByUs(p: string): boolean {
  const uid = process.getuid!();
  const st = statSync(p);
  if (st.uid === uid && uid !== 0) return true;
  if (st.mode & 0o002) return true;
  if (st.mode & 0o020) {
    const groups = process.getgroups?.() ?? [process.getgid!()];
    if (groups.includes(st.gid)) return true;
  }
  return false;
}

/**
 * Resolve a CLI once: an absolute path as given, a bare name in CLI_DIRS; then its real path. Refused (`unsafe_bin`)
 * when the file or any folder up to `/` can be changed by the server's user, or when it is a relative path.
 */
export function pinCli(bin: string, o: { allowWritable?: boolean; dirs?: string[] } = {}): PinnedCli {
  const off = (problem: PinProblem): PinnedCli => ({ path: null, problem });
  if (!bin) return off('not_installed');
  let candidates: string[];
  if (isAbsolute(bin)) candidates = [bin];
  else if (bin.includes('/') || bin.includes('\\')) return off('unsafe_bin');
  else if (process.platform === 'win32')
    return off('not_installed'); // Windows: set an absolute path
  else candidates = (o.dirs ?? CLI_DIRS).map((d) => join(d, bin));
  let real: string | null = null;
  for (const c of candidates) {
    try {
      const r = realpathSync(c);
      if (statSync(r).isFile()) {
        real = r;
        break;
      }
    } catch {
      // not there: try the next folder
    }
  }
  if (!real) return off('not_installed');
  if (!o.allowWritable && typeof process.getuid === 'function') {
    try {
      for (let p = real; ; p = dirname(p)) {
        if (changeableByUs(p)) return off('unsafe_bin');
        if (dirname(p) === p) break;
      }
    } catch {
      return off('unsafe_bin');
    }
  }
  return { path: real, problem: null };
}

const MAX_OUT = 1024 * 1024;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: 'not_installed' | 'unsafe_bin' | 'locked' | 'not_found' | 'failed',
  ) {
    super(message);
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const unsafeMessage = (bin: string) =>
  `${bin.split(/[\\/]/).pop()} is turned off: its file or a folder above it can be changed by the server's user`;

/** Off-state error for a backend whose binary was not pinned. */
function pinError(bin: string, problem: PinProblem): CliError {
  return problem === 'unsafe_bin'
    ? new CliError(unsafeMessage(bin), 'unsafe_bin')
    : new CliError(`${bin.split(/[\\/]/).pop()} is not installed`, 'not_installed');
}

/**
 * Runs a pinned CLI (an absolute real path) with argv only (never a shell) and a minimal environment: PATH is the
 * binary's own folder plus /usr/bin:/bin, never the server's PATH.
 */
export function runCli(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (!isAbsolute(bin)) {
      reject(new CliError('the password manager CLI path is not pinned', 'unsafe_bin'));
      return;
    }
    // Windows: SystemRoot, TEMP, APPDATA and the rest a program needs to start (the CLI keeps its login under APPDATA)
    const base: Record<string, string> = { ...windowsEnv() };
    for (const k of ['HOME', 'LANG', 'TMPDIR']) {
      const v = process.env[k];
      if (v) base[k] = v;
    }
    base.PATH =
      process.platform === 'win32'
        ? [dirname(bin), process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '']
            .filter(Boolean)
            .join(';')
        : [dirname(bin), ...CHILD_PATH].join(':');
    const child = spawn(bin, args, {
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let over = false;
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length + c.length > MAX_OUT) over = true;
      else stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 8192) stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new CliError(`${bin.split(/[\\/]/).pop()} is not installed`, 'not_installed')
          : new CliError('could not start the password manager CLI', 'failed'),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (over) reject(new CliError('the password manager CLI answered too much', 'failed'));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const lockedText =
  /locked|not logged in|not (currently )?signed in|unauthenticated|session|no accounts|sign in/i;

/** `<item id>` or `<item id>/<field>`; field = password (default), username, notes, totp or a custom field name. */
export const BITWARDEN_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}(\/[^/\n\r\0]{1,64})?$/;
/** A 1Password secret reference: `op://vault/item/[section/]field`, no spaces or control characters. */
export const ONEPASSWORD_REF = /^op:\/\/[^\s\0/]+(\/[^\s\0/]+){2,3}$/;

export class BitwardenBackend implements VaultBackend {
  readonly id = 'bitwarden';
  /** pinned once, here (boot): the binary is never looked up again */
  readonly pinned: PinnedCli;
  constructor(private readonly o: CliBackendOptions) {
    this.pinned = pinCli(o.bin, { allowWritable: o.allowWritableBin });
  }

  validate(ref: string): boolean {
    return BITWARDEN_REF.test(ref);
  }

  private async run(args: string[]): Promise<CliResult> {
    // checked before the session is read: an unpinned binary never gets near the key
    if (!this.pinned.path) throw pinError(this.o.bin, this.pinned.problem!);
    const session = (await this.o.session?.()) ?? '';
    return runCli(
      this.pinned.path,
      [...args, '--nointeraction'],
      session ? { BW_SESSION: session } : {},
      this.o.timeoutMs,
    );
  }

  async resolve(ref: string): Promise<string> {
    if (!this.validate(ref)) throw new CliError('not a Bitwarden reference', 'not_found');
    const slash = ref.indexOf('/');
    const id = slash < 0 ? ref : ref.slice(0, slash);
    const field = slash < 0 ? 'password' : ref.slice(slash + 1);
    if (field === 'totp') {
      const r = await this.run(['get', 'totp', id]);
      if (r.code !== 0) throw this.fail(r);
      return r.stdout.trim();
    }
    const r = await this.run(['get', 'item', id]);
    if (r.code !== 0) throw this.fail(r);
    let item: {
      login?: { password?: string | null; username?: string | null };
      notes?: string | null;
      fields?: { name?: string; value?: string | null }[];
    };
    try {
      item = JSON.parse(r.stdout);
    } catch {
      throw new CliError('Bitwarden answered something that is not an item', 'failed');
    }
    const value =
      field === 'password'
        ? item.login?.password
        : field === 'username'
          ? item.login?.username
          : field === 'notes'
            ? item.notes
            : item.fields?.find((f) => f.name === field)?.value;
    if (typeof value !== 'string' || !value)
      throw new CliError(`the Bitwarden item has no ${field}`, 'not_found');
    return value;
  }

  private fail(r: CliResult): CliError {
    if (lockedText.test(r.stderr)) return new CliError('Bitwarden is locked: add a session key', 'locked');
    if (/not found/i.test(r.stderr)) return new CliError('no such Bitwarden item', 'not_found');
    return new CliError(`Bitwarden CLI failed (exit ${r.code})`, 'failed');
  }

  async check(): Promise<BackendCheck> {
    try {
      const r = await this.run(['status']);
      if (r.code !== 0) return { state: lockedText.test(r.stderr) ? 'locked' : 'error' };
      const st = (JSON.parse(r.stdout) as { status?: string }).status;
      return { state: st === 'unlocked' ? 'ready' : 'locked' };
    } catch (e) {
      return {
        state:
          e instanceof CliError && (e.code === 'not_installed' || e.code === 'unsafe_bin') ? e.code : 'error',
      };
    }
  }

  async test(): Promise<boolean> {
    return (await this.check()).state === 'ready';
  }
}

export class OnePasswordBackend implements VaultBackend {
  readonly id = '1password';
  /** pinned once, here (boot): the binary is never looked up again */
  readonly pinned: PinnedCli;
  constructor(private readonly o: CliBackendOptions) {
    this.pinned = pinCli(o.bin, { allowWritable: o.allowWritableBin });
  }

  validate(ref: string): boolean {
    return ONEPASSWORD_REF.test(ref);
  }

  private async run(args: string[]): Promise<CliResult> {
    if (!this.pinned.path) throw pinError(this.o.bin, this.pinned.problem!);
    const token = (await this.o.session?.()) ?? '';
    return runCli(this.pinned.path, args, token ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {}, this.o.timeoutMs);
  }

  async resolve(ref: string): Promise<string> {
    if (!this.validate(ref))
      throw new CliError('not a 1Password reference (op://vault/item/field)', 'not_found');
    const r = await this.run(['read', '--no-newline', ref]);
    if (r.code !== 0) {
      if (lockedText.test(r.stderr)) throw new CliError('1Password is not signed in: add a token', 'locked');
      if (/not find|isn't an item|not found/i.test(r.stderr))
        throw new CliError('no such 1Password item or field', 'not_found');
      throw new CliError(`1Password CLI failed (exit ${r.code})`, 'failed');
    }
    if (!r.stdout) throw new CliError('the 1Password field is empty', 'not_found');
    return r.stdout;
  }

  async check(): Promise<BackendCheck> {
    try {
      const r = await this.run(['whoami', '--format', 'json']);
      if (r.code === 0) return { state: 'ready' };
      return { state: lockedText.test(r.stderr) ? 'locked' : 'error' };
    } catch (e) {
      return {
        state:
          e instanceof CliError && (e.code === 'not_installed' || e.code === 'unsafe_bin') ? e.code : 'error',
      };
    }
  }

  async test(): Promise<boolean> {
    return (await this.check()).state === 'ready';
  }
}
