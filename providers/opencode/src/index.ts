/**
 * OpenCode adapter: drives `opencode run --format json` (one process per turn, prompt on stdin), maps its JSON
 * events to ProviderEvents, resumes with `--session <id>`, and kills the whole process group on abort
 * (ARCHITECTURE 5.1). The security settings (instructions file, permissions per effective trust, no sharing, no
 * plugins) go in `OPENCODE_CONFIG_CONTENT`, OpenCode's highest-precedence layer, so no config file can override
 * them; project config loading is switched off, so a workspace `opencode.json` or `.opencode/` the agent wrote
 * cannot add MCP servers or plugins either; and without an account the owner's own global config never loads (a
 * fresh empty config home per turn). Only the gateway entry with the run bearer goes in a 0600 file inside the
 * agent's workspace, named by `OPENCODE_CONFIG` (never in the environment the agent's shell inherits), and it is
 * removed after the turn.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type {
  ModelInfo,
  ProviderAccount,
  ProviderAdapter,
  ProviderCaps,
  ProviderEvent,
  ProviderStatus,
  SenderInfo,
  TurnInput,
} from '@pasabot/core';
import { cliSearchPath, findCli, mkdirPrivate, withAttachments } from '@pasabot/core';
import type { TrustLevel } from '@pasabot/protocol';
import { execa } from 'execa';
import { type CliExit, classifyError, jsonLines, retryAfter, stderrTail } from './cli.js';

export { classifyError, retryAfter } from './cli.js';

export interface OpenCodeOptions {
  /** command line that starts the CLI (default `opencode`); tests point it at a recorded-stream replayer */
  command?: string[];
  /** ms between SIGTERM and SIGKILL on abort */
  killGraceMs?: number;
  /** PasaBot's data dir for the model list's OpenCode homes (default `$PASABOT_HOME`); tests pass a temp dir */
  pasabotHome?: string;
}

/**
 * Clean agents: OpenCode's Claude Code compatibility would load the user's own `~/.claude/CLAUDE.md` (as global
 * rules when OpenCode has none of its own) and `~/.claude/skills`, and its external skill folders (`.agents`,
 * `.claude`) the user's personal skills. PasaBot's own instructions and synced skills (`.opencode/skill`) still load.
 */
export const CLEAN_AGENT_ENV: Record<string, string> = {
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
};

type Permission = 'allow' | 'deny';
const clip = (s: unknown, n = 500) => String(s ?? '').slice(0, n);

export function errorEvent(msg: string, hint?: { name?: string; status?: number }): ProviderEvent {
  let kind = classifyError(msg);
  if (hint?.name && /auth/i.test(hint.name)) kind = 'auth';
  else if (hint?.status === 429) kind = 'rate_limit';
  else if (hint?.status === 401 || hint?.status === 403) kind = 'auth';
  const ra = kind === 'rate_limit' || kind === 'quota' ? retryAfter(msg) : undefined;
  return { type: 'error', kind, message: msg.slice(0, 500), ...(ra ? { retryAfterMs: ra } : {}) };
}

/** Map one `opencode run --format json` line to zero or more ProviderEvents. Stateful (session, step text, usage). */
export class OpenCodeMapper {
  sessionId: string | null = null;
  failed = false;
  private stepText = '';
  private lastText = '';
  private texts = 0;
  private usage = { input: 0, output: 0, cache: 0, seen: false };

