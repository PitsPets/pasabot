/**
 * The Brains page (SPEC "Simplify" §5): one tile per brain, its state read from the adapter's own read-only detection
 * (installed? version? signed in? reachable?), the commands that fix it, who uses it, and the owner's "Test" (one tiny
 * tool-less prompt through `ProviderRegistry.probe`, never stored). PasaBot never asks for or keeps a brain's password:
 * signing in is always the CLI's own login command; an API key belongs in the vault.
 */
import {
  type ModuleHost,
  type ProviderAdapter,
  type ProviderProbeResult,
  type ProviderStatus,
  withTurnSignIn,
  withVaultKeys,
} from '@pasabot/core';
import { providerDisplayName } from '@pasabot/i18n';
import type { AgentDTO } from '@pasabot/protocol';

export type BrainState = 'ready' | 'needs_sign_in' | 'not_installed' | 'unreachable';
/** what went wrong in a test, in words the page translates */
export type BrainProblem = 'not_installed' | 'auth' | 'limit' | 'offline' | 'model' | 'timeout' | 'crash';

interface CatalogEntry {
  id: string;
  monogram: string;
  /** shell command that installs the CLI (shown with a copy button) */
  install?: string[];
  /** the CLI's own sign-in command (PasaBot never handles the password) */
  signIn?: string[];
  /** the key goes into the vault, under this name */
  vaultKey?: string;
  /** free models: no sign-in to confirm */
  noSignIn?: boolean;
  /** this server has a checksum-verified installer for it (templates' free starter) */
  installer?: 'starter';
  /** a group of runtime providers (`local:*`, `acp:*`) rather than one adapter */
  prefix?: string;
}

/** The brains PasaBot knows, in the page's order. Commands come from each provider package's own detect code. */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'claude',
    monogram: 'Cl',
    install: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
    signIn: ['claude'],
    // the headless sign-in: `claude setup-token`'s token, kept in the vault and handed to the CLI by the runner
    vaultKey: 'CLAUDE_CODE_OAUTH_TOKEN',
  },
  {
    id: 'codex',
    monogram: 'Cx',
    install: ['npm', 'install', '-g', '@openai/codex'],
    signIn: ['codex', 'login'],
  },
  {
    id: 'opencode',
    monogram: 'OC',
    install: ['npm', 'install', '-g', 'opencode-ai'],
    noSignIn: true,
    installer: 'starter',
  },
  {
    id: 'gemini',
    monogram: 'Ge',
    install: ['npm', 'install', '-g', '@google/gemini-cli'],
    signIn: ['gemini'],
  },
  { id: 'grok', monogram: 'Gk', signIn: ['grok'], vaultKey: 'XAI_API_KEY' },
  { id: 'local', monogram: 'LM', prefix: 'local:' },
  { id: 'acp', monogram: 'AC', prefix: 'acp:' },
];

/** product names stay as they are in every language */
const PROPER: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' };

export interface BrainUser {
  id: string;
  name: string;
  role: 'main' | 'backup';
}
export interface Brain {
  /** tile id: a catalog id, or the provider id of a brain outside the catalog (e.g. `fake` on test servers) */
  id: string;
  name: string;
  description: string;
  /** the state in the reader's language (for pages outside this module, e.g. onboarding) */
  stateLabel: string;
  monogram: string;
  state: BrainState;
  /** installed and usable, but sign-in could not be confirmed without a test */
  unconfirmed: boolean;
  /** the last test or turn failed on sign-in and none has worked since: only a test that works clears it */
  failedSignIn: boolean;
  version?: string;
  installCmd?: string[];
  signInCmd?: string[];
  vaultKey?: string;
  installer?: 'starter';
  /** the registered providers this tile stands for (one, or every `local:*` / `acp:*`), first usable first */
  providers: { id: string; name: string; state: BrainState; version?: string }[];
  usedBy: BrainUser[];
}

/** ProviderStatus → the page's state (SPEC §5.1 mapping). */
export function brainState(
  st: ProviderStatus,
  o: { noSignIn?: boolean } = {},
): {
  state: BrainState;
  unconfirmed: boolean;
} {
  // a local model app found here that is not running, or has no model yet: it cannot answer a turn
  if (st.reachable === false || st.notReady) return { state: 'unreachable', unconfirmed: false };
  if (!st.installed) return { state: 'not_installed', unconfirmed: false };
  if (st.signedIn === false) return { state: 'needs_sign_in', unconfirmed: false };
  return { state: 'ready', unconfirmed: st.signedIn === 'unknown' && !o.noSignIn };
}

/** the adapter's detection, the vault's keys, then how a turn really runs (turn-time check + sign-in memory) */
async function detect(
  p: ProviderAdapter,
  keys: ReadonlySet<string>,
  reg: ModuleHost['providers'],
  lost: boolean,
): Promise<ProviderStatus> {
  let st: ProviderStatus;
  try {
    st = withVaultKeys(await p.detect(), p, keys);
  } catch {
    return { installed: false, signedIn: false };
  }
  const turn =
    !lost && st.installed && st.signedIn !== false && reg.turnSignIn ? await reg.turnSignIn(p.id) : 'unknown';
  return withTurnSignIn(st, turn, lost);
}

const RANK: Record<BrainState, number> = { ready: 0, needs_sign_in: 1, unreachable: 2, not_installed: 3 };

/**
 * Every tile, with live detection. `t` translates `provider-ops:` keys in the reader's language. `vaultKeys`: names
 * of the vault's global entries (a brain whose `keyEnv` key is there is signed in; values are never read here).
 */
