/**
 * Codex adapter: drives `codex exec --json` (one process per turn, prompt on stdin), maps its JSONL events to
 * ProviderEvents, resumes with `codex exec resume <thread id>`, and kills the whole process group on abort
 * (ARCHITECTURE 5.1). Codex has no permission-prompt hook in exec mode, so its own tools are governed by Codex's
 * sandbox mode chosen per trust level (ARCHITECTURE 7.1 b) and by the runner sandbox.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type {
  CommandWrapper,
  ModelHint,
  ModelInfo,
  ProviderAccount,
  ProviderAdapter,
  ProviderCaps,
  ProviderEvent,
  ProviderStatus,
  SenderInfo,
  TurnInput,
} from '@pasabot/core';
import {
  cleanHomeDir,
  cliSearchPath,
  findCli,
  type LoginLink,
  prepareCleanHome,
  withAttachments,
} from '@pasabot/core';
import type { TrustLevel } from '@pasabot/protocol';
import { execa } from 'execa';
import { type CliExit, classifyError, jsonLines, retryAfter, stderrTail } from './cli.js';

export { classifyError, retryAfter } from './cli.js';

/** env var that carries the run bearer to Codex's MCP client (never on the command line) */
export const BEARER_ENV = 'PASABOT_MCP_TOKEN';

export interface CodexOptions {
  /** command line that starts the CLI (default `codex`); tests point it at a recorded-stream replayer */
  command?: string[];
  /** ms between SIGTERM and SIGKILL on abort */
  killGraceMs?: number;
}

const clip = (s: unknown, n = 500) => String(s ?? '').slice(0, n);
// a JSON string is a valid TOML basic string once lone surrogates (TOML cannot hold them) are replaced and DEL
// (which JSON leaves raw, TOML does not allow) is escaped
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const toml = (s: string) => JSON.stringify(s.replace(LONE_SURROGATE, '\uFFFD')).replace(/\x7f/g, '\\u007F');

/**
 * The trust a turn runs at (ARCHITECTURE 7.1, 7.4): the lower of the agent's and the sender's trust, one level lower
 * again when the sender is not the owner. Same rule as `effectiveTrust` in apps/server/src/approvals; Codex has no
 * permission bridge, so this value alone picks what Codex may do on its own.
 */
export function effectiveTrust(agentTrust: TrustLevel, sender: SenderInfo): TrustLevel {
  const order: TrustLevel[] = ['guarded', 'standard', 'trusted'];
  const base = order[Math.min(order.indexOf(agentTrust), Math.max(0, order.indexOf(sender.trust)))]!;
  if (sender.kind === 'owner') return base;
  return base === 'trusted' ? 'standard' : 'guarded';
}

/**
 * Untrusted text (the user message, reseed summary and bodies) must never close or open one of PasaBot's wrapper
 * blocks (ARCHITECTURE 8): a tag-like `<instructions>` or `</earlier-conversation>` inside it is defused.
 */
export function quoteUntrusted(s: string): string {
  return s.replace(/<(?=\s*\/?\s*(?:instructions|earlier-conversation)\b)/gi, '&lt;');
}

/** Map one `codex exec --json` line to zero or more ProviderEvents. Stateful (thread, open items, last message). */
export class CodexMapper {
  threadId: string | null = null;
  gotResult = false;
  resultError = false;
  /** last top-level `error` line: Codex prints one before `turn.failed`, and also for transient retries */
  lastError: string | null = null;
  private lastMessage = '';
  private messages = 0;
  private opened = new Set<string>();

