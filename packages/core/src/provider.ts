/** ProviderAdapter and friends (ARCHITECTURE.md 5.1). */
import {
  type AgentDTO,
  type MessageDTO,
  minTrust,
  TRUST_ORDER,
  type TrustLevel,
  type UsageSnapshot,
} from '@pasabot/protocol';
import { z } from 'zod';

/**
 * W33: data a module adds to a turn's prompt (ModuleHost.prompt). The server renders every block as quoted,
 * labelled untrusted data (`renderUntrustedBlocks`): a module never writes prompt text of its own (ARCHITECTURE 7.4).
 */
export interface UntrustedBlock {
  /** id of the module that produced it, e.g. "memory" */
  source: string;
  /** short heading, e.g. "Saved memory" */
  label: string;
  items: { text: string; meta?: Record<string, string> }[];
}

export type ProviderId =
  | 'fake'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'opencode'
  | `acp:${string}`
  /** an owner-configured local model endpoint (W34): `local:<endpoint id>` */
  | `local:${string}`;

export interface ProviderAccount {
  id: string;
  providerId: ProviderId;
  label: string;
  configDir: string;
}
/** A plain word the app's model picker shows next to a model (translated there, `models.hint.<value>`). */
export type ModelHint = 'fast' | 'balanced' | 'smart' | 'smartest' | 'free';
export const MODEL_HINTS: readonly ModelHint[] = ['fast', 'balanced', 'smart', 'smartest', 'free'];
export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  /** a one-word plain description for the model picker */
  hint?: ModelHint;
  /** the adapter's pick for a first-timer: a new agent on this brain starts with it ticked */
  recommended?: boolean;
  /**
   * From the adapter's short fallback list because the CLI has no model-listing command. Every curated name was
   * checked against the CLI's own help on the day it was added; the app says the list may be incomplete.
   */
  curated?: boolean;
}
/** Opaque resume handle the CLI gave us (its own session id, file path, ...). */
export type NativeSessionRef = string;
/**
 * A file attached to the turn, already copied into the agent's workspace
 * (`<workspace>/.pasabot/files/<runId>/<name>`), so the CLI can read it inside its sandbox.
 */