  map(line: Record<string, any>): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    if (line.sessionID && !this.sessionId) {
      this.sessionId = String(line.sessionID);
      out.push({ type: 'session', nativeRef: this.sessionId });
    }
    const part: Record<string, any> = line.part ?? {};
    switch (line.type) {
      case 'step_start':
        this.stepText = '';
        break;
      case 'text': {
        const text = String(part.text ?? '');
        if (!text) break;
        // parts arrive whole, not as tokens: each is one delta
        out.push({ type: 'text.delta', text: this.texts++ ? `\n\n${text}` : text });
        this.stepText = this.stepText ? `${this.stepText}\n\n${text}` : text;
        this.lastText = text;
        break;
      }
      case 'reasoning':
        if (part.text) out.push({ type: 'thinking', text: String(part.text) });
        break;
      case 'tool_use': {
        const id = String(part.callID ?? part.id ?? '');
        const st: Record<string, any> = part.state ?? {};
        out.push({ type: 'tool.call', id, name: String(part.tool ?? 'tool'), input: st.input ?? {} });
        if (st.status === 'completed' || st.status === 'error')
          out.push({
            type: 'tool.result',
            id,
            ok: st.status === 'completed',
            summary: clip(st.status === 'error' ? st.error : (st.output ?? st.title)),
          });
        break;
      }
      case 'step_finish': {
        const t = part.tokens ?? {};
        this.usage.seen = true;
        this.usage.input += Number(t.input ?? 0);
        this.usage.output += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
        this.usage.cache += Number(t.cache?.read ?? 0) + Number(t.cache?.write ?? 0);
        break;
      }
      case 'error': {
        this.failed = true;
        const e = line.error ?? {};
        const msg = String(e.data?.message ?? e.message ?? e.name ?? 'error');
        out.push(errorEvent(msg, { name: e.name, status: Number(e.data?.statusCode) || undefined }));
        break;
      }
    }
    return out;
  }

  /** Final text + summed usage once the CLI exits cleanly. */
  finish(): ProviderEvent[] {
    return [
      { type: 'text.final', text: this.stepText || this.lastText },
      {
        type: 'usage',
        inputTokens: this.usage.input,
        outputTokens: this.usage.output,
        cacheTokens: this.usage.cache,
      },
    ];
  }
}

/**
 * The trust a turn runs at (ARCHITECTURE 7.1, 7.4): the lower of the agent's and the sender's trust, one level lower
 * again when the sender is not the owner. Same rule as `effectiveTrust` in apps/server/src/approvals; OpenCode has
 * no permission bridge, so this value alone picks what OpenCode may do on its own.
 */
export function effectiveTrust(agentTrust: TrustLevel, sender: SenderInfo): TrustLevel {
  const order: TrustLevel[] = ['guarded', 'standard', 'trusted'];
  const base = order[Math.min(order.indexOf(agentTrust), Math.max(0, order.indexOf(sender.trust)))]!;
  if (sender.kind === 'owner') return base;
  return base === 'trusted' ? 'standard' : 'guarded';
}

/** Untrusted text must never close PasaBot's quoted block (ARCHITECTURE 8): a tag-like wrapper name is defused. */
export function quoteUntrusted(s: string): string {
  return s.replace(/<(?=\s*\/?\s*(?:instructions|earlier-conversation)\b)/gi, '&lt;');
}

/** Reseed for a new session (provider switch / compaction-by-reseed) ahead of the user text, as quoted data. */
export function composePrompt(input: TurnInput): string {
  const text = quoteUntrusted(withAttachments(input.user.text, input.user.attachments));
  if (input.nativeRef || !input.seed) return text;
  const recent = input.seed.recent.map((m) => `${m.authorKind}: ${quoteUntrusted(m.body)}`).join('\n');
  const seed = `${quoteUntrusted(input.seed.summary)}${recent ? `\n\n${recent}` : ''}`;
  return `<earlier-conversation>\n${seed}\n</earlier-conversation>\n\n${text}`;
}

/**
 * Effective trust → OpenCode permissions. No permission bridge, so whatever PasaBot would ask about is denied:
 * workspace edits are tier 1 (allowed), shell and web are tier 2 (allowed only when the turn is `trusted`, which a
 * non-owner turn never is), anything outside the workspace is tier 3 (always denied). A tool-less call denies
 * everything and gets no gateway.
 */
