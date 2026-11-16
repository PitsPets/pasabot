/**
 * Claude Code adapter: drives the `claude` CLI in print mode with stream-json in and out, maps its stream to
 * ProviderEvents, keeps stdin open for steering, routes the CLI's own tool permissions to PasaBot through the
 * `/mcp` permission-prompt tool, and kills the whole process group on abort (ARCHITECTURE 5.1).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import type {
  CommandWrapper,
  ModelInfo,
  ProviderAccount,
  ProviderAdapter,
  ProviderCaps,
  ProviderErrorKind,
  ProviderEvent,
  ProviderStatus,
  TurnInput,
} from '@pasabot/core';
import {
  childTreeKiller,
  cleanHomeDir,
  cliSearchPath,
  detachedGroup,
  findCli,
  mkdirPrivate,
  prepareCleanHome,
  resolveForSpawn,
  withAttachments,
} from '@pasabot/core';
import { execa } from 'execa';

export const PERMISSION_TOOL_FQN = 'mcp__pasabot__core_permission_prompt';

/** Settings PasaBot passes on every turn (`--settings`): deny always wins over any allow rule the CLI finds. */
export const LOCKED_SETTINGS = JSON.stringify({ permissions: { deny: ['Edit(./.claude/**)'] } });

/** The project settings files the CLI reads from its working directory (relative to the workspace). */
export const WORKSPACE_SETTINGS = [join('.claude', 'settings.json'), join('.claude', 'settings.local.json')];

/**
 * Before each turn, moves any CLI settings file out of the agent's workspace (into `.pasabot/set-aside/`, kept for the
 * owner to look at): its permission rules and hooks would let calls skip the permission prompt, i.e. an "always allow"
 * the server never granted (ARCHITECTURE 7.1). A `.claude` that is a link is unlinked (its target is left alone), so
 * the CLI cannot be pointed at settings outside the workspace either. Throws when it cannot, and the turn is refused.
 */