export interface LocalFile {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * The user text plus a list of the turn's files, for adapters whose CLI takes one prompt string. The names come from
 * the sender, so every field is shown as a JSON string with control characters removed: a name can never start a new
 * line of the prompt, whether or not the adapter also quotes the whole text.
 */
export function withAttachments(text: string, files: readonly LocalFile[]): string {
  if (!files.length) return text;
  const field = (v: string) => JSON.stringify(stripControl(v));
  const list = files
    .map(
      (f) =>
        `- ${field(f.path)} (name ${field(f.name)}, type ${field(f.mime)}, ${Math.max(0, Math.trunc(Number(f.size) || 0))} bytes)`,
    )
    .join('\n');
  return `${text}\n\nAttached files, saved in your workspace:\n${list}`;
}
/** Removes C0/C1 control characters and Unicode line/paragraph separators (sender-supplied labels). */
export function stripControl(v: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}
export interface SenderInfo {
  /**
   * `automation` = a run started with an automation token (trust ≤ standard, never auto-approves tier 2+).
   * `link` = a turn a linked PasaBot machine asked for (ARCHITECTURE 11.3): never an owner, trust ≤ standard.
   */
  kind: 'owner' | 'member' | 'guest' | 'agent' | 'external' | 'webhook' | 'system' | 'automation' | 'link';
  id: string | null;
  name: string;
  trust: TrustLevel;
}
/**
 * The trust a turn runs at (7.4): the lower of the agent's and the sender's, and one level lower again for every
 * sender but the owner (never below `guarded`). Approvals (7.1) and per-role MCP levels key on it, never on the
 * agent's static trust alone.
 */
export function effectiveTrust(
  agentTrust: TrustLevel,
  sender: Pick<SenderInfo, 'kind' | 'trust'>,
): TrustLevel {
  const base = minTrust(agentTrust, sender.trust);
  if (sender.kind === 'owner') return base;
  return TRUST_ORDER[Math.max(0, TRUST_ORDER.indexOf(base) - 1)]!;
}
export interface TurnContext {
  agent: AgentDTO;
  workspaceDir: string;
  account?: ProviderAccount;
  env: Record<string, string>;
}

export interface ProviderStatus {
  installed: boolean;
  version?: string;
  signedIn: boolean | 'unknown';
  /** English, for logs and the CLI */
  hint?: string;
  /** W24: the hint as a locale key + params (`core:provider.hint.*`): the app shows it in its own language */
  hintKey?: { key: string; params?: Record<string, string> };
  installCmd?: string[];
  /**
   * `false`: the brain is set up but its endpoint does not answer right now (e.g. a local model server that is not
   * running). Pickers then say "not reachable", never "not installed". Absent means the adapter does not say.
   */
  reachable?: boolean;
  /**
   * A local model app found on this computer that cannot answer a turn yet: `not_running` (installed, its local API
   * does not answer) or `needs_model` (it answers, with no model downloaded). Pages say so in plain words.
   */
  notReady?: 'not_running' | 'needs_model';
}

export interface ProviderCaps {
  resume: boolean;
  images: boolean;
  mcp: boolean;
  nativeCompaction: boolean;
  /** CLI can ask us before tool use (e.g. a permission-prompt MCP tool). */
  permissionBridge: boolean;
  subagentEvents: boolean;
  contextReport: boolean;
}

export interface TurnInput {
  runId: string;
  agent: AgentDTO;
  account?: ProviderAccount;
  /** cwd; the only writable dir in guarded mode */
  workspaceDir: string;
  /** resume; absent = new session */
  nativeRef?: NativeSessionRef;
  /** used on provider switch / compaction-by-reseed */
  seed?: { summary: string; recent: MessageDTO[] };
  /** agent instructions + PasaBot preamble (+ the rendered `context` blocks, already included here) */
  systemPrompt: string;
  /**
   * W33: the modules' untrusted data blocks for this turn, already rendered into `systemPrompt` as quoted data.
   * A structured copy for tests and adapters with a native slot; an adapter must not render them a second time.
   */
  context?: UntrustedBlock[];
  user: { text: string; attachments: LocalFile[]; from: SenderInfo };
  /** PasaBot MCP gateway for this run */
  mcp: { url: string; bearer: string };
  /** 'none' = tool-less model call (workflow model step, summaries) */
  tools: 'none' | 'gateway';
  model?: string;
  /** already scrubbed; secrets only by explicit grant */
  env: Record<string, string>;
  /**
   * Runner sandbox (ARCHITECTURE 7.2): adapters pass every CLI command through this before spawning it.
   * Absent = no wrapping (tests, `host-unsandboxed`). May throw when the runner mode cannot run here.
   */
  sandbox?: CommandWrapper;
}

/**
 * Wraps a command line in the runner's OS sandbox (sandbox-exec, bubblewrap, ...). `writable` names paths outside
 * the workspace the CLI must be able to write (its own state folder, e.g. `~/.claude`); existing ones are made
 * writable inside the sandbox. The wrapper throws for a path inside a protected tree ($PASABOT_HOME, ~/.ssh, ...).
 * `readable` names install folders below a module's data dir (`$PASABOT_HOME/modules/<id>/<sub>/...`, e.g. a
 * registry-installed ACP agent) the CLI may read and execute but never write; any other path makes it throw.
 * Every keychain file stays denied: a CLI whose login lives in the keychain gets it from the server, outside.
 */
export type CommandWrapper = (
  cmd: string,
  args: string[],
  opts?: { writable?: string[]; readable?: string[] },
) => { cmd: string; args: string[] };

/** `offline` = the provider could not be reached at all (connection refused, no route); W34's offline fallback */
export type ProviderErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'context_overflow'
  | 'crash'
  | 'timeout'
  | 'offline';
/**
 * Network-unreachable markers (W34): what Node, curl-style tools and the provider CLIs print when they could not reach
 * their service at all (no DNS, no route, refused, connect timed out). Plain substrings, no regex: the text is a
 * provider's own error output and may be long.
 */
const UNREACHABLE_MARKERS = [
  'enotfound',
  'eai_again',
  'econnrefused',
  'etimedout',
  'enetunreach',
  'ehostunreach',
  'ehostdown',
  'enetdown',
  'getaddrinfo',
  'fetch failed',
  'connection refused',
  'connection error',
  'network error',
  'network is unreachable',
  'no route to host',
  'could not resolve host',
  'unable to connect',
  'failed to connect',
];
/**
 * Does a provider's `crash`/`timeout` error text say the service could not be reached at all? The orchestrator reads
 * such an error as `offline` when the turn had not done anything yet (no text, no tool use), so a cloud primary that
 * lost the network takes the offline path (fallback for "run even offline" items, else held), like a local endpoint.
 */
export function looksUnreachable(text: string): boolean {
  const t = text.slice(0, 4000).toLowerCase();
  return UNREACHABLE_MARKERS.some((m) => t.includes(m));
}

/**
 * Is a whole reply a CLI's own "you are signed out" line rather than an answer (e.g. the Claude CLI's
 * "Not logged in · Please run /login", which it sends as an assistant message)? Only a short reply that starts with
 * such a phrase counts, so an agent talking about logging in somewhere is never mistaken for one. The brain test and
 * the runner read such a reply as an `auth` error (Needs sign-in), never as a working answer.
 */
export function looksSignedOut(reply: string): boolean {
  const t = reply.trim();
  if (!t || t.length > 200) return false;
  return /^(error:\s*)?(you are |you're |you have )?(not (logged|signed) in|logged out|please (run )?\/?log ?in|(log|sign) ?in required|authentication (failed|required)|invalid api key|missing api key|unauthori[sz]ed)\b/i.test(
    t,
  );
}

export type ProviderEvent =
  | { type: 'session'; nativeRef: NativeSessionRef }
  | { type: 'text.delta'; text: string }
  | { type: 'text.final'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown; parentId?: string }
  | { type: 'tool.result'; id: string; ok: boolean; summary: string }
  | { type: 'subagent'; id: string; parentId?: string; name: string; state: 'start' | 'end' }
  | { type: 'permission'; id: string; tool: string; input: unknown; respond(d: 'allow' | 'deny'): void }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheTokens?: number;
      contextUsed?: number;
      contextWindow?: number;
    }
  | { type: 'error'; kind: ProviderErrorKind; message: string; retryAfterMs?: number }
  | { type: 'done'; stop: 'end' | 'cancelled' | 'error' };
