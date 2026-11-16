/**
 * Generic Agent Client Protocol adapter (ARCHITECTURE 5.1): drives any CLI that speaks ACP over stdio (JSON-RPC 2.0,
 * one JSON object per line). One process per turn: `initialize` → `session/load` (resume, when the agent offers it)
 * or `session/new` → `session/prompt`, with `session/update` notifications mapped to ProviderEvents and the agent's
 * `session/request_permission` requests bridged to PasaBot approvals. Abort sends `session/cancel`, then kills the
 * whole process group after a grace. Gemini and Grok are thin profiles over this class; the `acp-registry` module
 * registers one instance per installed agent as `acp:<id>`.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  ProviderAdapter,
  ProviderCaps,
  ProviderErrorKind,
  ProviderEvent,
  ProviderId,
  ProviderStatus,
  TurnInput,
} from '@pasabot/core';
import {
  childTreeKiller,
  cliSearchPath,
  detachedGroup,
  findCli,
  mkdirPrivate,
  resolveForSpawn,
  withAttachments,
} from '@pasabot/core';
import { execa } from 'execa';
import { EventQueue, RpcError, StdioRpc } from './rpc.js';

export { EventQueue, RpcError, StdioRpc } from './rpc.js';

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpOptions {
  id: ProviderId;
  displayName: string;
  /** command line that starts the agent in ACP mode, e.g. `['gemini', '--acp']` */
  command: string[];
  /** args that print a version (default `['--version']`); null = only check the binary exists */
  versionArgs?: string[] | null;
  installCmd?: string[];
  /** shown when the agent is installed but its sign-in state cannot be read */
  signInHint?: string;
  /** the sign-in hint as a locale key (W24) */
  signInHintKey?: { key: string; params?: Record<string, string> };
  /** where this CLI reads skills, relative to the workspace */
  skillsSubdir?: string;
  /** the CLI's own state outside the workspace (login, sessions): writable inside the runner sandbox */
  statePaths?: (env: Record<string, string | undefined>) => string[];
  /** env var that points the CLI at a provider account's config dir */
  accountEnv?: string;
  /**
   * The agent's install folder inside `$PASABOT_HOME/modules/<id>/…` (a registry npm agent): readable and runnable,
   * never writable, inside the runner sandbox (CommandWrapper `readable`).
   */
  readPaths?: string[];
  /** cwd for `detect` */
  cwd?: string;
  /** ms between SIGTERM and SIGKILL on abort */
  killGraceMs?: number;
  /** extra env for every spawn (e.g. the registry's PATH for an npm-installed agent) */
  env?: Record<string, string>;
  /**
   * Read-only sign-in check for the Brains page: true/false when it can be told without reading a credential (a
   * login file exists, a key variable is set), 'unknown' otherwise. Never reads or returns a secret's value.
   */
  signedIn?: (env: Record<string, string | undefined>) => boolean | 'unknown';
  /** env variables holding this brain's API key: filled from the vault by the runner (`ProviderAdapter.keyEnv`) */
  keyEnv?: string[];
}

/** what the server passes on to every CLI from its own env (mirrors the runner's scrubbedEnv allowlist) */
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'TZ'];

const clip = (s: unknown, n = 500) => String(s ?? '').slice(0, n);

/**
 * Project config an agent CLI loads from its working directory when it starts (relative to the workspace): permission
 * rules, allowed tools, hooks, MCP servers, extensions and env files that would let calls skip
 * `session/request_permission`, i.e. an "always allow" the server never granted (ARCHITECTURE 7.1). Every known
 * CLI's files count, whichever CLI an ACP profile runs: a registry agent may wrap any of them, and the owner may switch
 * the provider later. Skills folders (`.gemini/skills`, …) are PasaBot's own sync and stay.
 */
export const WORKSPACE_CONFIG = [
  join('.gemini', 'settings.json'),
  join('.gemini', '.env'),
  join('.gemini', 'extensions'),
  join('.grok', 'settings.json'),
  join('.claude', 'settings.json'),
  join('.claude', 'settings.local.json'),
  join('.codex', 'config.toml'),
];

/**
 * Before each turn, moves every {@link WORKSPACE_CONFIG} entry out of the agent's workspace into `.pasabot/set-aside/`
 * (kept for the owner to look at), so a file an earlier turn planted there is never loaded by the next CLI process. A
 * config folder that is a link (`.gemini` → elsewhere) is unlinked, its target left alone, so the CLI cannot be pointed
 * at config outside the workspace either. Throws when it cannot, and the turn is refused.
 */