export function permissions(input: TurnInput): Record<string, Permission> {
  if (input.tools === 'none')
    return { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' };
  const trusted = effectiveTrust(input.agent.trustLevel, input.user.from) === 'trusted';
  const t: Permission = trusted ? 'allow' : 'deny';
  return { edit: 'allow', bash: t, webfetch: t, external_directory: 'deny' };
}

/** The security settings, for `OPENCODE_CONFIG_CONTENT` (highest precedence): no file can override them. */
export function securityConfig(input: TurnInput, instructionsPath: string): Record<string, unknown> {
  return {
    instructions: [instructionsPath],
    permission: permissions(input),
    share: 'disabled', // a session must never be published to a share link
    autoupdate: false,
    plugin: [],
  };
}

/** The gateway entry with the run bearer, for the 0600 `OPENCODE_CONFIG` file (kept out of the environment). */
export function gatewayConfig(input: TurnInput): Record<string, unknown> {
  return {
    ...(input.tools !== 'none' && input.mcp.url
      ? {
          mcp: {
            pasabot: {
              type: 'remote',
              url: input.mcp.url,
              enabled: true,
              headers: { Authorization: `Bearer ${input.mcp.bearer}` },
            },
          },
        }
      : {}),
  };
}

export class OpenCodeProvider implements ProviderAdapter {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';
  constructor(private readonly o: OpenCodeOptions = {}) {}

  private cmd(): [string, string[]] {
    const [bin, ...pre] = this.o.command ?? ['opencode'];
    return [bin!, pre];
  }

  /** Installed? (`--version`, found on the CLI search path.) Free models need no sign-in, so it stays 'unknown'. */
  async detect(): Promise<ProviderStatus> {
    const [cmd, pre] = this.cmd();
    const path = cliSearchPath();
    const bin = findCli(cmd, path);
    try {
      if (!bin) throw new Error('not found');
      const r = await execa(bin, [...pre, '--version'], {
        timeout: 15_000,
        reject: false,
        stdin: 'ignore',
        env: { ...process.env, PATH: path },
      });
      if (r.exitCode !== 0)
        return {
          installed: false,
          signedIn: false,
          hint: 'opencode --version failed',
          hintKey: { key: 'core:provider.hint.versionFailed', params: { cmd: 'opencode' } },
          installCmd: INSTALL,
        };
      const version = String(r.stdout).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
      return {
        installed: true,
        ...(version ? { version } : {}),
        signedIn: 'unknown',
        hint: 'run `opencode auth login` once to add a provider',
        hintKey: { key: 'core:provider.hint.runToAddProvider', params: { cmd: 'opencode auth login' } },
      };
    } catch {
      return {
        installed: false,
        signedIn: false,
        hint: 'OpenCode CLI not found on PATH',
        hintKey: { key: 'core:provider.hint.notOnPath', params: { cli: 'OpenCode CLI' } },
        installCmd: INSTALL,
      };
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

  async listModels(acct?: ProviderAccount): Promise<ModelInfo[]> {
    const [bin, pre] = this.cmd();
    const {
      OPENCODE_CONFIG_DIR: _dir,
      OPENCODE_CONFIG: _cfg,
      ...base
    } = process.env as Record<string, string>;
    // without an account: PasaBot's own data, state and config homes under $PASABOT_HOME (0700, kept: OpenCode's
    // database and caches), never the user's own OpenCode database or config, the same as a turn sees. Only without
    // a data dir at all (a library caller) a throwaway one in the OS temp dir, removed after.
    const pasabotHome = this.o.pasabotHome ?? process.env.PASABOT_HOME;
    const root = acct?.configDir
      ? null
      : pasabotHome
        ? listModelsHome(pasabotHome)
        : mkdtempSync(join(tmpdir(), 'pasabot-opencode-'));
    const env = root
      ? { ...base, ...CLEAN_AGENT_ENV, ...ownDataEnv(root, base), XDG_CONFIG_HOME: cleanConfigHome(root) }
      : { ...accountEnv(base, acct), ...CLEAN_AGENT_ENV };
    const r = await execa(bin, [...pre, 'models'], {
      timeout: 30_000,
      reject: false,
      stdin: 'ignore',
      env,
    })
      .catch(() => null)
      .finally(() => {
        if (root && !pasabotHome) rmSync(root, { recursive: true, force: true });
      });
    // the app says "could not load models" instead of showing an empty list
    if (r?.exitCode !== 0) throw new Error(`opencode models failed: ${stderrTail(String(r?.stderr ?? ''))}`);
    // `opencode models` prints one `<provider>/<model>` per line; a `-free` suffix is the provider's own free mark
    return String(r.stdout)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+\/\S+$/.test(l))
      .map((id) => (/-free$/.test(id) ? { id, hint: 'free' as const } : { id }));
  }

  skillsDir(workspace: string) {
    return join(workspace, '.opencode', 'skill');
  }

  /** CLI arguments for one turn (exported for tests). The prompt goes on stdin. */
  args(input: TurnInput): string[] {
    return [
      'run',
      '--format',
      'json',
      ...(input.model ? ['--model', input.model] : []),
      ...(input.nativeRef ? ['--session', input.nativeRef] : []),
    ];
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const [bin, pre] = this.cmd();
    // inside the agent's own workspace: its sandbox sees it, other agents' sandboxes do not
    const dir = join(input.workspaceDir, '.pasabot');
    const tag = randomBytes(8).toString('hex');
    const instructionsPath = join(dir, `opencode-instructions-${tag}.md`);
    const configPath = join(dir, `opencode-${tag}.json`);
    // without an account: a fresh, empty config home, so the owner's global OpenCode config never loads
    const configHome = input.account?.configDir ? null : join(dir, `opencode-config-${tag}`);
    // ...and OpenCode's own data and state (sessions for resume) in the agent's workspace inside PASABOT_HOME, so a
    // broken or newer-format OpenCode database in the user's home never breaks a turn
    const ownRoot = input.account?.configDir ? null : join(dir, 'opencode');
    const cleanup = () => {
      rmSync(configPath, { force: true });
      rmSync(instructionsPath, { force: true });
      if (configHome) rmSync(configHome, { recursive: true, force: true });
    };
    // an inherited config dir or inline permission layer would bring config PasaBot did not write
    const { OPENCODE_CONFIG_DIR: _dir, OPENCODE_PERMISSION: _perm, ...base } = input.env;
    const env = accountEnv(
      {
        ...base,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(securityConfig(input, instructionsPath)),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        ...CLEAN_AGENT_ENV,
        ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}),
        ...(ownRoot
          ? {
              XDG_DATA_HOME: join(ownRoot, 'data'),
              XDG_STATE_HOME: join(ownRoot, 'state'),
              XDG_CACHE_HOME: join(ownRoot, 'cache'),
            }
          : {}),
      },
      input.account,
    );
    let command: { cmd: string; args: string[] };
    try {
      mkdirPrivate(dir, { tighten: true });
      if (configHome) mkdirPrivate(configHome);
      writeFileSync(instructionsPath, input.systemPrompt, { mode: 0o600 });
      writeFileSync(configPath, JSON.stringify(gatewayConfig(input)), { mode: 0o600 });
      const args = [...pre, ...this.args(input)];
      // the workspace is writable already (and sits in the protected PASABOT_HOME: never asked for again)
      const ws = input.workspaceDir.endsWith(sep) ? input.workspaceDir : `${input.workspaceDir}${sep}`;
      // the user's own sign-in file (that one file, not its folder: the user's OpenCode database sits next to it),
      // linked into PasaBot's data home, stays writable where it really lives: OpenCode refreshes an expiring OAuth
      // token by writing through the link in place (checked on OpenCode 1.19.5: `opencode auth logout` rewrote the
      // target and kept the link), and a read-only file would fail the turn as signed out
      const userAuth = ownRoot ? userAuthPath(base) : null;
      command = input.sandbox
        ? input.sandbox(bin, args, {
            writable: [
              ...openCodeStatePaths(env).filter((p) => !p.startsWith(ws)),
              ...(userAuth && existsSync(userAuth) && !userAuth.startsWith(ws) ? [userAuth] : []),
            ],
          })
        : { cmd: bin, args };
      // kept across turns (sessions for resume); made once the runner has taken the command
      if (ownRoot) ownDataEnv(ownRoot, base);
    } catch (e) {
      cleanup();
      yield { type: 'error', kind: 'crash', message: clip((e as Error).message) };
      yield { type: 'done', stop: 'error' };
      return;
    }

    const exit: CliExit = { exitCode: undefined, stderr: '', aborted: false };
    const mapper = new OpenCodeMapper();
    let spawnError: string | null = null;
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
      spawnError = (e as Error).message;
    } finally {
      cleanup();
    }
    if (exit.aborted) {
      yield { type: 'done', stop: 'cancelled' };
      return;
    }
    if (mapper.failed) {
      yield { type: 'done', stop: 'error' };
      return;
    }
    if (spawnError || exit.exitCode !== 0 || !mapper.sessionId) {
      const msg =
        spawnError ||
        stderrTail(exit.stderr) ||
        (exit.exitCode === 0
          ? 'opencode printed no events'
          : `opencode exited with code ${exit.exitCode ?? 'unknown'}`);
      yield errorEvent(msg);
      yield { type: 'done', stop: 'error' };
      return;
    }
    for (const ev of mapper.finish()) yield ev;
    yield { type: 'done', stop: 'end' };
  }
}