export type ProviderErrorEvent = Extract<ProviderEvent, { type: 'error' }>;

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  /** W24: a locale key for a name that is not a product name (the test provider); the app shows it translated */
  readonly displayNameKey?: string;
  /**
   * Environment variables that hold this brain's API key (e.g. `['XAI_API_KEY']`). The runner fills each one from
   * the vault when an entry of that name exists (the agent's own scope first, then `global`) and hands it to the CLI
   * in the turn's env; detection counts a vault entry of that name as signed in (`withVaultKeys`). The server's own
   * process env never reaches the CLI (scrubbedEnv), so a key exported there does not count.
   */
  readonly keyEnv?: readonly string[];
  /** installed? version? signed in? */
  detect(acct?: ProviderAccount): Promise<ProviderStatus>;
  /**
   * Signed in the way a turn really runs, when that is cheap to check: `detect` runs outside the sandbox with the
   * server's own env and can see a login a turn cannot (a keychain item the sandbox denies, a wrapper script's env).
   * `env` is the turn's scrubbed env without key values, `sandbox` the runner's wrapper (absent when turns run
   * unsandboxed), `hasKey` whether the vault holds one of `keyEnv` for this brain. 'unknown' = no cheap answer.
   */
  turnSignIn?(ctx: {
    env: Record<string, string>;
    sandbox?: CommandWrapper;
    hasKey: boolean;
    cwd: string;
  }): Promise<boolean | 'unknown'>;
  capabilities(): ProviderCaps;
  /**
   * The models this brain offers right now, best first, from the provider itself (its CLI's model-listing command,
   * a local endpoint's model API) or, only when the CLI cannot list, a short curated list marked `curated`. Throws
   * when the provider could not be asked (the app shows "could not load models"); [] = it lists none.
   */
  listModels?(acct?: ProviderAccount): Promise<ModelInfo[]>;
  /** where this CLI reads skills (W12 syncs into it) */
  skillsDir?(workspace: string): string;
  /** inject into the running turn; false = not possible */
  steer?(runId: string, text: string): Promise<boolean>;
  /** Must emit exactly one `done`, as the last event. */
  runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /** native compaction if the CLI has it */
  compact?(ref: NativeSessionRef, ctx: TurnContext): Promise<NativeSessionRef>;
}

