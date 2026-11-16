/**
 * One desktop app per data dir. The lock is `$PASABOT_HOME/run/desktop.lock`, created with O_EXCL and holding
 * `{ pid, entry, url, serverPid }`. A lock whose pid is gone, or whose pid now runs something that is not our
 * launcher (pid reuse), is stale and taken over. A second copy learns the first one's URL; when the first one's shell
 * has a window (`show` in the lock) the second pokes it (SIGUSR2) so it brings that window up, else it opens the URL.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LockInfo {
  pid: number;
  /** the launcher entry file the holder runs (pid-reuse guard) */
  entry: string;
  url: string | null;
  serverPid: number | null;
  /** the holder's shell can show a window on request (a poke); older holders never set it, so are never poked */
  show?: boolean;
}

export interface InstanceDeps {
  alive(pid: number): boolean;
  /** the process's command line, or null when it cannot be read (then a live pid counts as ours) */
  commandOf(pid: number): string | null;
  /** ask a running holder to show its window; true when the request was delivered */
  poke?(pid: number): boolean;
}

/** SIGUSR2 (SIGUSR1 would start node's inspector); no signals on Windows, so no poke there */
export function poke(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(pid, 'SIGUSR2');
    return true;
  } catch {
    return false;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Windows PowerShell by its full path (never whatever PATH finds first) */
export const windowsPowerShell = (env: NodeJS.ProcessEnv = process.env) =>
  `${env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/**
 * the PowerShell that prints one process's command line as `pb:` and its UTF-16 code units in decimal, comma
 * separated (`pb:` alone when there is no such process): redirected console output is in the OEM code page
 * (437/850), which would turn C:\Users\Peña into "Pe?a", so the lock of a running launcher there would look stale;
 * digits are plain ASCII in any code page. Only a cmdlet, property reads and casts to core types: it runs the same in
 * Constrained Language Mode (an application control policy such as Smart App Control), where .NET method calls such
 * as [Convert]::ToBase64String are refused. Without the `pb:` mark the answer is unknown, never "no such process".
 */
export const windowsCommandLineScript = (pid: number) =>
  `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}"; $c = ''; if ($p -and $p.CommandLine) { $c = ([int[]][char[]][string]$p.CommandLine) -join ',' }; 'pb:' + $c`;

/** the command line from `windowsCommandLineScript`'s answer: '' for no such process, null when unreadable */
export function parseWindowsCommandLine(stdout: string): string | null {
  const m = /^pb:((?:\d{1,5})(?:,\d{1,5})*)?$/.exec(stdout.trim());
  if (!m) return null;
  if (!m[1]) return '';
  const units = m[1].split(',').map(Number);
  if (units.some((u) => u > 0xffff)) return null;
  let s = '';
  for (let i = 0; i < units.length; i += 4096) s += String.fromCharCode(...units.slice(i, i + 4096));
  return s;
}

export type SyncRunner = (cmd: string, args: string[]) => { status: number | null; stdout: string };
const runSync: SyncRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/**
 * The command line a pid runs, or null when it cannot be read. Windows: from WMI through PowerShell (`wmic` is
 * gone from Windows 11). Windows reuses small pids quickly, often right after a reboot, so without this a lock left
 * by a crash or power cut would point at some other program and every launch would say "already running".
 */
export function commandOf(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: SyncRunner = runSync,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const r = run(windowsPowerShell(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsCommandLineScript(pid),
    ]);
    // an empty answer: no such process (or one this user may not read, which is never our launcher)
    if (r.status !== 0) return null;
    return parseWindowsCommandLine(r.stdout);
  }
  const r = run('ps', ['-p', String(pid), '-o', 'command=']);
  return r.status === 0 ? r.stdout.trim() : null;
}

export const defaultInstanceDeps: InstanceDeps = { alive, commandOf: (pid) => commandOf(pid), poke };

export const lockPath = (home: string) => join(home, 'run', 'desktop.lock');

export function readLock(home: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(lockPath(home), 'utf8')) as Partial<LockInfo>;
    if (!Number.isInteger(v.pid) || (v.pid as number) <= 0 || typeof v.entry !== 'string') return null;
    return {
      pid: v.pid as number,
      entry: v.entry,
      url: typeof v.url === 'string' ? v.url : null,
      serverPid: Number.isInteger(v.serverPid) ? (v.serverPid as number) : null,
      show: v.show === true,
    };
  } catch {
    return null;
  }
}

export class InstanceLock {
  private info: LockInfo;
  private released = false;
  constructor(
    private readonly home: string,
    info: LockInfo,
  ) {
    this.info = info;
  }
  get path() {
    return lockPath(this.home);
  }
  update(patch: Partial<Pick<LockInfo, 'url' | 'serverPid'>>): void {
    if (this.released) return;
    this.info = { ...this.info, ...patch };
    writeFileSync(this.path, JSON.stringify(this.info), { mode: 0o600 });
  }
  /** removes the lock only while it is still ours */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (readLock(this.home)?.pid === this.info.pid) rmSync(this.path, { force: true });
  }
}

export type Acquired = { ok: true; lock: InstanceLock } | { ok: false; holder: LockInfo };

export function acquireInstance(
  home: string,
  entry: string,
  deps: InstanceDeps = defaultInstanceDeps,
  pid = process.pid,
  show = false,
): Acquired {
  mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid, entry, url: null, serverPid: null, show };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath(home), JSON.stringify(info), { flag: 'wx', mode: 0o600 });
      return { ok: true, lock: new InstanceLock(home, info) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = readLock(home);
    if (holder && holder.pid !== pid && deps.alive(holder.pid)) {
      const cmd = deps.commandOf(holder.pid);
      // case-insensitive too: Windows paths are, and a shell may spell the same file with other capitals
      if (
        cmd === null ||
        cmd.includes(holder.entry) ||
        cmd.toLowerCase().includes(holder.entry.toLowerCase())
      )
        return { ok: false, holder };
    }
    // stale (dead pid, reused pid, unreadable file, or our own leftover): take it over
    rmSync(lockPath(home), { force: true });
  }
  throw new Error(`could not take the desktop lock at ${lockPath(home)}`);
}
