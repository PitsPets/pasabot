/**
 * Runner modes (ARCHITECTURE 7.2). `host` wraps every agent CLI in an OS sandbox that denies $PASABOT_HOME (except
 * the agent's own workspace), other workspaces, the `pasabot` CLI's credential folder, ~/.ssh, keychains and
 * browser profiles: `sandbox-exec` on macOS,
 * bubblewrap on Linux. `user` and `container` are selected by platform but their launchers land with W20.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  type CommandWrapper,
  cliSearchDirAncestors,
  cliSearchDirs,
  cliSearchPath,
  findCli,
  userCliDirs,
  windowsEnv,
} from '@pasabot/core';

export type RunnerMode = 'host' | 'host-unsandboxed' | 'user' | 'container';
export const RUNNER_MODES: RunnerMode[] = ['host', 'host-unsandboxed', 'user', 'container'];

export class RunnerUnavailableError extends Error {}

/**
 * Per-platform default: Docker -> container; macOS -> host; Linux desktop -> host; Linux server -> user; Windows ->
 * host-unsandboxed. Windows has no agent sandbox in PasaBot (no Seatbelt or bubblewrap equivalent is built), and the
 * app says so instead of pretending: a startup card on the owner's home screen (`hostModeWarning`, the notices), and
 * new helpers start on the careful "asks before anything outside its folder" setting (`careful default trust`).
 */
export function defaultRunnerMode(env = process.env, platform = process.platform): RunnerMode {
  const fromEnv = env.PASABOT_RUNNER as RunnerMode | undefined;
  if (fromEnv && RUNNER_MODES.includes(fromEnv)) return fromEnv;
  if (platform !== 'win32' && existsSync('/.dockerenv')) return 'container';
  if (platform === 'darwin') return 'host';
  if (platform === 'linux')
    return env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP ? 'host' : 'user';
  if (platform === 'win32') return 'host-unsandboxed';
  return 'host';
}

/** Whether helpers here run with no OS sandbox at all (Windows by default, or `PASABOT_RUNNER=host-unsandboxed`). */
export const noOsSandbox = (mode: RunnerMode) => mode === 'host-unsandboxed';

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const sbString = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The `pasabot` CLI's credential folder (apps/cli: `session.json` holds an owner session token, `automation.json`
 * automation tokens): `$XDG_CONFIG_HOME/pasabot`, else `~/.config/pasabot`. Both are listed when XDG_CONFIG_HOME is
 * set, because the owner's shell may set it while the server's environment does not, or the other way round.
 */
export function cliCredentialPaths(home = homedir(), env = process.env): string[] {
  const out = [join(home, '.config', 'pasabot')];
  if (env.XDG_CONFIG_HOME) {
    const xdg = join(env.XDG_CONFIG_HOME, 'pasabot');
    if (!out.includes(xdg)) out.push(xdg);
  }
  return out;
}

/** Paths an agent must never read, besides $PASABOT_HOME (minus its workspace). */
function privatePaths(home = homedir()): string[] {
  return [
    // an owner session or automation token here is one `curl` away from owner-level REST on 127.0.0.1
    ...cliCredentialPaths(home),
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, 'Library', 'Keychains'),
    join(home, '.local', 'share', 'keyrings'),
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    join(home, 'Library', 'Application Support', 'Firefox'),
    join(home, 'Library', 'Safari'),
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
    join(home, '.mozilla'),
  ];
}

/**
 * Clean agents, the sandbox half (each brain adapter also runs its CLI on a clean config home of PasaBot's): the
 * user's personal agent setup, which a brain CLI started in their home would load as its own (global instructions,
 * memories, rules, custom agents and commands, hooks, plugins, MCP servers) or which holds their other sessions'
 * transcripts. Denied to every agent, read and write; only `personalLoginFiles` inside these stay usable.
 */