export function setAsideWorkspaceSettings(workspace: string): string[] {
  const moved: string[] = [];
  const cfg = join(workspace, '.claude');
  if (lstatOrNull(cfg)?.isSymbolicLink()) rmSync(cfg);
  for (const rel of WORKSPACE_SETTINGS) {
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

export interface ClaudeOptions {
  /** command line that starts the CLI (default `claude`); tests point it at a recorded-stream replayer */
  command?: string[];
  /** ms between SIGTERM and SIGKILL on abort */
  killGraceMs?: number;
  /** reads one login-keychain item's secret, outside the sandbox (default `/usr/bin/security`); tests pass a fake */
  keychain?: KeychainReader;
  /** the OS (default `process.platform`); tests set `darwin` to exercise the keychain hand-over anywhere */
  platform?: NodeJS.Platform;
}

/** One login-keychain item's secret by service name, or null when it is missing or cannot be read. */
export type KeychainReader = (service: string) => Promise<string | null>;

/** The item the Claude CLI keeps its `/login` (or `claude setup-token`) login in on macOS. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** `security find-generic-password -s <service> -w`, never through a shell; the secret is returned, never logged. */
export const readKeychainItem: KeychainReader = async (service) => {
  try {
    const r = await execa('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      reject: false,
      timeout: 10_000,
      stdin: 'ignore',
    });
    const out = r.exitCode === 0 ? String(r.stdout).trim() : '';
    return out || null;
  } catch {
    return null;
  }
};

/**
 * The access token in the Claude CLI's keychain item: its `/login` JSON (`claudeAiOauth.accessToken`, only while it
 * has more than a minute left) or a bare `claude setup-token` token. null for anything else. The refresh token is
 * never returned: it stays in the keychain, so only the CLI outside PasaBot ever refreshes or rewrites the login.
 */
export function claudeLoginToken(secret: string | null, now = Date.now()): string | null {
  if (!secret) return null;
  let j: unknown;
  try {
    j = JSON.parse(secret);
  } catch {
    return /^sk-ant-oat[\w-]+$/.test(secret) ? secret : null;
  }
  const o = (j as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (typeof o.expiresAt === 'number' && o.expiresAt <= now + 60_000) return null;
  return o.accessToken;
}

/**
 * The sandboxed CLI's login on macOS. The sandbox denies every keychain file (the login keychain holds every app's
 * items, PasaBot's vault master key among them, and anything the agent runs inherits the sandbox), so the CLI cannot
 * read its own item in there. The server reads that one item here, outside the sandbox, and hands the CLI only its
 * access token (`CLAUDE_CODE_OAUTH_TOKEN`). Not for a provider account (its own config dir) or a login already in
 * the env.
 */
export async function sandboxLoginEnv(
  env: Record<string, string>,
  read: KeychainReader,
  platform: NodeJS.Platform,
): Promise<Record<string, string>> {
  if (platform !== 'darwin') return env;
  if (
    env.CLAUDE_CONFIG_DIR ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    env.ANTHROPIC_AUTH_TOKEN
  )
    return env;
  const token = claudeLoginToken(await read(CLAUDE_KEYCHAIN_SERVICE));
  return token ? { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } : env;
}

/**
 * Clean agents: without a provider account the CLI runs on PasaBot's own config dir in the agent's workspace
 * (`CLAUDE_CONFIG_DIR`), never `~/.claude`, so the user's personal `CLAUDE.md`, memories, rules, agents, commands,
 * hooks, plugins and MCP servers never reach an agent. The login still works: on macOS the keychain hand-over
 * (`sandboxLoginEnv`, read outside the CLI, sandboxed or not); elsewhere a link to the user's `.credentials.json`.
 * A provider account (its own config dir) or a config dir already in the env is left as it is.
 */
export async function cleanClaudeEnv(
  env: Record<string, string>,
  workspace: string,
  read: KeychainReader,
  platform: NodeJS.Platform,
): Promise<Record<string, string>> {
  if (env.CLAUDE_CONFIG_DIR) return env;
  const withLogin = await sandboxLoginEnv(env, read, platform);
  const dir = prepareCleanHome(cleanHomeDir(workspace, 'claude'), [
    { name: '.credentials.json', target: claudeUserCredentials(env) },
  ]);
  return { ...windowsLoginEnv(withLogin, dir, platform), CLAUDE_CONFIG_DIR: dir };
}

/**
 * Windows without Developer Mode cannot make the link to the user's `.credentials.json` (a file link needs it), so
 * the clean config dir would have no login and every turn would fail while the Brains page says "signed in". Then,
 * as on macOS, the server reads the login file itself and hands the CLI only its access token. The refresh token stays
 * in the user's file: the user's own Claude Code refreshes it. Never a copy of the file.
 */
export function windowsLoginEnv(
  env: Record<string, string>,
  cleanDir: string,
  platform: NodeJS.Platform,
  readFile: (p: string) => string | null = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
): Record<string, string> {
  if (platform !== 'win32') return env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return env;
  try {
    if (lstatSync(join(cleanDir, '.credentials.json')).isSymbolicLink()) return env;
  } catch {
    /* no link: hand the token over below */
  }
  const token = claudeLoginToken(readFile(claudeUserCredentials(env)));
  return token ? { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } : env;
}

/** The user's own Claude CLI login file (Linux, or macOS without a keychain): linked, never copied. */
export function claudeUserCredentials(env: Record<string, string | undefined>): string {
  return join(env.HOME || homedir(), '.claude', '.credentials.json');
}

const userLine = (text: string) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

export function classifyError(text: string): ProviderErrorKind {
  const t = text.toLowerCase();
  if (/rate.?limit|usage limit|too many requests|429/.test(t)) return 'rate_limit';
  if (/quota|credit balance|billing|insufficient/.test(t)) return 'quota';
  if (/auth|log ?in|api key|unauthori[sz]ed|401|403|oauth/.test(t)) return 'auth';
  if (/context|too long|prompt is too long|max.?tokens/.test(t)) return 'context_overflow';
  if (/timed? ?out|timeout/.test(t)) return 'timeout';
  return 'crash';
}
/** "resets in 3h" / "try again in 120 seconds" -> ms, when the CLI says. */
function retryAfter(text: string): number | undefined {
  const m = text.match(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  return n * (u.startsWith('h') ? 3600_000 : u.startsWith('m') ? 60_000 : 1000);
}
/**
 * Untrusted text (the user message and the reseed) must never close or open PasaBot's wrapper block (ARCHITECTURE 8):
 * a tag-like `<earlier-conversation>` inside it is defused.
 */
export function quoteUntrusted(s: string): string {
  return s.replace(/<(?=\s*\/?\s*earlier-conversation\b)/gi, '&lt;');
}

/**
 * The user message for one turn. A new session with a reseed (provider switch, compaction-by-reseed) gets the earlier
 * conversation ahead of the user text, as quoted data that cannot break out of its block; a resumed one never does.
 */
export function composePrompt(input: TurnInput): string {
  const text = withAttachments(input.user.text, input.user.attachments);
  if (input.nativeRef || !input.seed) return text;
  const recent = input.seed.recent.map((m) => `${m.authorKind}: ${quoteUntrusted(m.body)}`).join('\n');
  const seed = `${quoteUntrusted(input.seed.summary)}${recent ? `\n\n${recent}` : ''}`;
  return `<earlier-conversation>\n${seed}\n</earlier-conversation>\n\n${quoteUntrusted(text)}`;
}

/**
 * The CLI's environment: a provider account points the CLI at that account's own config dir (its login). A setup
 * token in the env (the owner's pasted one, or the shell's) is dropped then: the CLI would prefer it over the
 * account's own login, so the turn would run on the wrong subscription.
 */
export function claudeEnv(input: TurnInput): Record<string, string> {
  const env: Record<string, string> = { ...input.env };
  if (input.account?.configDir) {
    if (!env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = input.account.configDir;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return env;
}

const summarize = (content: unknown): string => {
  if (typeof content === 'string') return content.slice(0, 500);
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('')
      .slice(0, 500);
  return '';
};

/** Map one stream-json line to zero or more ProviderEvents. Stateful (session seen, delta streaming, Task spans). */
export class StreamMapper {
  sessionId: string | null = null;
  gotResult = false;
  resultError = false;
  private streamedText = false;
  private tasks = new Set<string>();

  map(line: Record<string, any>): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    const parent: string | undefined = line.parent_tool_use_id ?? undefined;
    switch (line.type) {
      case 'system':
        if (line.subtype === 'init' && line.session_id && !this.sessionId) {
          this.sessionId = line.session_id;
          out.push({ type: 'session', nativeRef: line.session_id });
        }
        break;
      case 'stream_event': {
        const ev = line.event ?? {};
        if (parent) break; // sub-agent token stream: spans only
        if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            this.streamedText = true;
            out.push({ type: 'text.delta', text: ev.delta.text });
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            out.push({ type: 'thinking', text: ev.delta.thinking });
          }
        }
        break;
      }
      case 'assistant': {
        for (const c of line.message?.content ?? []) {
          if (c.type === 'tool_use') {
            out.push({
              type: 'tool.call',
              id: c.id,
              name: c.name,
              input: c.input ?? {},
              ...(parent ? { parentId: parent } : {}),
            });
            if (c.name === 'Task' || c.name === 'Agent') {
              this.tasks.add(c.id);
              out.push({
                type: 'subagent',
                id: c.id,
                name: String(c.input?.subagent_type ?? c.input?.description ?? 'task'),
                state: 'start',
                ...(parent ? { parentId: parent } : {}),
              });
            }
          } else if (c.type === 'text' && c.text && !parent && !this.streamedText) {
            out.push({ type: 'text.delta', text: c.text }); // no partial messages: the whole block is one delta
          }
        }
        this.streamedText = false;
        break;
      }
      case 'user': {
        const content = line.message?.content;
        if (!Array.isArray(content)) break;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          out.push({
            type: 'tool.result',
            id: c.tool_use_id,
            ok: !c.is_error,
            summary: summarize(c.content),
          });
          if (this.tasks.delete(c.tool_use_id))
            out.push({ type: 'subagent', id: c.tool_use_id, name: 'task', state: 'end' });
        }
        break;
      }
      case 'result': {
        this.gotResult = true;
        if (line.session_id && !this.sessionId) {
          this.sessionId = line.session_id;
          out.push({ type: 'session', nativeRef: line.session_id });
        }
        const u = line.usage ?? {};
        const ok = line.subtype === 'success' && !line.is_error;
        if (ok) out.push({ type: 'text.final', text: String(line.result ?? '') });
        out.push({
          type: 'usage',
          inputTokens: Number(u.input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
          cacheTokens: Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
        });
        if (!ok) {
          this.resultError = true;
          const msg = String(line.result ?? line.error ?? line.subtype ?? 'error');
          const kind = classifyError(msg);
          const ra = kind === 'rate_limit' ? retryAfter(msg) : undefined;
          out.push({ type: 'error', kind, message: msg.slice(0, 500), ...(ra ? { retryAfterMs: ra } : {}) });
        }
        break;
      }
    }
    return out;
  }
}

/** CURATED (see `listModels`): the aliases `claude --help` documents for `--model`, fastest first. */
export const CLAUDE_MODELS: readonly ModelInfo[] = [
  { id: 'sonnet', label: 'Sonnet', hint: 'fast' },
  { id: 'opus', label: 'Opus', hint: 'smart' },
  { id: 'fable', label: 'Fable', hint: 'smartest' },
];

export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  /**
   * The headless sign-in (`claude setup-token`): the owner pastes that token into the vault (`brain:claude`), the
   * runner hands it to the CLI as `CLAUDE_CODE_OAUTH_TOKEN`, and the redaction filter hides it everywhere.
   */
  readonly keyEnv = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;
  private stdins = new Map<string, Writable>();
  constructor(private readonly o: ClaudeOptions = {}) {}

  private cmd(): [string, string[]] {
    const [bin, ...pre] = this.o.command ?? ['claude'];
    return [bin!, pre];
  }

  /**
   * Installed? (`--version`, found on the CLI search path, so a launchd/desktop server with a bare PATH still sees
   * it.) Signed in? (`claude auth status --json`, Claude Code 2+, read-only; only its `loggedIn` flag is read, nothing
   * of the output is kept or shown). With an account, its own config dir is checked.
   */
  async detect(acct?: ProviderAccount): Promise<ProviderStatus> {
    const [bin, pre] = this.cmd();
    const path = cliSearchPath();
    const found = findCli(bin, path);
    if (!found)
      return {
        installed: false,
        signedIn: false,
        hint: 'Claude Code CLI not found on PATH',
        hintKey: { key: 'core:provider.hint.notOnPath', params: { cli: 'Claude Code CLI' } },
        installCmd: INSTALL,
      };
    const env = {
      ...process.env,
      PATH: path,
      ...(acct?.configDir ? { CLAUDE_CONFIG_DIR: acct.configDir } : {}),
    };
    try {
      const r = await execa(found, [...pre, '--version'], {
        timeout: 15_000,
        reject: false,
        stdin: 'ignore',
        env,
      });
      if (r.exitCode !== 0)
        return {
          installed: false,
          signedIn: false,
          hint: 'claude --version failed',
          hintKey: { key: 'core:provider.hint.versionFailed', params: { cmd: 'claude' } },
          installCmd: INSTALL,
        };
      const version = String(r.stdout).match(/\d+\.\d+\.\d+/)?.[0];
      const signedIn =
        Number(version?.split('.')[0] ?? 0) >= 2 ? await this.signedIn(found, pre, env) : 'unknown';
      return {
        installed: true,
        ...(version ? { version } : {}),
        signedIn,
        ...(signedIn === true
          ? {}
          : {
              hint: 'run `claude` once to sign in',
              hintKey: { key: 'core:provider.hint.runToSignIn', params: { cmd: 'claude' } },
            }),
      };
    } catch {
      return {
        installed: false,
        signedIn: false,
        hint: 'Claude Code CLI not found on PATH',
        hintKey: { key: 'core:provider.hint.notOnPath', params: { cli: 'Claude Code CLI' } },
        installCmd: INSTALL,
      };
    }
  }
  /**
   * Signed in the way a turn runs: a setup token in the vault is handed over (signed in); otherwise the login a turn
   * would get on its clean config dir is the keychain hand-over (`sandboxLoginEnv`) or, failing that, whatever
   * `claude auth status` finds with the turn's env, inside the same sandbox when there is one (a wrapper
   * script that injects a token from the keychain cannot do so in there, so this is where "logged in" outside turns
   * into "signed out" for a turn). Cheap: one local command, no model call.
   */
  async turnSignIn(ctx: {
    env: Record<string, string>;
    sandbox?: CommandWrapper;
    hasKey: boolean;
    cwd: string;
  }): Promise<boolean | 'unknown'> {
    if (ctx.hasKey) return true;
    try {
      // a turn runs on the clean config dir, sandboxed or not: `detect` (the user's own ~/.claude) cannot tell
      const env = await cleanClaudeEnv(
        { ...ctx.env },
        ctx.cwd,
        this.o.keychain ?? readKeychainItem,
        this.o.platform ?? process.platform,
      );
      if (env.CLAUDE_CODE_OAUTH_TOKEN) return true;
      const [bin, pre] = this.cmd();
      const args = [...pre, 'auth', 'status', '--json'];
      const c = ctx.sandbox
        ? ctx.sandbox(bin, args, { writable: claudeTurnWritable(env, ctx.cwd) })
        : { cmd: bin, args };
      const r = await execa(c.cmd, c.args, {
        cwd: ctx.cwd,
        env,
        extendEnv: false,
        timeout: 10_000,
        reject: false,
        stdin: 'ignore',
      });
      const j = JSON.parse(String(r.stdout)) as { loggedIn?: unknown };
      return typeof j.loggedIn === 'boolean' ? j.loggedIn : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  private async signedIn(bin: string, pre: string[], env: NodeJS.ProcessEnv): Promise<boolean | 'unknown'> {
    try {
      const r = await execa(bin, [...pre, 'auth', 'status', '--json'], {
        timeout: 10_000,
        reject: false,
        stdin: 'ignore',
        env,
      });
      const j = JSON.parse(String(r.stdout)) as { loggedIn?: unknown };
      return typeof j.loggedIn === 'boolean' ? j.loggedIn : 'unknown';
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
      permissionBridge: true,
      subagentEvents: true,
      contextReport: false,
    };
  }
  /**
   * Curated fallback: the Claude Code CLI has no model-listing command (checked on Claude Code 2.1.321: no `models`
   * subcommand in `claude --help`). Its `--model` help names these aliases for the latest models, so only they are
   * listed; the CLI resolves each to the current model of that family. Not ticked by default: without `--model` the
   * CLI uses the account's own default.
   */
  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS.map((m) => ({ ...m, curated: true }));
  }
  skillsDir(workspace: string) {
    return join(workspace, '.claude', 'skills');
  }
  async steer(runId: string, text: string): Promise<boolean> {
    const s = this.stdins.get(runId);
    if (!s || s.writableEnded || s.destroyed) return false;
    return new Promise((res) => s.write(userLine(text), (e) => res(!e)));
  }

  /** CLI arguments for one turn (exported for tests). */
  args(input: TurnInput, mcpConfigPath: string | null): string[] {
    // a tool-less turn (5.1) gets no tools at all: the built-in set is switched off (`--tools ''`) and nothing is
    // pre-accepted, so even an edit has nothing to run
    const toolless = input.tools === 'none';
    const mode = !toolless && input.agent.trustLevel === 'trusted' ? 'acceptEdits' : 'default';
    return [
      ...(toolless ? ['--tools', ''] : []),
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--append-system-prompt',
      input.systemPrompt,
      '--permission-mode',
      mode,
      '--strict-mcp-config',
      // never `user` (the clean config dir's settings could only be the agent's own writes: hooks there would skip the
      // permission prompt) nor the workspace's `.claude/settings.local.json`; `project` stays only because the CLI
      // loads the synced skills (`.claude/skills`) under it, and `setAsideWorkspaceSettings` removes its settings
      // files before each turn
      '--setting-sources',
      'project',
      // server-set, on the command line where the agent cannot edit it: the file tools may not write the CLI's config
      '--settings',
      LOCKED_SETTINGS,
      ...(mcpConfigPath
        ? ['--mcp-config', mcpConfigPath, '--permission-prompt-tool', PERMISSION_TOOL_FQN]
        : []),
      ...(input.model ? ['--model', input.model] : []),
      ...(input.nativeRef ? ['--resume', input.nativeRef] : []),
    ];
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const [bin, pre] = this.cmd();
    let env = claudeEnv(input);
    // the run bearer goes in a 0600 temp file, not on the command line
    let mcpPath: string | null = null;
    if (input.tools === 'gateway' && input.mcp.url) {
      // inside the agent's own workspace: its sandbox sees it, other agents' sandboxes do not (shared $TMPDIR
      // would let any agent read every live bearer; bwrap's private /tmp would hide it from the CLI)
      const dir = join(input.workspaceDir, '.pasabot');
      mkdirPrivate(dir);
      chmodSync(dir, 0o700);
      mcpPath = join(dir, `mcp-${randomBytes(8).toString('hex')}.json`);
      writeFileSync(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            pasabot: {
              type: 'http',
              url: input.mcp.url,
              headers: { Authorization: `Bearer ${input.mcp.bearer}` },
            },
          },
        }),
        { mode: 0o600 },
      );
    }
    let command: { cmd: string; args: string[] };
    try {
      setAsideWorkspaceSettings(input.workspaceDir);
      const args = [...pre, ...this.args(input, mcpPath)];
      env = await cleanClaudeEnv(
        env,
        input.workspaceDir,
        this.o.keychain ?? readKeychainItem,
        this.o.platform ?? process.platform,
      );
      command = input.sandbox
        ? input.sandbox(bin, args, { writable: claudeTurnWritable(env, input.workspaceDir) })
        : // Windows: the real program behind an npm `.cmd` shim, never cmd.exe (the system prompt has line breaks)
          resolveForSpawn(bin, args, env.PATH);
    } catch (e) {
      if (mcpPath) rmSync(mcpPath, { force: true });
      yield { type: 'error', kind: 'crash', message: (e as Error).message };
      yield { type: 'done', stop: 'error' };
      return;
    }

    const child = execa(command.cmd, command.args, {
      cwd: input.workspaceDir,
      env,
      extendEnv: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // own process group: abort kills the CLI and everything it spawned (Windows: taskkill /T, see killTree)
      detached: detachedGroup(),
      reject: false,
      buffer: { stdout: false, stderr: true },
    });
    // Windows: one taskkill /T /F and never a second one on a pid that may be reused (see childTreeKiller)
    const killGroup = childTreeKiller(child);
    let aborted = signal.aborted;
    let killTimer: NodeJS.Timeout | undefined;
    const stopGroup = () => {
      killGroup('SIGTERM');
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => killGroup('SIGKILL'), this.o.killGraceMs ?? 2000);
      killTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      stopGroup();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (aborted) onAbort();
    child.stdin!.on('error', () => {});
    this.stdins.set(input.runId, child.stdin!);
    child.stdin!.write(userLine(composePrompt(input)));

    const mapper = new StreamMapper();
    const rl = createInterface({ input: child.stdout! });
    try {
      for await (const raw of rl) {
        if (aborted) break;
        const line = raw.trim();
        if (!line.startsWith('{')) continue;
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of mapper.map(obj)) yield ev;
        if (mapper.gotResult) {
          this.stdins.delete(input.runId);
          child.stdin!.end(); // no more steering: let the CLI exit
        }
      }
    } finally {
      rl.close();
      this.stdins.delete(input.runId);
      if (!child.stdin!.writableEnded) child.stdin!.end();
      // aborted, or the consumer stopped iterating before a result: the group must not outlive the turn
      if (aborted || !mapper.gotResult) stopGroup();
    }
    const res = await child;
    signal.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (mcpPath) rmSync(mcpPath, { force: true });
    if (aborted) {
      yield { type: 'done', stop: 'cancelled' };
      return;
    }
    if (!mapper.gotResult) {
      const err = String(res.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-5)
        .join('\n');
      const msg = err || `claude exited with code ${res.exitCode ?? 'unknown'} without a result`;
      yield {
        type: 'error',
        kind: classifyError(msg) === 'crash' ? 'crash' : classifyError(msg),
        message: msg.slice(0, 500),
      };
      yield { type: 'done', stop: 'error' };
      return;
    }
    yield { type: 'done', stop: mapper.resultError ? 'error' : 'end' };
  }
}

const INSTALL = ['npm', 'install', '-g', '@anthropic-ai/claude-code'];

export default new ClaudeProvider();

/**
 * What a turn's CLI may write outside its workspace: its config dir when that is not the clean one in the workspace
 * (a provider account's), and the user's login file the clean dir links to (the CLI refreshes it).
 */
export function claudeTurnWritable(env: Record<string, string | undefined>, workspace: string): string[] {
  const ws = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`;
  const out = claudeStatePaths(env).filter((p) => !`${p}${sep}`.startsWith(ws));
  if (env.CLAUDE_CONFIG_DIR && `${env.CLAUDE_CONFIG_DIR}${sep}`.startsWith(ws)) {
    const cred = claudeUserCredentials(env);
    if (existsSync(cred)) out.push(cred);
  }
  return out;
}

/** The Claude CLI's own state (login, settings, session history): it must stay writable inside the sandbox. */
export function claudeStatePaths(env: Record<string, string | undefined>): string[] {
  if (env.CLAUDE_CONFIG_DIR) return [env.CLAUDE_CONFIG_DIR];
  const home = env.HOME || homedir();
  return [join(home, '.claude'), join(home, '.claude.json')];
}