export function setAsideWorkspaceConfig(workspace: string, entries: string[] = WORKSPACE_CONFIG): string[] {
  const moved: string[] = [];
  for (const dir of new Set(entries.map((e) => e.split(/[\\/]/)[0]!))) {
    const p = join(workspace, dir);
    if (lstatOrNull(p)?.isSymbolicLink()) rmSync(p);
  }
  for (const rel of entries) {
    const p = join(workspace, rel);
    if (!lstatOrNull(p)) continue;
    const dir = join(workspace, '.pasabot', 'set-aside');
    mkdirPrivate(dir);
    const to = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}-${rel.replace(/[\\/]/g, '_')}`);
    renameSync(p, to);
    moved.push(to);
  }
  return moved;
}
const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** Same wrapper-tag defusing as the other adapters (ARCHITECTURE 8): untrusted text cannot open or close a block. */
export function quoteUntrusted(s: string): string {
  return s.replace(/<(?=\s*\/?\s*(?:instructions|earlier-conversation)\b)/gi, '&lt;');
}

/**
 * The prompt text for one turn. ACP has no system-prompt field, so a new session starts with the instructions in an
 * `<instructions>` block (trusted text, PasaBot's own), then the reseed as quoted data, then the user text. A
 * resumed session gets the instructions again on every turn (like the Codex adapter): an edit to the agent's
 * instructions reaches existing chats, and the untrusted-data preamble survives the CLI compressing its own
 * history. The reseed only goes into a new session.
 */
export function composePrompt(input: TurnInput, resumed: boolean): string {
  const text = quoteUntrusted(withAttachments(input.user.text, input.user.attachments));
  const parts: string[] = [];
  if (input.systemPrompt.trim()) parts.push(`<instructions>\n${input.systemPrompt}\n</instructions>`);
  if (input.seed && !resumed) {
    const recent = input.seed.recent.map((m) => `${m.authorKind}: ${quoteUntrusted(m.body)}`).join('\n');
    parts.push(
      `<earlier-conversation>\n${quoteUntrusted(input.seed.summary)}${recent ? `\n\n${recent}` : ''}\n</earlier-conversation>`,
    );
  }
  parts.push(text);
  return parts.join('\n\n');
}

export function classifyError(text: string): ProviderErrorKind {
  const t = text.toLowerCase();
  if (/rate.?limit|usage limit|too many requests|429|resource.?exhausted/.test(t)) return 'rate_limit';
  if (/quota|credits?|billing|insufficient/.test(t)) return 'quota';
  if (/auth|log ?in|api key|unauthori[sz]ed|401|403|oauth|token (has )?expired/.test(t)) return 'auth';
  if (/context (window|length)|too long|maximum context|max.?tokens/.test(t)) return 'context_overflow';
  if (/timed? ?out|timeout/.test(t)) return 'timeout';
  return 'crash';
}

/** "retry in 2 hours" / "in 30s" → ms, when the agent says. */
export function retryAfter(text: string): number | undefined {
  const UNIT = String.raw`(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;
  const span = text.match(new RegExp(String.raw`\bin\s+((?:\d+\s*${UNIT}[\s,]*(?:and\s+)?)+)`, 'i'));
  if (!span) return undefined;
  let ms = 0;
  for (const m of span[1]!.matchAll(new RegExp(String.raw`(\d+)\s*${UNIT}`, 'gi'))) {
    const u = m[2]!.toLowerCase();
    ms +=
      Number(m[1]) *
      (u.startsWith('d') ? 86_400_000 : u.startsWith('h') ? 3_600_000 : u.startsWith('m') ? 60_000 : 1000);
  }
  return ms || undefined;
}

export function errorEvent(msg: string, kind?: ProviderErrorKind): ProviderEvent {
  const k = kind ?? classifyError(msg);
  const ra = k === 'rate_limit' || k === 'quota' ? retryAfter(msg) : undefined;
  return { type: 'error', kind: k, message: msg.slice(0, 500), ...(ra ? { retryAfterMs: ra } : {}) };
}

/** ACP content (a block, a list of tool-call content items, raw output) → a short text summary. */
export function summarize(content: unknown, rawOutput?: unknown): string {
  const parts: string[] = [];
  const one = (c: any) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'content') one(c.content);
    else if (c.type === 'diff') parts.push(`edit ${c.path ?? ''}`);
    else if (c.type === 'terminal') parts.push(`terminal ${c.terminalId ?? ''}`);
    else if (c.type === 'resource_link') parts.push(String(c.uri ?? c.name ?? ''));
  };
  if (Array.isArray(content)) content.forEach(one);
  else one(content);
  if (!parts.length && rawOutput !== undefined)
    parts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));
  return clip(parts.join('\n'));
}