export function personalAgentPaths(home = homedir()): string[] {
  const h = (...p: string[]) => join(home, ...p);
  return [
    h('.claude'), // CLAUDE.md, rules, agents, commands, skills, hooks, plugins, settings, projects/ (memories)
    h('.claude.json'), // the Claude CLI's global config: the user's MCP servers and account details
    h('.claude.json.backup'),
    h('.codex'), // AGENTS.md, config.toml, memories, rules, skills, prompts, hooks, plugins, sessions
    h('.config', 'opencode'), // OpenCode's global config, AGENTS.md, agents, commands, plugins
    h('.local', 'share', 'opencode'), // the user's own OpenCode database (sessions)
    h('.local', 'state', 'opencode'),
    h('.gemini', 'GEMINI.md'), // Gemini's global memory file (its save-memory tool writes here)
    h('.gemini', 'extensions'),
    h('.gemini', 'commands'),
    h('.agents'), // cross-CLI personal skills
  ];
}

/** The user's own CLI sign-in files inside `personalAgentPaths`: the adapters' clean homes link to them. */
export function personalLoginFiles(home = homedir()): string[] {
  return [
    join(home, '.claude', '.credentials.json'),
    join(home, '.codex', 'auth.json'),
    join(home, '.local', 'share', 'opencode', 'auth.json'),
  ];
}

/**
 * The sign-in files this turn's brain uses (its adapter's `writable`): the only ones put back. Another brain's
 * sign-in stays denied (an OpenCode turn never reads the Codex or Claude refresh token).
 */
export function turnLoginFiles(writable: string[], home = homedir()): string[] {
  const w = writable.map(real);
  return personalLoginFiles(home)
    .map(real)
    .filter((p) => w.includes(p));
}

/**
 * Brain CLIs that still run on the user's own state folder (Gemini, Grok): it holds their personal settings (MCP
 * servers with their env secrets, hooks). Denied, read and write, to every turn but one on that brain (its adapter
 * lists the folder in `writable`), so no other agent reads those secrets or plants a hook there.
 */
export function brainStateFolders(home = homedir()): string[] {
  return [join(home, '.gemini'), join(home, '.grok')];
}
const foreignStateFolders = (writable: string[]) => {
  const w = writable.map(real);
  return brainStateFolders()
    .map(real)
    .filter((f) => !w.some((p) => inside(p, f)));
};

/** Instruction files a CLI picks up from the folders above its working dir (Claude Code, Codex, OpenCode, Gemini). */
export const ANCESTOR_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
  '.claude',
];