/** Orchestrator hooks; W0 exposes `providers.setPolicy()`, W3 installs its policy. */
export interface ProviderPolicy {
  choose(
    agent: AgentDTO,
    lastError?: ProviderErrorEvent,
  ): { providerId: ProviderId; model?: string; accountId?: string } | null;
  /**
   * Called after every finished tool turn that reported its context use. `session` names the chat and the session
   * scope (5.1) the turn ran in, so per-session bookkeeping (what the last compaction freed) stays in that session.
   */
  shouldCompact(
    agent: AgentDTO,
    usage: UsageSnapshot,
    session?: { chatId: string | null; scope: string },
  ): 'native' | 'reseed' | false;
  /**
   * For reseed / provider switch. `only` = the messages the summary covers, oldest first, already redacted: the
   * reseeded scope's own older turns (5.1/7.4); a policy never adds others. Absent = any message of the chat.
   */
  summarize(chatId: string, upto: string, only?: readonly MessageDTO[]): Promise<string>;
  /**
   * The provider account behind an `accountId` that `choose` returned (its own CLI config dir); undefined = the
   * CLI's default account. Optional: a policy without accounts never returns an `accountId`.
   */
  account?(accountId: string): ProviderAccount | undefined;
  /**
   * When work held by a usage limit with no fallback left may run again (epoch ms): the earliest moment the policy
   * itself will let the agent's chain run. Optional; the orchestrator holds 15 min when neither this nor the CLI says.
   */
  resumeAt?(agent: AgentDTO): number | undefined;
}

// Runtime schemas used by the contract suite to check every event an adapter emits.
export const providerStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  signedIn: z.union([z.boolean(), z.literal('unknown')]),
  hint: z.string().optional(),
  /** W24: the hint as a locale key + params, so the app shows it in its own language (`hint` is the English) */
  hintKey: z.object({ key: z.string(), params: z.record(z.string(), z.string()).optional() }).optional(),
  installCmd: z.array(z.string()).optional(),
});
export const providerCapsSchema = z.object({
  resume: z.boolean(),
  images: z.boolean(),
  mcp: z.boolean(),
  nativeCompaction: z.boolean(),
  permissionBridge: z.boolean(),
  subagentEvents: z.boolean(),
  contextReport: z.boolean(),
});
export const providerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), nativeRef: z.string().min(1) }),
  z.object({ type: z.literal('text.delta'), text: z.string() }),
  z.object({ type: z.literal('text.final'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentId: z.string().optional(),
  }),
  z.object({ type: z.literal('tool.result'), id: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({
    type: z.literal('subagent'),
    id: z.string(),
    parentId: z.string().optional(),
    name: z.string(),
    state: z.enum(['start', 'end']),
  }),
  z.object({
    type: z.literal('permission'),
    id: z.string(),
    tool: z.string(),
    input: z.unknown(),
    respond: z.custom<(d: 'allow' | 'deny') => void>((v) => typeof v === 'function'),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheTokens: z.number().optional(),
    contextUsed: z.number().optional(),
    contextWindow: z.number().optional(),
  }),
  z.object({
    type: z.literal('error'),
    kind: z.enum(['rate_limit', 'quota', 'auth', 'context_overflow', 'crash', 'timeout', 'offline']),
    message: z.string(),
    retryAfterMs: z.number().optional(),
  }),
  z.object({ type: z.literal('done'), stop: z.enum(['end', 'cancelled', 'error']) }),
]);