const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
function outsideish(p: string, ws: string): boolean {
  const abs = isAbsolute(p) ? p : resolve(ws, p);
  if (!within(resolve(ws), abs)) return true;
  try {
    return !within(realpathSync(ws), realpathSync(abs));
  } catch {
    return false;
  }
}

/** Name of the gateway MCP server as handed to the agent in `mcpServers`. */
export const GATEWAY_SERVER = 'pasabot';
const GW_TOOL = '[A-Za-z0-9_-]{1,64}';
/**
 * Whole-title forms an ACP CLI uses for a call to an MCP server's tool, matched strictly (anchored, no spaces in
 * the tool name) so a shell command or other agent-written text cannot pass for a gateway call.
 */
const GATEWAY_TITLES = [
  new RegExp(`^mcp__${GATEWAY_SERVER}__(${GW_TOOL})$`),
  new RegExp(`^${GATEWAY_SERVER}(?:__|[./:])(${GW_TOOL})$`),
  new RegExp(`^(${GW_TOOL}) \\(${GATEWAY_SERVER}(?: MCP Server)?\\)$`, 'i'),
];

/**
 * The gateway tool a permission request is for, or null. Only `other`-kind (or kind-less) calls qualify: reads,
 * edits, shell and fetch are the CLI's own tools and keep their own tiering.
 */