export async function listBrains(
  app: Pick<ModuleHost, 'providers'>,
  agents: AgentDTO[],
  fallbacks: (agent: AgentDTO) => { providerId: string }[],
  t: (key: string, params?: Record<string, unknown>) => string,
  vaultKeys: ReadonlySet<string> = new Set(),
  /** `brainKeyStamp` per provider: a remembered sign-in failure counts only with the keys it failed with */
  keyStamp: (providerId: string) => Promise<string> = async () => '',
): Promise<Brain[]> {
  const all = app.providers.list();
  const nameOf = (p: ProviderAdapter) =>
    providerDisplayName(p, (k, o) => {
      const v = t(k);
      return v && v !== k ? v : o.defaultValue;
    });
  const live = agents.filter((a) => !a.archivedAt);
  const users = (ids: Set<string>): BrainUser[] => {
    const out: BrainUser[] = [];
    for (const a of live) {
      if (ids.has(a.providerId)) out.push({ id: a.id, name: a.name, role: 'main' });
      else if (fallbacks(a).some((f) => ids.has(f.providerId)))
        out.push({ id: a.id, name: a.name, role: 'backup' });
    }
    return out;
  };
  const tile = async (c: CatalogEntry, members: ProviderAdapter[]): Promise<Brain> => {
    const rows = await Promise.all(
      members.map(async (p) => {
        const lost = app.providers.signInLost?.(p.id, await keyStamp(p.id)) ?? false;
        const st = await detect(p, vaultKeys, app.providers, lost);
        return { p, st, lost, ...brainState(st, c) };
      }),
    );
    rows.sort((a, b) => RANK[a.state] - RANK[b.state]);
    const best = rows[0];
    const st = best?.st;
    const generic = !CATALOG.some((e) => e.id === c.id);
    const key = generic ? null : c.id;
    const name = key ? (PROPER[key] ?? t(`brains.name.${key}`)) : best ? nameOf(best.p) : c.id;
    return {
      id: c.id,
      name,
      description: key ? t(`brains.desc.${key}`) : t('brains.desc.other'),
      stateLabel: t(`brains.state.${st?.notReady ?? best?.state ?? 'not_installed'}`),
      monogram: c.monogram,
      state: best?.state ?? 'not_installed',
      unconfirmed: best?.unconfirmed ?? false,
      failedSignIn: best?.lost ?? false,
      ...(st?.version && !c.prefix ? { version: st.version } : {}),
      ...((st?.installCmd ?? c.install) ? { installCmd: st?.installCmd ?? c.install } : {}),
      ...(c.signIn ? { signInCmd: c.signIn } : {}),
      ...(c.vaultKey ? { vaultKey: c.vaultKey } : {}),
      ...(c.installer ? { installer: c.installer } : {}),
      providers: rows.map((r) => ({
        id: r.p.id,
        name: nameOf(r.p),
        state: r.state,
        ...(r.st.version ? { version: r.st.version } : {}),
      })),
      usedBy: users(new Set(members.map((m) => m.id))),
    };
  };
  const out: Brain[] = [];
  const seen = new Set<string>();
  for (const c of CATALOG) {
    const members = all.filter((p) => (c.prefix ? p.id.startsWith(c.prefix) : p.id === c.id));
    for (const m of members) seen.add(m.id);
    out.push(await tile(c, members));
  }
  // anything else registered (the e2e Fake, a plugin's brain) gets a plain tile at the end
  for (const p of all) {
    if (seen.has(p.id)) continue;
    const letters = p.displayName.replace(/[^A-Za-z0-9]/g, '');
    const mono = `${letters.charAt(0).toUpperCase()}${letters.charAt(1).toLowerCase()}` || '?';
    out.push(await tile({ id: p.id, monogram: mono }, [p]));
  }
  return out;
}

/** The test's one tiny prompt (SPEC §5.3). */
export const TEST_PROMPT = 'Reply with only the word: ready';

/** A provider error, as the problem the page names. Model-not-found has no error kind of its own: read from text. */
export function problemOf(r: Extract<ProviderProbeResult, { ok: false }>): BrainProblem {
  if (r.kind === 'not_installed') return 'not_installed';
  if (r.kind === 'auth') return 'auth';
  if (r.kind === 'rate_limit' || r.kind === 'quota') return 'limit';
  if (r.kind === 'offline') return 'offline';
  if (r.kind === 'timeout') return 'timeout';
  if (
    /model\b[^.]{0,80}\b(not found|not exist|does not exist|unknown|unavailable|not supported)|unknown model|invalid model|no such model/i.test(
      r.message,
    )
  )
    return 'model';
  if (/not (logged|signed) in|log ?in required|unauthori[sz]ed|invalid api key|401/i.test(r.message))
    return 'auth';
  if (/ENOENT|not found on PATH|command not found/i.test(r.message)) return 'not_installed';
  return 'crash';
}

/** In-memory limiter: at most `max` tests per `windowMs` on this server (SPEC: 6 per minute). */
export class TestLimiter {
  private at: number[] = [];
  constructor(
    private readonly max = 6,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  /** ms to wait, or 0 when this test may run (and is counted) */
  take(): number {
    const t = this.now();
    this.at = this.at.filter((x) => x > t - this.windowMs);
    if (this.at.length >= this.max) return this.at[0]! + this.windowMs - t;
    this.at.push(t);
    return 0;
  }
}