  private call(item: Record<string, any>): ProviderEvent[] {
    if (this.opened.has(item.id)) return [];
    this.opened.add(item.id);
    switch (item.type) {
      case 'command_execution':
        return [{ type: 'tool.call', id: item.id, name: 'shell', input: { command: item.command ?? '' } }];
      case 'mcp_tool_call':
        return [
          {
            type: 'tool.call',
            id: item.id,
            name: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`,
            input: item.arguments ?? {},
          },
        ];
      case 'file_change':
        return [
          { type: 'tool.call', id: item.id, name: 'apply_patch', input: { changes: item.changes ?? [] } },
        ];
      case 'web_search':
        return [{ type: 'tool.call', id: item.id, name: 'web_search', input: { query: item.query ?? '' } }];
      default:
        this.opened.delete(item.id);
        return [];
    }
  }

  private result(item: Record<string, any>): ProviderEvent[] {
    const failed = item.status === 'failed' || item.status === 'declined';
    switch (item.type) {
      case 'command_execution':
        return [
          {
            type: 'tool.result',
            id: item.id,
            ok: !failed && (item.exit_code ?? 0) === 0,
            summary: clip(item.aggregated_output),
          },
        ];
      case 'mcp_tool_call': {
        const content = item.result?.content;
        const text = Array.isArray(content)
          ? content.map((c: any) => (c && typeof c.text === 'string' ? c.text : '')).join('')
          : '';
        return [
          {
            type: 'tool.result',
            id: item.id,
            ok: !failed && !item.error,
            summary: clip(item.error?.message ?? text),
          },
        ];
      }
      case 'file_change':
        return [
          {
            type: 'tool.result',
            id: item.id,
            ok: !failed,
            summary: clip(
              (item.changes ?? []).map((c: any) => `${c.kind ?? 'update'} ${c.path ?? ''}`).join('\n'),
            ),
          },
        ];
      case 'web_search':
        return [{ type: 'tool.result', id: item.id, ok: !failed, summary: clip(item.query) }];
      default:
        return [];
    }
  }

  map(line: Record<string, any>): ProviderEvent[] {
    const item: Record<string, any> = line.item ?? {};
    switch (line.type) {
      case 'thread.started':
        if (line.thread_id && !this.threadId) {
          this.threadId = String(line.thread_id);
          return [{ type: 'session', nativeRef: this.threadId }];
        }
        return [];
      case 'item.started':
        return this.call(item);
      case 'item.completed': {
        if (item.type === 'agent_message') {
          const text = String(item.text ?? '');
          if (!text) return [];
          this.lastMessage = text;
          // exec mode prints whole messages, not tokens: each message is one delta
          return [{ type: 'text.delta', text: this.messages++ ? `\n\n${text}` : text }];
        }
        if (item.type === 'reasoning')
          return item.text ? [{ type: 'thinking', text: String(item.text) }] : [];
        return [...this.call(item), ...this.result(item)];
      }
      case 'turn.completed': {
        this.gotResult = true;
        const u = line.usage ?? {};
        const cached = Number(u.cached_input_tokens ?? 0);
        return [
          { type: 'text.final', text: this.lastMessage },
          {
            type: 'usage',
            // Codex counts cached tokens inside input_tokens; PasaBot keeps them apart (as Claude reports them)
            inputTokens: Math.max(0, Number(u.input_tokens ?? 0) - cached),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheTokens: cached,
          },
        ];
      }
      case 'turn.failed': {
        this.gotResult = true;
        this.resultError = true;
        const msg = String(line.error?.message ?? this.lastError ?? 'turn failed');
        return [errorEvent(msg)];
      }
      case 'error':
        this.lastError = String(line.message ?? 'error');
        return [];
      default:
        return [];
    }
  }
}

export function errorEvent(msg: string): ProviderEvent {
  const kind = classifyError(msg);
  const ra = kind === 'rate_limit' || kind === 'quota' ? retryAfter(msg) : undefined;
  return { type: 'error', kind, message: msg.slice(0, 500), ...(ra ? { retryAfterMs: ra } : {}) };
}

/**
 * The user message for one turn. The instructions never ride in it: they go in Codex's developer instructions on
 * every turn (see `args`). A new session with a reseed gets the earlier conversation ahead of the user text, as
 * quoted data that cannot break out of its block.
 */
export function composePrompt(input: TurnInput): string {
  const text = quoteUntrusted(withAttachments(input.user.text, input.user.attachments));
  if (input.nativeRef || !input.seed) return text;
  const recent = input.seed.recent.map((m) => `${m.authorKind}: ${quoteUntrusted(m.body)}`).join('\n');
  const seed = `${quoteUntrusted(input.seed.summary)}${recent ? `\n\n${recent}` : ''}`;
  return `<earlier-conversation>\n${seed}\n</earlier-conversation>\n\n${text}`;
}

/** A plain word for a catalog entry, from the words of its own description (none when it says nothing clear). */
function codexHint(description: string): ModelHint | undefined {
  const d = description.toLowerCase();
  if (/frontier|most demanding|most capable/.test(d)) return 'smartest';
  if (/fast|affordable|efficient/.test(d)) return 'fast';
  if (/workhorse|everyday|balanced/.test(d)) return 'balanced';
  return undefined;
}

/** `codex debug models` output -> the listed models, best (lowest priority number) first (exported for tests). */
export function parseCodexModels(stdout: string): ModelInfo[] {
  let j: { models?: unknown };
  try {
    j = JSON.parse(stdout) as { models?: unknown };
  } catch {
    throw new Error('codex debug models: not JSON');
  }
  if (!Array.isArray(j.models)) throw new Error('codex debug models: no models');
  type Entry = {
    slug?: unknown;
    display_name?: unknown;
    description?: unknown;
    visibility?: unknown;
    priority?: unknown;
  };
  return (j.models as Entry[])
    .filter((m) => typeof m.slug === 'string' && m.slug && m.visibility === 'list')
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
    .slice(0, 50)
    .map((m) => {
      const hint = codexHint(String(m.description ?? ''));
      const label = typeof m.display_name === 'string' && m.display_name ? m.display_name : undefined;
      return { id: String(m.slug), ...(label ? { label } : {}), ...(hint ? { hint } : {}) };
    });
}

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  constructor(private readonly o: CodexOptions = {}) {}

  private cmd(): [string, string[]] {
    const [bin, ...pre] = this.o.command ?? ['codex'];
    return [bin!, pre];
  }

  /**
   * Installed? (`--version`, found on the CLI search path.) Signed in? (`codex login status`, read-only: only its exit
   * code is used.) With an account, its own CODEX_HOME is checked.
   */
  async detect(acct?: ProviderAccount): Promise<ProviderStatus> {
    const [cmd, pre] = this.cmd();
    const path = cliSearchPath();
    const bin = findCli(cmd, path);
    const env = { ...process.env, PATH: path, ...(acct?.configDir ? { CODEX_HOME: acct.configDir } : {}) };
    try {
      if (!bin) throw new Error('not found');
      const r = await execa(bin, [...pre, '--version'], {
        timeout: 15_000,
        reject: false,
        stdin: 'ignore',
        env,
      });
      if (r.exitCode !== 0)
        return {
          installed: false,
          signedIn: false,
          hint: 'codex --version failed',
          hintKey: { key: 'core:provider.hint.versionFailed', params: { cmd: 'codex' } },
          installCmd: INSTALL,
        };
      const version = String(r.stdout).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
      const login = await execa(bin, [...pre, 'login', 'status'], {
        timeout: 15_000,
        reject: false,
        stdin: 'ignore',
        env,
      });
      const signedIn = login.exitCode === 0 ? true : login.exitCode === undefined ? 'unknown' : false;
      return {
        installed: true,
        ...(version ? { version } : {}),
        signedIn,
        ...(signedIn === true
          ? {}
          : {
              hint: 'run `codex login` once to sign in',
              hintKey: { key: 'core:provider.hint.runToSignIn', params: { cmd: 'codex login' } },
            }),
      };
    } catch {
      return {
        installed: false,
        signedIn: false,
        hint: 'Codex CLI not found on PATH',
        hintKey: { key: 'core:provider.hint.notOnPath', params: { cli: 'Codex CLI' } },
        installCmd: INSTALL,
      };
    }
  }

  /**
   * Signed in the way a turn runs: `codex login status` on the turn's clean CODEX_HOME (holding only the link to the
   * user's `auth.json`), with the turn's env, inside the same sandbox when there is one. `detect` reads the user's
   * own ~/.codex, which can keep its login where a turn cannot reach it (the OS keyring, another config): this is
   * where "logged in" there turns into "signed out" for a turn. Cheap: one local command, no model call.
   */
  async turnSignIn(ctx: {
    env: Record<string, string>;
    sandbox?: CommandWrapper;
    hasKey: boolean;
    cwd: string;
  }): Promise<boolean | 'unknown'> {
    try {
      const { CODEX_HOME: _user, ...rest } = ctx.env;
      const env: Record<string, string> = { ...rest, CODEX_HOME: cleanHomeDir(ctx.cwd, 'codex') };
      const login = codexLoginLink(ctx.env);
      prepareCleanHome(env.CODEX_HOME!, [login]);
      const [bin, pre] = this.cmd();
      const args = [...pre, 'login', 'status'];
      const c = ctx.sandbox
        ? ctx.sandbox(bin, args, { writable: codexTurnWritable(env, ctx.cwd, login) })
        : { cmd: bin, args };
      const r = await execa(c.cmd, c.args, {
        cwd: ctx.cwd,
        env,
        extendEnv: false,
        timeout: 15_000,
        reject: false,
        stdin: 'ignore',
      });
      return r.exitCode === 0 ? true : r.exitCode === undefined ? 'unknown' : false;
    } catch {
      return 'unknown';
    }
  }

  capabilities(): ProviderCaps {
    return {
      resume: true,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: false,
      contextReport: false,
    };
  }

  /**
   * The CLI's own catalog: `codex debug models` prints `{ models: [{ slug, display_name, description, visibility,
   * priority }] }` (checked on codex-cli 0.167). Only `visibility: "list"` models are offered, by priority. Throws
   * when the CLI could not answer.
   */
  async listModels(acct?: ProviderAccount): Promise<ModelInfo[]> {
    const [cmd, pre] = this.cmd();
    const path = cliSearchPath();
    const bin = findCli(cmd, path);
    if (!bin) throw new Error('codex not found');
    const r = await execa(bin, [...pre, 'debug', 'models'], {
      timeout: 30_000,
      reject: false,
      stdin: 'ignore',
      env: { ...process.env, PATH: path, ...(acct?.configDir ? { CODEX_HOME: acct.configDir } : {}) },
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.exitCode !== 0) throw new Error(`codex debug models failed: ${stderrTail(String(r.stderr ?? ''))}`);
    return parseCodexModels(String(r.stdout));
  }

  skillsDir(workspace: string) {
    return join(workspace, '.codex', 'skills');
  }

  /**
   * CLI arguments for one turn (exported for tests). The turn's effective trust (agent and sender, 7.4) → Codex's
   * own sandbox: the workspace is writable at every level (tier 1 is automatic), the network only for `trusted`
   * (tier 2 cannot be asked without a bridge), never full access (tier 3 always asks). A non-owner turn is never
   * `trusted`. Documented exception: on macOS under an outer runner sandbox Codex cannot start its own (Seatbelt
   * does not nest), so for a `trusted` owner turn there the runner sandbox is the only boundary and Codex's
   * workspace-only write limit is lost. Every other platform and level keeps Codex's sandbox.
   * The instructions go in as developer instructions on every turn, resumed ones included.
   */
  args(input: TurnInput, o: { outerSandbox: boolean; platform?: NodeJS.Platform }): string[] {
    const toolless = input.tools === 'none';
    const trusted = !toolless && effectiveTrust(input.agent.trustLevel, input.user.from) === 'trusted';
    const bypass = trusted && o.outerSandbox && (o.platform ?? process.platform) === 'darwin';
    const sandbox = bypass
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', toolless ? 'read-only' : 'workspace-write'];
    const mcp =
      !toolless && input.mcp.url
        ? [
            '-c',
            `mcp_servers.pasabot.url=${toml(input.mcp.url)}`,
            '-c',
            `mcp_servers.pasabot.bearer_token_env_var=${toml(BEARER_ENV)}`,
          ]
        : [];
    return [
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      // the owner's own ~/.codex/config.toml (personal MCP servers, profiles) must not leak into an agent; the turn
      // runs on a clean CODEX_HOME anyway (`env`), and nothing there or in the workspace may add execpolicy rules,
      // hooks, plugins, or the ChatGPT account's own connectors (apps) behind PasaBot's back
      '--ignore-user-config',
      '--ignore-rules',
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      ...sandbox,
      '-c',
      'approval_policy="never"',
      '-c',
      `sandbox_workspace_write.network_access=${trusted}`,
      '-c',
      `shell_environment_policy.exclude=[${toml(BEARER_ENV)}]`,
      ...(input.systemPrompt.trim() ? ['-c', `developer_instructions=${toml(input.systemPrompt)}`] : []),
      ...mcp,
      ...(input.model ? ['--model', input.model] : []),
      ...(input.nativeRef ? ['resume', input.nativeRef] : []),
      '-', // prompt on stdin
    ];
  }

  /**
   * The CLI's env. Clean agents: without a provider account, CODEX_HOME is PasaBot's own folder in the agent's
   * workspace (never `~/.codex`, so the user's AGENTS.md, memories, rules, skills, prompts, hooks, plugins and MCP
   * servers never reach an agent), holding only a link to the user's `auth.json` (`codexLoginLink`).
   */
  env(input: TurnInput): Record<string, string> {
    const { CODEX_HOME: _user, ...rest } = input.env;
    const env: Record<string, string> = { ...rest };
    env.CODEX_HOME = input.account?.configDir || cleanHomeDir(input.workspaceDir, 'codex');
    if (input.tools !== 'none' && input.mcp.url) env[BEARER_ENV] = input.mcp.bearer;
    return env;
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const [bin, pre] = this.cmd();
    const env = this.env(input);
    let command: { cmd: string; args: string[] };
    try {
      const args = [...pre, ...this.args(input, { outerSandbox: !!input.sandbox })];
      const login = input.account?.configDir ? null : codexLoginLink(input.env);
      if (login) prepareCleanHome(env.CODEX_HOME!, [login]);
      command = input.sandbox
        ? input.sandbox(bin, args, { writable: codexTurnWritable(env, input.workspaceDir, login) })
        : { cmd: bin, args };
    } catch (e) {
      yield { type: 'error', kind: 'crash', message: (e as Error).message };
      yield { type: 'done', stop: 'error' };
      return;
    }

    const exit: CliExit = { exitCode: undefined, stderr: '', aborted: false };
    const mapper = new CodexMapper();
    try {
      for await (const line of jsonLines(
        {
          cmd: command.cmd,
          args: command.args,
          cwd: input.workspaceDir,
          env,
          stdin: composePrompt(input),
          killGraceMs: this.o.killGraceMs,
        },
        signal,
        exit,
      )) {
        for (const ev of mapper.map(line)) yield ev;
      }
    } catch (e) {
      // spawn failure (missing binary, bad cwd): reported, never thrown
      if (!exit.aborted) {
        yield { type: 'error', kind: 'crash', message: clip((e as Error).message) };
        yield { type: 'done', stop: 'error' };
        return;
      }
    }
    if (exit.aborted) {
      yield { type: 'done', stop: 'cancelled' };
      return;
    }
    if (!mapper.gotResult) {
      const msg =
        mapper.lastError ||
        stderrTail(exit.stderr) ||
        `codex exited with code ${exit.exitCode ?? 'unknown'} without a result`;
      yield errorEvent(msg);
      yield { type: 'done', stop: 'error' };
      return;
    }
    yield { type: 'done', stop: mapper.resultError ? 'error' : 'end' };
  }
}

const INSTALL = ['npm', 'install', '-g', '@openai/codex'];

export default new CodexProvider();

/** Features switched off on every turn: each would bring something PasaBot did not grant (see `args`). */
export const CODEX_DISABLED_FEATURES = ['hooks', 'apps', 'plugins', 'remote_plugin'];

/** The user's own Codex login (`codex login`), linked (never copied) into a clean CODEX_HOME. */
export function codexLoginLink(env: Record<string, string | undefined>): LoginLink {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  return { name: 'auth.json', target: join(home, 'auth.json') };
}

/** What a turn's CLI may write outside its workspace: an account's CODEX_HOME, or the linked login (refreshed). */
export function codexTurnWritable(
  env: Record<string, string | undefined>,
  workspace: string,
  login: LoginLink | null,
): string[] {
  const ws = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`;
  const out = codexStatePaths(env).filter((p) => !`${p}${sep}`.startsWith(ws));
  if (login && existsSync(login.target)) out.push(login.target);
  return out;
}

/** Codex's own state (login, sessions for resume): it must stay writable inside the sandbox. */
export function codexStatePaths(env: Record<string, string | undefined>): string[] {
  if (env.CODEX_HOME) return [env.CODEX_HOME];
  return [join(env.HOME || homedir(), '.codex')];
}
