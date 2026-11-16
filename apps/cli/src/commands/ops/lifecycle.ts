/**
 * Start/stop/restart/status for whichever manager runs PasaBot: launchd (macOS), systemd (user or system), or a
 * detached process with a pid file when no service is installed. Service managers are called by name from PATH.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  effectiveSettings,
  ensurePrivateDir,
  installedManager,
  installRoot,
  LAUNCHD_LABEL,
  launchdPlistPath,
  logFilePath,
  type Manager,
  type OpsCtx,
  pidFilePath,
  runTool,
  SERVER_ENTRY_TAIL,
  SYSTEMD_UNIT,
  serverEntry,
  uid,
} from './shared.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const systemctl = (ctx: OpsCtx, m: Manager, args: string[]) =>
  runTool(ctx, 'systemctl', m === 'systemd-user' ? ['--user', ...args] : args);

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The pid file holds the pid and the server entry it was started with (`<pid>\n<entry>\n`). The process is ours only
 * while its command line still contains that recorded entry (guards against pid reuse), whatever the install root
 * is now: `pasabot update` switching `<prefix>/current` must not orphan a server started from a checkout. A one-line
 * pid file from an older CLI is matched on the server entry's tail.
 */
function readPidFile(ctx: OpsCtx): { pid: number; entry: string | null } | null {
  let text: string;
  try {
    text = readFileSync(pidFilePath(ctx), 'utf8');
  } catch {
    return null;
  }
  const [first, second] = text.split('\n');
  const pid = Number(first?.trim());
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return { pid, entry: second?.trim() || null };
}

function ours(ctx: OpsCtx): { pid: number; entry: string | null } | null {
  const rec = readPidFile(ctx);
  if (!rec || !alive(rec.pid)) return null;
  const ps = runTool(ctx, 'ps', ['-p', String(rec.pid), '-o', 'command=']);
  if (ps.status === 0 && !ps.stdout.includes(rec.entry ?? SERVER_ENTRY_TAIL)) return null;
  return rec;
}

/** The pid in the pid file, only when that process is still our server. */
export function runningPid(ctx: OpsCtx): number | null {
  return ours(ctx)?.pid ?? null;
}

/** The entry path the running background server was started with (null when none is running). */
export function runningEntry(ctx: OpsCtx): string | null {
  return ours(ctx)?.entry ?? null;
}

export interface ServiceState {
  manager: Manager;
  running: boolean;
  detail: string;
}

export function serviceState(ctx: OpsCtx): ServiceState {
  const manager = installedManager(ctx);
  if (manager === 'launchd') {
    const r = runTool(ctx, 'launchctl', ['print', `gui/${uid()}/${LAUNCHD_LABEL}`]);
    const running = r.status === 0 && /state = running/.test(r.stdout);
    return { manager, running, detail: r.status === 0 ? 'loaded' : 'not loaded' };
  }
  if (manager === 'systemd-user' || manager === 'systemd-system') {
    const r = systemctl(ctx, manager, ['is-active', SYSTEMD_UNIT]);
    return { manager, running: r.stdout.trim() === 'active', detail: r.stdout.trim() || 'unknown' };
  }
  const pid = runningPid(ctx);
  return { manager, running: pid !== null, detail: pid ? `pid ${pid}` : 'not running' };
}

function check(r: { status: number; stderr: string }, what: string) {
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
}

export async function startServer(ctx: OpsCtx): Promise<string> {
  const m = installedManager(ctx);
  if (m === 'launchd') {
    const target = `gui/${uid()}`;
    const loaded = runTool(ctx, 'launchctl', ['print', `${target}/${LAUNCHD_LABEL}`]).status === 0;
    check(
      loaded
        ? runTool(ctx, 'launchctl', ['kickstart', `${target}/${LAUNCHD_LABEL}`])
        : runTool(ctx, 'launchctl', ['bootstrap', target, launchdPlistPath(ctx)]),
      'launchctl',
    );
    return 'started (launchd)';
  }
  if (m !== 'process') {
    check(systemctl(ctx, m, ['start', SYSTEMD_UNIT]), 'systemctl start');
    return `started (${m})`;
  }
  const existing = runningPid(ctx);
  if (existing) return `already running (pid ${existing})`;
  const root = installRoot(ctx);
  if (!root || !existsSync(serverEntry(root)))
    throw new Error('server build not found; run `pnpm build` or install a release with `pasabot update`');
  const log = logFilePath(ctx);
  ensurePrivateDir(dirname(log));
  ensurePrivateDir(dirname(pidFilePath(ctx)));
  const fd = openSync(log, 'a', 0o600);
  const entry = serverEntry(root);
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...ctx.env, ...effectiveSettings(ctx) },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  if (!child.pid) throw new Error('could not start the server process');
  writeFileSync(pidFilePath(ctx), `${child.pid}\n${entry}\n`, { mode: 0o600 });
  child.unref();
  // a server that dies at once (bad config, port taken) is reported here, not left as a stale pid file
  await sleep(500);
  if (!alive(child.pid)) {
    rmSync(pidFilePath(ctx), { force: true });
    throw new Error(`the server exited at start; see ${log} (\`pasabot logs\`)`);
  }
  return `started (pid ${child.pid}, logs in ${log})`;
}

export async function stopServer(ctx: OpsCtx): Promise<string> {
  const m = installedManager(ctx);
  if (m === 'launchd') {
    const r = runTool(ctx, 'launchctl', ['bootout', `gui/${uid()}/${LAUNCHD_LABEL}`]);
    // bootout of a service that is not loaded is not an error for `stop`
    if (r.status !== 0 && !/No such process|Could not find|not find service/i.test(r.stderr))
      check(r, 'launchctl bootout');
    return 'stopped (launchd)';
  }
  if (m !== 'process') {
    check(systemctl(ctx, m, ['stop', SYSTEMD_UNIT]), 'systemctl stop');
    return `stopped (${m})`;
  }
  const pid = runningPid(ctx);
  if (!pid) {
    rmSync(pidFilePath(ctx), { force: true });
    return 'not running';
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
  rmSync(pidFilePath(ctx), { force: true });
  return `stopped (pid ${pid})`;
}

export async function restartServer(ctx: OpsCtx): Promise<string> {
  const m = installedManager(ctx);
  if (m === 'launchd') {
    const target = `gui/${uid()}/${LAUNCHD_LABEL}`;
    if (runTool(ctx, 'launchctl', ['print', target]).status !== 0) return startServer(ctx);
    check(runTool(ctx, 'launchctl', ['kickstart', '-k', target]), 'launchctl kickstart');
    return 'restarted (launchd)';
  }
  if (m !== 'process') {
    check(systemctl(ctx, m, ['restart', SYSTEMD_UNIT]), 'systemctl restart');
    return `restarted (${m})`;
  }
  await stopServer(ctx);
  return startServer(ctx);
}
