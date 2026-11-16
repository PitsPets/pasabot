/**
 * Windows parity for running brain CLIs and other child programs. Three things POSIX code takes for granted are
 * different there, and each one silently broke an agent turn or the kill switch:
 *
 *   - Environment: Windows programs need `SystemRoot` (sockets fail without it: WSAStartup error 10106), `TEMP`,
 *     `APPDATA`, `PATHEXT` and a few more. A scrubbed environment keeps them (`windowsEnv`), still nothing secret.
 *   - Stopping: there are no process groups and no `kill(-pid)`. `killTree` runs `taskkill /PID <pid> /T /F` (an
 *     argument array, no shell). Children are also started *not* detached on Windows (`detachedGroup`), so Node puts
 *     them in its kill-on-close job object: when the server dies, its direct children die with it.
 *   - npm's `.cmd` shims: since Node 18.20.2 / 20.12.2 (CVE-2024-27980) a `.cmd` or `.bat` cannot be started without
 *     a shell, and going through cmd.exe cuts multi-line arguments (a system prompt) and re-reads `&`, `|`, `%`. So a
 *     shim is never run: `spawnTarget` reads which script or program it would start and starts that directly. A
 *     `.cmd` it cannot read that way is refused, never handed to cmd.exe.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { findCli } from './cli-path.js';

/** Variables a Windows program needs to start and reach the network; none of them holds a secret. */
export const WINDOWS_ENV_KEYS = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
] as const;

/**
 * The Windows-only variables from `env` (looked up case-insensitively, as Windows does), for a scrubbed child
 * environment. Empty on any other platform, so POSIX environments stay exactly as they were.
 */
export function windowsEnv(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform !== 'win32') return {};
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') byLower.set(k.toLowerCase(), v);
  const out: Record<string, string> = {};
  for (const k of WINDOWS_ENV_KEYS) {
    const v = byLower.get(k.toLowerCase());
    if (v) out[k] = v;
  }
  return out;
}