export function gatewayTool(toolCall: any): string | null {
  const kind = toolCall?.kind;
  if (kind !== undefined && kind !== null && kind !== 'other') return null;
  const title = typeof toolCall?.title === 'string' ? toolCall.title.trim() : '';
  for (const re of GATEWAY_TITLES) {
    const m = title.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * An ACP permission request → the tool name + input PasaBot's approval tiers understand (ARCHITECTURE 7.1). A call
 * to PasaBot's own gateway MCP server becomes `mcp__pasabot__<tool>` (tiered again by the gateway at tools/call,
 * like the Claude adapter, so it is not gated twice); reads and searches become `Read`, edits/deletes/moves
 * `Write`, with the location most likely to leave the workspace; a write with no location is tiered as outside
 * the workspace (3), a read with no location as an unknown tool (2); shell, fetch and everything else keep an
 * `acp.<kind>` name (2).
 */
export function permissionTool(
  toolCall: any,
  workspace: string,
  /** whether this turn handed the agent the gateway server (else a `pasabot` server is not ours) */
  gatewayOffered = true,
): { tool: string; input: unknown } {
  const gw = gatewayOffered ? gatewayTool(toolCall) : null;
  if (gw) return { tool: `mcp__${GATEWAY_SERVER}__${gw}`, input: toolCall?.rawInput ?? {} };
  const kind = String(toolCall?.kind ?? 'other');
  const locs: string[] = Array.isArray(toolCall?.locations)
    ? toolCall.locations.map((l: any) => l?.path).filter((p: unknown): p is string => typeof p === 'string')
    : [];
  const pick = locs.find((p) => outsideish(p, workspace)) ?? locs[0];
  const base = { title: clip(toolCall?.title, 200), kind, locations: locs, rawInput: toolCall?.rawInput };
  if ((kind === 'read' || kind === 'search') && pick)
    return { tool: 'Read', input: { ...base, file_path: pick } };
  if (kind === 'edit' || kind === 'delete' || kind === 'move')
    return { tool: 'Write', input: pick ? { ...base, file_path: pick } : base };
  return { tool: `acp.${kind}`, input: base };
}

function chooseOption(options: any[], d: 'allow' | 'deny'): string | null {
  const by = (k: string) => options.find((o) => o?.kind === k)?.optionId as string | undefined;
  // a one-time approval never becomes a standing one inside the agent: never `allow_always`
  if (d === 'allow') return by('allow_once') ?? null;
  return by('reject_once') ?? by('reject_always') ?? null;
}

export class AcpProvider implements ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly keyEnv?: readonly string[];
  constructor(readonly o: AcpOptions) {
    this.id = o.id;
    this.displayName = o.displayName;
    if (o.keyEnv?.length) this.keyEnv = o.keyEnv;
  }

  private cmd(): [string, string[]] {
    const [bin, ...pre] = this.o.command;
    return [bin!, pre];
  }

  async detect(): Promise<ProviderStatus> {
    const [bin, pre] = this.cmd();
    const install = this.o.installCmd ? { installCmd: this.o.installCmd } : {};
    let state: boolean | 'unknown' = 'unknown';
    // only what will reach the CLI counts: the server's own env is scrubbed before a turn, so a key variable set
    // there (and not in this adapter's env, nor the vault: see withVaultKeys) would never be seen by the brain
    const cliEnv: Record<string, string | undefined> = {};
    for (const k of PASSED_ENV) if (process.env[k]) cliEnv[k] = process.env[k];
    Object.assign(cliEnv, this.o.env);
    try {
      state = this.o.signedIn?.(cliEnv) ?? 'unknown';
    } catch {
      state = 'unknown';
    }
    // a key only in the server's env: cannot be confirmed (the test tells)
    if (state === false && this.o.keyEnv?.some((k) => process.env[k] && !this.o.env?.[k])) state = 'unknown';
    const signed =
      state === true
        ? { signedIn: true as const }
        : {
            signedIn: state,
            hint: this.o.signInHint ?? 'sign-in is checked on the first turn',
            hintKey: this.o.signInHintKey ?? { key: 'core:provider.hint.checkedFirstTurn' },
          };
    // a launchd/desktop server has a bare PATH: the usual CLI install folders are searched too
    const path = cliSearchPath({ ...process.env, ...this.o.env });
    if (this.o.versionArgs === null) {
      return resolveBin(bin, path)
        ? { installed: true, ...signed }
        : {
            installed: false,
            signedIn: false,
            hint: `${bin} not found`,
            hintKey: { key: 'core:provider.hint.notFound', params: { cli: bin } },
            ...install,
          };
    }
    try {
      // Windows: `gemini.cmd` cannot be started by execFile (CVE-2024-27980); its real program is started instead
      const v = resolveForSpawn(bin, [...pre, ...(this.o.versionArgs ?? ['--version'])], path);
      const r = await new Promise<{ exitCode: number; stdout: string }>((res, rej) => {
        const c = execFile(
          v.cmd,
          v.args,
          {
            windowsHide: true,
            timeout: 15_000,
            ...(this.o.cwd ? { cwd: this.o.cwd } : {}),
            env: { ...(this.o.env ?? process.env), PATH: path },
          },
          (err, stdout) => {
            if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return rej(err);
            res({ exitCode: err ? 1 : 0, stdout: String(stdout) });
          },
        );
        c.stdin?.end();
      });
      if (r.exitCode !== 0)
        return {
          installed: false,
          signedIn: false,
          hint: `${bin} --version failed`,
          hintKey: { key: 'core:provider.hint.versionFailed', params: { cmd: bin } },
          ...install,
        };
      const version = String(r.stdout).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
      return { installed: true, ...(version ? { version } : {}), ...signed };
    } catch {
      return {
        installed: false,
        signedIn: false,
        hint: `${bin} not found on PATH`,
        hintKey: { key: 'core:provider.hint.notOnPath', params: { cli: bin } },
        ...install,
      };
    }
  }

  capabilities(): ProviderCaps {
    return {
      resume: true,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: true,
      subagentEvents: false,
      contextReport: false,
    };
  }

  skillsDir?(workspace: string): string;

  env(input: TurnInput): Record<string, string> {
    const env: Record<string, string> = { ...(this.o.env ?? {}), ...input.env };
    if (this.o.accountEnv && input.account?.configDir && !env[this.o.accountEnv])
      env[this.o.accountEnv] = input.account.configDir;
    return env;
  }

  /** The PasaBot gateway as an ACP MCP server (HTTP with the run bearer as a header; never argv or env). */
  mcpServers(input: TurnInput, agentCaps: any): unknown[] {
    if (input.tools === 'none' || !input.mcp.url) return [];
    if (!agentCaps?.mcpCapabilities?.http) return [];
    return [
      {
        type: 'http',
        name: GATEWAY_SERVER,
        url: input.mcp.url,
        headers: [{ name: 'Authorization', value: `Bearer ${input.mcp.bearer}` }],
      },
    ];
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const [bin, pre] = this.cmd();
    const env = this.env(input);
    let command: { cmd: string; args: string[] };
    try {
      // no project config a turn planted is loaded by this process (7.1); a failure refuses the turn
      setAsideWorkspaceConfig(input.workspaceDir);
      const args = [...pre];
      command = input.sandbox
        ? input.sandbox(bin, args, {
            writable: this.o.statePaths?.(env) ?? [],
            ...(this.o.readPaths?.length ? { readable: this.o.readPaths } : {}),
          })
        : resolveForSpawn(bin, args, env.PATH);
    } catch (e) {
      yield { type: 'error', kind: 'crash', message: clip((e as Error).message) };
      yield { type: 'done', stop: 'error' };
      return;
    }

    const q = new EventQueue<ProviderEvent>();
    let child: ReturnType<typeof execa>;
    try {
      child = execa(command.cmd, command.args, {
        cwd: input.workspaceDir,
        env,
        extendEnv: false,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: detachedGroup(),
        reject: false,
        buffer: { stdout: false, stderr: true },
      });
    } catch (e) {
      yield { type: 'error', kind: 'crash', message: clip((e as Error).message) };
      yield { type: 'done', stop: 'error' };
      return;
    }
    // Windows: one taskkill /T /F and never a second one on a pid that may be reused (see childTreeKiller)
    const killGroup = childTreeKiller(child);
    let killTimer: NodeJS.Timeout | undefined;
    const stopGroup = (graceMs = this.o.killGraceMs ?? 2000) => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), this.o.killGraceMs ?? 2000);
        killTimer.unref?.();
      }, graceMs);
      killTimer.unref?.();
    };
    const exited = (async () => {
      const r = await child;
      return { exitCode: r.exitCode, stderr: String(r.stderr ?? '') };
    })().catch((e) => ({
      exitCode: undefined as number | undefined,
      stderr: String((e as Error)?.message ?? ''),
    }));

    const rpc = new StdioRpc(child.stdin!, child.stdout!);
    let sessionId: string | null = null;
    let aborted = false;
    let loading = false;
    let gatewayOffered = false;
    const openPermissions = new Set<(d: 'allow' | 'deny' | 'cancel') => void>();

    const onAbort = () => {
      aborted = true;
      for (const r of openPermissions) r('cancel');
      if (sessionId) rpc.notify('session/cancel', { sessionId });
      // the agent gets a short moment to answer `cancelled`, then the group goes
      stopGroup(Math.min(this.o.killGraceMs ?? 2000, 500));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let text = '';
    rpc.onNotification = (method, params) => {
      if (method !== 'session/update' || loading) return;
      if (sessionId && params?.sessionId && params.sessionId !== sessionId) return;
      const u = params?.update ?? {};
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content?.type === 'text' && u.content.text) {
            text += u.content.text;
            q.push({ type: 'text.delta', text: String(u.content.text) });
          }
          return;
        case 'agent_thought_chunk':
          if (u.content?.type === 'text' && u.content.text)
            q.push({ type: 'thinking', text: String(u.content.text) });
          return;
        case 'tool_call': {
          const id = String(u.toolCallId ?? '');
          if (!id) return;
          q.push({
            type: 'tool.call',
            id,
            name: clip(u.title || u.kind || 'tool', 120),
            input: u.rawInput ?? { kind: u.kind ?? 'other', locations: u.locations ?? [] },
          });
          if (u.status === 'completed' || u.status === 'failed')
            q.push({
              type: 'tool.result',
              id,
              ok: u.status === 'completed',
              summary: summarize(u.content, u.rawOutput),
            });
          return;
        }
        case 'tool_call_update': {
          if (u.status !== 'completed' && u.status !== 'failed') return;
          q.push({
            type: 'tool.result',
            id: String(u.toolCallId ?? ''),
            ok: u.status === 'completed',
            summary: summarize(u.content, u.rawOutput),
          });
          return;
        }
        default:
          return;
      }
    };
    rpc.onRequest = async (method, params) => {
      if (method !== 'session/request_permission') throw new RpcError(-32601, `method not found: ${method}`); // no fs/terminal capability was offered
      if (aborted) return { outcome: { outcome: 'cancelled' } };
      const options: any[] = Array.isArray(params?.options) ? params.options : [];
      const { tool, input: toolInput } = permissionTool(params?.toolCall, input.workspaceDir, gatewayOffered);
      const d = await new Promise<'allow' | 'deny' | 'cancel'>((res) => {
        let settled = false;
        const once = (v: 'allow' | 'deny' | 'cancel') => {
          if (settled) return;
          settled = true;
          openPermissions.delete(once);
          res(v);
        };
        openPermissions.add(once);
        q.push({
          type: 'permission',
          id: String(params?.toolCall?.toolCallId ?? `perm-${Date.now()}`),
          tool,
          input: toolInput,
          respond: (v) => once(v),
        });
      });
      const optionId = d === 'cancel' ? null : chooseOption(options, d);
      return optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } };
    };

    const drive = async () => {
      try {
        const init = await rpc.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'pasabot', version: '0' },
        });
        const caps = init?.agentCapabilities ?? {};
        const mcpServers = this.mcpServers(input, caps);
        gatewayOffered = mcpServers.length > 0;
        let resumed = false;
        if (input.nativeRef && caps.loadSession) {
          loading = true; // a load replays history as updates: none of it belongs to this turn
          try {
            await rpc.request('session/load', {
              sessionId: input.nativeRef,
              cwd: input.workspaceDir,
              mcpServers,
            });
            sessionId = input.nativeRef;
            resumed = true;
          } catch (e) {
            if (aborted) throw e;
          } finally {
            loading = false;
          }
        }
        if (!sessionId) {
          const s = await rpc.request('session/new', { cwd: input.workspaceDir, mcpServers });
          if (!s?.sessionId) throw new Error('agent returned no session id');
          sessionId = String(s.sessionId);
        }
        q.push({ type: 'session', nativeRef: sessionId });
        if (aborted) {
          rpc.notify('session/cancel', { sessionId });
          q.push({ type: 'done', stop: 'cancelled' });
          return;
        }
        const res = await rpc.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: composePrompt(input, resumed) }],
        });
        const stop = String(res?.stopReason ?? 'end_turn');
        if (stop === 'cancelled' || aborted) {
          q.push({ type: 'done', stop: 'cancelled' });
          return;
        }
        if (stop === 'refusal') {
          if (text) q.push({ type: 'text.final', text });
          q.push(errorEvent('the agent refused this request', 'crash'));
          q.push({ type: 'done', stop: 'error' });
          return;
        }
        q.push({ type: 'text.final', text });
        const u = res?.usage;
        if (u && typeof u === 'object')
          q.push({
            type: 'usage',
            inputTokens: Number(u.inputTokens ?? 0),
            outputTokens: Number(u.outputTokens ?? 0),
            ...(u.cachedReadTokens !== undefined ? { cacheTokens: Number(u.cachedReadTokens) } : {}),
          });
        q.push({ type: 'done', stop: 'end' });
      } catch (e) {
        if (aborted) {
          q.push({ type: 'done', stop: 'cancelled' });
          return;
        }
        let msg = e instanceof RpcError ? e.message : '';
        let kind: ProviderErrorKind | undefined;
        if (e instanceof RpcError && e.code === -32000) kind = 'auth'; // ACP "authentication required"
        if (!msg) {
          stopGroup(0);
          const x = await exited;
          msg = stderrTail(x.stderr) || `${bin} exited with code ${x.exitCode ?? 'unknown'} without a result`;
        }
        q.push(errorEvent(msg, kind));
        q.push({ type: 'done', stop: 'error' });
      } finally {
        q.end();
      }
    };
    void drive();

    try {
      for await (const ev of q) yield ev;
    } finally {
      // one process per turn: the group never outlives it
      signal.removeEventListener('abort', onAbort);
      for (const r of openPermissions) r('cancel');
      rpc.close(new Error('turn over'));
      try {
        child.stdin?.end();
      } catch {
        /* gone */
      }
      killGroup('SIGTERM');
      const t = setTimeout(() => killGroup('SIGKILL'), this.o.killGraceMs ?? 2000);
      t.unref?.();
      await exited;
      clearTimeout(t);
      if (killTimer) clearTimeout(killTimer);
    }
  }
}

/** Last lines of stderr, for an error message when the agent died without a proper answer. */
export const stderrTail = (s: string) => s.trim().split('\n').slice(-5).join('\n');

/** An absolute/relative path that exists, or a bare name found on PATH. */
export function resolveBin(
  bin: string,
  path = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string | null {
  // Windows: PATHEXT order (gemini.exe, then gemini.cmd), never the extensionless sh shim npm also writes
  if (platform === 'win32') return findCli(bin, path, { platform });
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/** An ACP profile with a fixed skills folder (Gemini, Grok, registry agents). */
export function createAcpProvider(o: AcpOptions): AcpProvider {
  const p = new AcpProvider(o);
  if (o.skillsSubdir) {
    const sub = o.skillsSubdir;
    p.skillsDir = (workspace: string) => join(workspace, sub);
  }
  return p;
}