const INSTALL = ['npm', 'install', '-g', 'opencode-ai'];

export default new OpenCodeProvider();

/** A provider account keeps its own OpenCode login and settings under its config dir. */
function accountEnv(env: Record<string, string>, acct?: ProviderAccount): Record<string, string> {
  if (!acct?.configDir) return env;
  return {
    ...env,
    XDG_DATA_HOME: env.XDG_DATA_HOME ?? join(acct.configDir, 'data'),
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? join(acct.configDir, 'config'),
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(acct.configDir, 'state'),
    // OpenCode's caches (model catalog, provider packages) never land in the user's ~/.cache/opencode
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(acct.configDir, 'cache'),
  };
}

/**
 * PasaBot's own OpenCode data, state and cache homes under `root` (created 0700), as the env that points the CLI at
 * them (`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, which OpenCode honours): nothing lands in the user's
 * ~/.local/share/opencode, ~/.local/state/opencode or ~/.cache/opencode. The user's own OpenCode database is never opened, so a
 * broken or newer-format one cannot break PasaBot. The user's OpenCode sign-ins (`auth.json`, from `opencode auth
 * login`) still work: a link to that file, never a copy, so no credential is stored in PasaBot's home.
 */
export function ownDataEnv(root: string, env: Record<string, string | undefined>) {
  const data = join(root, 'data');
  const state = join(root, 'state');
  const cache = join(root, 'cache');
  mkdirPrivate(join(data, 'opencode'));
  mkdirPrivate(join(state, 'opencode'));
  mkdirPrivate(join(cache, 'opencode'));
  const homes = { XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache };
  const userAuth = userAuthPath(env);
  const link = join(data, 'opencode', 'auth.json');
  if (userAuth === link) return homes;
  // checked every time: anything but a link to the user's own file (a copy OpenCode left by replacing the link, or a
  // link to an older sign-in location) is removed, so no credential stays in PasaBot's home and a later
  // `opencode auth login` is always the one used
  let present = false;
  try {
    present = lstatSync(link).isSymbolicLink() && readlinkSync(link) === userAuth;
    if (!present) rmSync(link, { force: true });
  } catch {
    present = false;
  }
  try {
    if (!present && existsSync(userAuth)) symlinkSync(userAuth, link);
  } catch {
    /* no sign-in to share: free models need none */
  }
  return homes;
}

/** The model list's OpenCode homes: `$PASABOT_HOME/providers/opencode` (0700). */
export function listModelsHome(pasabotHome: string): string {
  const root = join(pasabotHome, 'providers', 'opencode');
  mkdirPrivate(root, { tighten: true });
  return root;
}

/** An empty config home under `root` (0700): the user's own `~/.config/opencode` never loads. */
function cleanConfigHome(root: string): string {
  const dir = join(root, 'config');
  mkdirPrivate(dir, { tighten: true });
  return dir;
}

/** The user's own OpenCode sign-ins (`opencode auth login`), in their data home. */
function userAuthPath(env: Record<string, string | undefined>): string {
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'opencode', 'auth.json');
}

/** OpenCode's own state (login, sessions for resume, caches): it must stay writable inside the sandbox. */
export function openCodeStatePaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || homedir();
  return [
    join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
    join(env.XDG_CACHE_HOME || join(home, '.cache'), 'opencode'),
    join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode'),
  ];
}