/** Each instruction file in every folder above the workspace, up to `/` (the workspace's own stay its own). */
export function ancestorInstructionPaths(workspace: string): string[] {
  const out: string[] = [];
  let dir = dirname(real(workspace));
  for (;;) {
    for (const f of ANCESTOR_INSTRUCTION_FILES) out.push(join(dir, f));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** Binaries that hand a command to launchd/LaunchServices/AppleScript, i.e. run it unsandboxed. */
const ESCAPE_BINARIES = ['/bin/launchctl', '/usr/bin/open', '/usr/bin/osascript'];
/** LaunchServices' mach services (open an app, a URL or a file): denied, whatever binary asks */
const LAUNCH_SERVICES = [
  'global-name "com.apple.coreservices.launchservicesd"',
  'global-name-prefix "com.apple.lsd."',
];

/**
 * macOS Seatbelt profile: allow by default, deny data reads/writes in the private trees, re-allow reads (never
 * writes) of `readable` install folders, re-allow the workspace. `readable` must come from `readablePaths`.
 * Every keychain file stays denied, the login keychain too: it holds every app's items (the vault master key among
 * them) and the sandbox can only allow by file, so a CLI's own login is read outside it (the Claude adapter's
 * `sandboxLoginEnv`).
 */
export function seatbeltProfile(
  pasabotHome: string,
  workspace: string,
  readable: string[] = [],
  writable: string[] = [],
): string {
  const deny = [real(pasabotHome), ...privatePaths().map(real)];
  const ws = real(workspace);
  // ScreenHelper.swift `canonicalHome`: the user database's home, not $HOME
  const helperHome = join(userInfo().homedir, '.pasabot');
  const personal = [
    ...personalAgentPaths().map(real),
    ...foreignStateFolders(writable),
    ...ancestorInstructionPaths(workspace),
  ];
  return [
    '(version 1)',
    '(allow default)',
    ...deny.map((p) => `(deny file-read-data file-write* (subpath ${sbString(p)}))`),
    // clean agents: the user's personal agent setup, other brains' state folders and instruction files above the
    // workspace; only this turn's CLI sign-in file stays usable (linked from the adapter's clean home; a CLI
    // refreshes its login in place), and a CLI install folder inside one of these trees stays readable and runnable
    ...personal.map((p) => `(deny file-read-data file-write* (subpath ${sbString(p)}))`),
    ...turnLoginFiles(writable).map((p) => `(allow file-read-data file-write* (literal ${sbString(p)}))`),
    ...cliDirs()
      .filter((d) => personal.some((p) => inside(d, p)))
      .map((p) => `(allow file-read-data (subpath ${sbString(p)}))`),
    // no way out through launchd or LaunchServices: those would run a command outside this sandbox. The binaries
    // by path, and LaunchServices itself (a copied `open`, or NSWorkspace from python3/swift, reaches it otherwise):
    // an app it launches is its own responsible process, e.g. PasaBot Screen Helper with the owner's permissions
    ...ESCAPE_BINARIES.map((b) => `(deny process-exec (literal ${sbString(b)}))`),
    '(deny lsopen)',
    ...LAUNCH_SERVICES.map((n) => `(deny mach-lookup (${n}))`),
    // the Screen Helper's one trusted folder, even when $PASABOT_HOME is elsewhere: no key or link planted there
    `(deny file-read-data file-write* (subpath ${sbString(join(helperHome, 'run'))}))`,
    `(deny file-write* (literal ${sbString(helperHome)}))`,
    `(deny file-write* (subpath ${sbString(join(homedir(), 'Library', 'LaunchAgents'))}))`,
    // CLI folders: the server runs what it finds there outside any sandbox (brain detection), so every folder on
    // its CLI search path is read-only to the agent, and the folders above them cannot be renamed or replaced
    ...cliDirs().map((p) => `(deny file-write* (subpath ${sbString(p)}))`),
    ...cliSearchDirAncestors(cliDirs()).map((p) => `(deny file-write* (literal ${sbString(p)}))`),
    // a module's install folder (e.g. a registry-installed ACP agent): readable and runnable, still never writable
    ...readable.map((p) => `(allow file-read-data (subpath ${sbString(p)}))`),
    // later rules win in Seatbelt: the agent's own workspace stays readable and writable
    `(allow file-read-data file-write* (subpath ${sbString(ws)}))`,
  ].join('\n');
}

/** Per-user runtime dirs holding the D-Bus and systemd sockets. */
function runtimeDirs(): string[] {
  const uid = process.getuid?.();
  return [process.env.XDG_RUNTIME_DIR, uid === undefined ? undefined : `/run/user/${uid}`]
    .filter((p): p is string => !!p && existsSync(p))
    .map(real)
    .filter((p, i, a) => a.indexOf(p) === i);
}

/**
 * Folders the server searches for brain CLIs and runs unsandboxed (`detect`): the per-user install folders (even
 * when they do not exist yet, so a planted one cannot appear later) and every folder on the server's CLI search
 * path (PATH, Homebrew, the running Node's folder). Symlink-resolved, deduplicated.
 */
export function cliDirs(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const p of [...userCliDirs().map(real), ...cliSearchDirs(env)]) if (!out.includes(p)) out.push(p);
  return out;
}

const inside = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Existing real paths the CLI may write outside its workspace (CommandWrapper `writable`). A path inside a
 * protected tree ($PASABOT_HOME, the pasabot CLI credential folder, ~/.ssh, keychains, browser profiles), or one
 * containing such a tree, is refused.
 */
export function writablePaths(o: { home: string; workspace: string }, writable: string[] = []): string[] {
  const protectedTrees = [real(o.home), ...privatePaths().map(real), ...cliDirs()];
  const out: string[] = [];
  for (const w of writable) {
    if (!w || !existsSync(w)) continue;
    const p = real(w);
    if (
      protectedTrees.some((t) => inside(p, t) || inside(t, p)) ||
      cliSearchDirAncestors(cliDirs()).includes(p)
    )
      throw new RunnerUnavailableError(`refusing to make "${w}" writable: it is inside a protected path`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Existing real paths the CLI may read and execute but never write (CommandWrapper `readable`): only a folder
 * below a module's data dir, `$PASABOT_HOME/modules/<module id>/<sub>/...` (e.g. the ACP registry's
 * `agents/<id>`). Anything else (the module dir itself, the db, the vault, workspaces, paths outside the home)
 * is refused.
 */
export function readablePaths(o: { home: string; workspace: string }, readable: string[] = []): string[] {
  const out: string[] = [];
  for (const r of readable) {
    if (!r || !existsSync(r)) continue;
    const p = real(r);
    const parts = relative(join(real(o.home), 'modules'), p).split(sep);
    if (parts.length < 2 || parts.some((x) => x === '' || x === '..'))
      throw new RunnerUnavailableError(
        `refusing to make "${r}" readable: only folders inside a module's data dir may be`,
      );
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** bubblewrap command line for `host` mode on Linux (exported for tests). */
export function bwrapArgs(
  o: { home: string; workspace: string },
  cmd: string,
  args: string[],
  writable: string[] = [],
  readable: string[] = [],
): string[] {
  const hide = [real(o.home), ...privatePaths().map(real)].filter((p) => existsSync(p));
  const ws = real(o.workspace);
  const w = writablePaths(o, writable);
  return [
    // own PID/IPC/UTS namespaces: /proc shows only the sandbox, never the server's environ or fds
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    ...hide.flatMap((p) => ['--tmpfs', p]),
    // no user D-Bus / systemd sockets (`systemd-run --user` would run outside the sandbox)
    ...runtimeDirs().flatMap((p) => ['--tmpfs', p]),
    // the CLI's own state folder (e.g. ~/.gemini): read-write, never inside a hidden tree (checked above)
    ...w.flatMap((p) => ['--bind', p, p]),
    // clean agents (after the binds above, so they win): the user's personal agent setup, other brains' state
    // folders and the instruction files above the workspace are hidden; this turn's CLI sign-in file is put back
    ...[
      ...personalAgentPaths().map(real),
      ...foreignStateFolders(writable),
      ...ancestorInstructionPaths(o.workspace),
    ]
      .filter((p) => existsSync(p))
      .flatMap((p) => (statSync(p).isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p])),
    ...turnLoginFiles(w)
      .filter((p) => existsSync(p))
      .flatMap((p) => ['--bind', p, p]),
    // a module's install folder inside the hidden home: read-only (checked above)
    ...readablePaths(o, readable).flatMap((p) => ['--ro-bind', p, p]),
    '--bind',
    ws,
    ws,
    '--chdir',
    ws,
    '--die-with-parent',
    '--new-session',
    '--',
    cmd,
    ...args,
  ];
}

let bwrapOk: boolean | undefined;
const hasWorkingBwrap = () => {
  if (bwrapOk === undefined) {
    try {
      execFileSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], {
        stdio: 'ignore',
        timeout: 5000,
      });
      bwrapOk = true;
    } catch {
      bwrapOk = false;
    }
  }
  return bwrapOk;
};

/**
 * One-line startup warning for macOS host mode (ARCHITECTURE 10, Known limitations): the vault master key sits in
 * the login keychain, which an unsandboxed agent that runs /usr/bin/security can read (the `host` sandbox denies
 * every keychain file; the Claude CLI's own login is handed in from outside). null where this does not apply.
 */
export function hostModeWarning(mode: RunnerMode, platform = process.platform): string | null {
  if (mode === 'host-unsandboxed' && platform !== 'darwin')
    return (
      `${platform === 'win32' ? 'Windows' : 'host-unsandboxed'}: no OS sandbox for agents here; an agent can read and ` +
      'change everything this user can (files, browser data, the vault key through DPAPI). New helpers ask before ' +
      'anything outside their folder; run only agents you trust (hardened: Docker or WSL with Linux `host` mode)'
    );
  if (platform !== 'darwin' || (mode !== 'host' && mode !== 'host-unsandboxed')) return null;
  return (
    'macOS host mode: an agent allowed to run /usr/bin/security can read the vault master key from the login ' +
    'keychain; run only agents you trust here (hardened: Linux `user` mode or Docker)'
  );
}

/**
 * Why the Linux `host` sandbox cannot run, for a plain card instead of a crash message on every turn: bubblewrap is
 * not installed, or the kernel refuses unprivileged user namespaces (stock Ubuntu 23.10+ AppArmor), or something
 * else. null when it works or on other platforms.
 */
export function linuxSandboxProblem(
  o: {
    platform?: NodeJS.Platform;
    works?: () => boolean;
    hasBwrap?: () => boolean;
    readSysctl?: (p: string) => string | null;
  } = {},
): 'missing' | 'userns' | 'other' | null {
  if ((o.platform ?? process.platform) !== 'linux') return null;
  if ((o.works ?? hasWorkingBwrap)()) return null;
  const has = o.hasBwrap ?? (() => findCli('bwrap') !== null);
  if (!has()) return 'missing';
  const read =
    o.readSysctl ??
    ((p: string) => {
      try {
        return readFileSync(p, 'utf8').trim();
      } catch {
        return null;
      }
    });
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') return 'userns';
  if (read('/proc/sys/kernel/unprivileged_userns_clone') === '0') return 'userns';
  return 'other';
}

/** Whether the OS sandbox for `host` mode can run on this machine. */
export function hostSandboxAvailable(platform = process.platform): boolean {
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec');
  if (platform === 'linux') return hasWorkingBwrap();
  return false;
}

export function createSandbox(
  mode: RunnerMode,
  o: { home: string; workspace: string },
): CommandWrapper | undefined {
  if (mode === 'host-unsandboxed') return undefined;
  if (mode === 'user' || mode === 'container') {
    return () => {
      throw new RunnerUnavailableError(
        `runner mode "${mode}" is not available in this build yet (W20 packaging)`,
      );
    };
  }
  if (process.platform === 'darwin') {
    const profile = seatbeltProfile(o.home, o.workspace);
    return (cmd, args, opts) => {
      // Seatbelt allows writes outside the denied trees already; a writable path inside one is refused. The turn's
      // writable paths also pick the one sign-in file and the brain state folder this turn may use
      writablePaths(o, opts?.writable);
      const writable = opts?.writable ?? [];
      const readable = readablePaths(o, opts?.readable);
      const p =
        readable.length || writable.length
          ? seatbeltProfile(o.home, o.workspace, readable, writable)
          : profile;
      return { cmd: '/usr/bin/sandbox-exec', args: ['-p', p, cmd, ...args] };
    };
  }
  if (process.platform === 'linux') {
    return (cmd, args, opts) => {
      if (!hasWorkingBwrap())
        throw new RunnerUnavailableError(
          linuxSandboxProblem() === 'userns'
            ? 'the helper sandbox cannot start: this Linux blocks user namespaces for bubblewrap (see the card on the home screen)'
            : 'host mode needs bubblewrap (bwrap) with user namespaces on Linux (see the card on the home screen)',
        );
      return { cmd: 'bwrap', args: bwrapArgs(o, cmd, args, opts?.writable, opts?.readable) };
    };
  }
  return () => {
    throw new RunnerUnavailableError(
      process.platform === 'win32'
        ? 'PasaBot has no helper sandbox on Windows yet; unset PASABOT_RUNNER to run helpers without one (the home screen explains what that means)'
        : `host sandbox is not supported on ${process.platform}`,
    );
  };
}

/** Scrubbed environment for agent CLIs: only declared variables pass (8, "Secret leakage"). */
export function scrubbedEnv(
  extra: Record<string, string> = {},
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // Windows: SystemRoot (sockets), TEMP, APPDATA, PATHEXT and the rest a program needs to start; none is a secret
  const out: Record<string, string> = { ...windowsEnv(env, platform) };
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'TZ']) {
    if (env[k]) out[k] = env[k]!;
  }
  if (platform === 'win32' && !out.PATH && env.Path) out.PATH = env.Path;
  // a server started by launchd/systemd/the desktop app has a bare PATH: the usual CLI install folders follow it
  out.PATH = cliSearchPath(env);
  return { ...out, ...extra };
}