/** Windows PowerShell 5.1 by its full path (never whatever PATH finds first). */
export const windowsPowerShellPath = (env: Record<string, string | undefined> = process.env) =>
  `${env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** `detached` for a child that must be stopped as a whole tree: its own process group on POSIX; on Windows not
 * detached, so it stays in Node's kill-on-close job (a dead server takes it down) and keeps no console of its own. */
export const detachedGroup = (platform: NodeJS.Platform = process.platform) => platform !== 'win32';

export type ExecFileLike = (
  cmd: string,
  args: string[],
  opts: { windowsHide: boolean; timeout: number },
  cb: (err: Error | null) => void,
) => unknown;

/**
 * Stops a child and everything it started. POSIX: the signal to its process group (it was started detached), else to
 * the process itself. Windows: `taskkill /PID <pid> /T /F`, which ends the whole tree at once (there is no gentle
 * signal for a console program there, so `sig` is not used). Never throws: an already-gone process is fine.
 */
export function killTree(
  pid: number | undefined,
  sig: NodeJS.Signals = 'SIGTERM',
  o: { platform?: NodeJS.Platform; execFile?: ExecFileLike; group?: boolean } = {},
): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') {
    const run = o.execFile ?? (execFile as unknown as ExecFileLike);
    try {
      run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => {});
    } catch {
      /* taskkill missing: nothing else can end the tree */
    }
    return;
  }
  try {
    process.kill(o.group === false ? pid : -pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/**
 * `killTree` for a child this code started and still holds. POSIX: exactly `killTree` (the group outlives its leader,
 * and its id cannot be reused while any member lives, so a late SIGKILL still ends orphaned grandchildren). Windows:
 * at most one taskkill, and none once the child has exited: the first one is already /F, and Windows hands a freed
 * pid to new processes quickly, so a second taskkill /T after the grace could end someone else's process tree.
 */
export function childTreeKiller(
  child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null },
  o: { platform?: NodeJS.Platform; execFile?: ExecFileLike } = {},
): (sig: NodeJS.Signals) => void {
  const platform = o.platform ?? process.platform;
  let sent = false;
  return (sig) => {
    if (platform !== 'win32') return killTree(child.pid, sig, o);
    if (sent || child.exitCode !== null || child.signalCode !== null) return;
    sent = true;
    killTree(child.pid, sig, o);
  };
}

export class UnsafeCommandError extends Error {}

export interface SpawnTargetDeps {
  platform?: NodeJS.Platform;
  /** reads a shim (default: the file, as text) */
  read?: (path: string) => string;
  exists?: (path: string) => boolean;
  /** the Node that runs a JavaScript entry when the shim has no node.exe beside it (default: this Node) */
  node?: string;
}

/** The script or program an npm/pnpm/yarn `.cmd` shim starts: `"%dp0%\...\cli.js" %*` (npm), `"%~dp0\..\cli.js" %*` (pnpm). */
const SHIM_TARGET = /"%~?dp0%?\\?([^"%\r\n]+)"\s*%\*/g;

/**
 * npm's own `npx.cmd` / `npm.cmd` (shipped next to node.exe by the Node.js installer, and copied to %APPDATA%\npm by
 * `npm i -g npm`) name their script through a variable set earlier: the last line is `"%NODE_EXE%" "%NPX_CLI_JS%" %*`.
 * That variable is `%~dp0\node_modules\npm\bin\npx-cli.js` (or `npm-cli.js`), so PasaBot starts that file with node.
 * (The shim can also switch to a newer npm under the global prefix; the bundled one next to the shim is used here.)
 */
const NPM_OWN_SHIM = /^\s*"%NODE_EXE%"\s+"%(NPX|NPM)_CLI_JS%"\s+%\*\s*$/im;

/**
 * What to start for `cmd args` without a shell. On POSIX and for a Windows `.exe`, the same. For a Windows `.cmd` or
 * `.bat` shim: the program or JavaScript file it would start (with the shim's own node.exe, else this Node), with the
 * same arguments. A shim that names anything else, or no target at all, is refused (`UnsafeCommandError`): it is never
 * run through cmd.exe. An argument with a NUL character cannot be passed to any Windows program and is refused too.
 */
export function spawnTarget(
  cmd: string,
  args: string[],
  d: SpawnTargetDeps = {},
): { cmd: string; args: string[] } {
  const platform = d.platform ?? process.platform;
  if (platform !== 'win32') return { cmd, args };
  if (args.some((a) => a.includes('\0')))
    throw new UnsafeCommandError('an argument has a NUL character: it cannot be passed on Windows');
  const ext = win32.extname(cmd).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { cmd, args };
  const read = d.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = d.exists ?? existsSync;
  let text: string;
  try {
    text = read(cmd);
  } catch {
    throw new UnsafeCommandError(`cannot read ${win32.basename(cmd)} to start it without a shell`);
  }
  const dir = win32.dirname(cmd);
  const own = NPM_OWN_SHIM.exec(text);
  if (own) {
    const script = win32.join(
      dir,
      'node_modules',
      'npm',
      'bin',
      own[1] === 'NPX' ? 'npx-cli.js' : 'npm-cli.js',
    );
    if (!exists(script))
      throw new UnsafeCommandError(`${win32.basename(cmd)} is missing npm's own script next to it`);
    const local = win32.join(dir, 'node.exe');
    const node = exists(local) ? local : (d.node ?? process.execPath);
    return { cmd: node, args: [script, ...args] };
  }
  let target: string | null = null;
  for (const m of text.matchAll(SHIM_TARGET)) target = m[1] ?? null;
  if (!target)
    throw new UnsafeCommandError(
      `${win32.basename(cmd)} is a script PasaBot cannot start safely (it would need cmd.exe)`,
    );
  const full = win32.resolve(dir, target);
  const tExt = win32.extname(full).toLowerCase();
  if (tExt === '.exe') return { cmd: full, args };
  if (tExt === '.js' || tExt === '.cjs' || tExt === '.mjs' || tExt === '') {
    const local = win32.join(dir, 'node.exe');
    const node = exists(local) ? local : (d.node ?? process.execPath);
    return { cmd: node, args: [full, ...args] };
  }
  throw new UnsafeCommandError(
    `${win32.basename(cmd)} starts ${win32.basename(full)}, which PasaBot does not run`,
  );
}

/**
 * `spawnTarget` for a command that may be a bare name: on Windows the name is first found on `path` (PATHEXT order,
 * `.exe` before `.cmd`), so a turn never goes through cmd.exe because a library resolved `claude` to `claude.cmd`
 * by itself. POSIX: unchanged.
 */
export function resolveForSpawn(
  cmd: string,
  args: string[],
  path: string | undefined,
  d: SpawnTargetDeps & { find?: (bin: string, path: string) => string | null } = {},
): { cmd: string; args: string[] } {
  const platform = d.platform ?? process.platform;
  if (platform !== 'win32') return { cmd, args };
  const find = d.find ?? ((b: string, p: string) => findCli(b, p, { platform }));
  const full = find(cmd, path ?? '') ?? cmd;
  return spawnTarget(full, args, d);
}
