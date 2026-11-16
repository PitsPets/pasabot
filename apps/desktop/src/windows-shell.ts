#!/usr/bin/env node
/**
 * The Windows shell's own steps, run by the bundled node.exe (signed by its publisher) and nothing else, so PasaBot
 * starts, stops, makes its folder links and uninstalls on a PC whose application control (Smart App Control, App
 * Control for Business) runs unsigned PowerShell in Constrained Language Mode, where the tray's WinForms cannot load.
 *   windows-shell.js start [--no-open]   Start menu / desktop shortcut / PasaBot.cmd: the tray when PowerShell can run
 *                                        it (Full Language), else the launcher alone (its window, no tray icon)
 *   windows-shell.js stop                "Stop PasaBot": asks the running launcher to quit; forced after 20 s
 *   windows-shell.js links [--check|--remove]   the installed copy's folder links (was links.ps1)
 *   windows-shell.js uninstall           the uninstaller's first step: stop, then remove the links
 * The starter itself is a console program started minimized; it starts the real work hidden and detached, then exits.
 * Only node: built-ins and this package's own plain modules: it runs before the workspace links exist.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, commandOf, readLock, windowsPowerShell } from './instance.js';

/** the install folder's layout, from where this file sits (<install>\pasabot\apps\desktop\dist\windows-shell.js) */
export function installLayout(self: string) {
  const dist = win32.dirname(self);
  const install = win32.resolve(dist, '..', '..', '..', '..');
  const root = win32.join(install, 'pasabot');
  return {
    install,
    root,
    node: win32.join(install, 'node.exe'),
    launcher: win32.join(dist, 'main.js'),
    payload: win32.join(install, 'payload.json'),
    app: win32.join(install, 'PasaBot.cmd'),
    tray: win32.join(install, 'PasaBotTray.ps1'),
    links: win32.join(install, 'links.json'),
  };
}
export type Layout = ReturnType<typeof installLayout>;

export const dataHome = (env: NodeJS.ProcessEnv = process.env, home = homedir()) =>
  resolve(env.PASABOT_HOME || win32.join(env.USERPROFILE || home, '.pasabot'));

/** a plain language tag (any `-u-` extension dropped), or null (the launcher then uses its default) */
export function localeTag(tag: string | undefined | null): string | null {
  const plain = tag?.split('-u-')[0];
  return plain && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(plain) ? plain : null;
}

/**
 * The tray asks PowerShell for WinForms, which only a script in Full Language mode may load. `PasaBotTray.ps1
 * -Probe` exits 0 there and 3 in Constrained Language Mode (an application control policy that does not trust the
 * script), 4 when WinForms will not load; anything else (no PowerShell, a blocked script, a timeout) is also "no tray".
 */
export const TRAY_PROBE_EXIT = { ok: 0, constrained: 3, noWinForms: 4 } as const;

export function trayArgs(l: Layout, probe: boolean, noOpen = false): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    l.tray,
    ...(probe ? ['-Probe'] : []),
    ...(noOpen ? ['-NoOpen'] : []),
  ];
}

export type TrayState = 'tray' | 'constrained' | 'no-winforms' | 'no-powershell';

export function trayStateOf(r: { status: number | null; error?: unknown }): TrayState {
  if (r.error || r.status === null) return 'no-powershell';
  if (r.status === TRAY_PROBE_EXIT.ok) return 'tray';
  if (r.status === TRAY_PROBE_EXIT.noWinForms) return 'no-winforms';
  return 'constrained';
}

export interface ShellDeps {
  env: NodeJS.ProcessEnv;
  probe(cmd: string, args: string[]): { status: number | null; error?: unknown };
  /** start a program hidden and detached, its output to `logFile` (or nowhere); never through a shell */
  launch(cmd: string, args: string[], cwd: string, logFile: string | null): void;
  locale(): string | null;
}

const realDeps: ShellDeps = {
  env: process.env,
  probe: (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    return { status: r.status, error: r.error };
  },
  launch: (cmd, args, cwd, logFile) => {
    let err: number | 'ignore' = 'ignore';
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        err = openSync(logFile, 'a');
      } catch {
        err = 'ignore';
      }
    }
    const c = spawn(cmd, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', err] });
    c.unref();
  },
  locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
};

/** the launcher's arguments when it runs without the tray: it opens its own window and keeps running on its own */
export function launcherAlone(l: Layout, locale: string | null, noOpen = false): string[] {
  return [
    l.launcher,
    '--payload',
    l.payload,
    '--app',
    l.app,
    '--open-urls',
    '--app-window',
    '--no-stdin',
    ...(locale ? ['--locale', locale] : []),
    ...(noOpen ? ['--no-browser'] : []),
  ];
}

/** `start`: the tray when it can run here, else the launcher alone; returns what it started */
export function start(l: Layout, noOpen: boolean, deps: ShellDeps = realDeps): TrayState {
  const ps = windowsPowerShell(deps.env);
  const state = trayStateOf(deps.probe(ps, trayArgs(l, true)));
  if (state === 'tray') deps.launch(ps, trayArgs(l, false, noOpen), l.install, null);
  else
    deps.launch(
      l.node,
      launcherAlone(l, localeTag(deps.locale()), noOpen),
      l.install,
      win32.join(dataHome(deps.env), 'logs', 'desktop.log'),
    );
  return state;
}

/** the file a `stop` writes and the running launcher watches (in the data folder: only this user can write it) */
export const stopRequestPath = (home: string) => resolve(home, 'run', 'desktop.stop');

/**
 * The launcher side of `stop`, Windows only (no signals there): polls for the request every second and calls
 * `onStop` once when one names this launcher's pid (an old file naming another pid is removed and ignored).
 */
export function watchStopRequest(home: string, pid: number, onStop: () => void, everyMs = 1000): () => void {
  const file = stopRequestPath(home);
  let done = false;
  const tick = () => {
    if (done || !existsSync(file)) return;
    let named = Number.NaN;
    try {
      named = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    } catch {
      return;
    }
    rmSync(file, { force: true });
    if (named !== pid) return;
    done = true;
    clearInterval(timer);
    onStop();
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
}

export interface StopDeps {
  alive(pid: number): boolean;
  commandOf(pid: number): string | null;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
}

const realStopDeps: StopDeps = {
  alive,
  commandOf: (pid) => commandOf(pid),
  kill: (pid) => {
    spawnSync(
      win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 30_000,
      },
    );
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * `stop`: asks this install's running launcher to quit (it stops the server cleanly and closes the tray), and ends
 * the process tree only when it has not quit after `graceMs` AND its command line was read and names this install's
 * launcher. A lock held by another install's launcher, or by a pid that now runs something else, is left alone.
 * When the command line cannot be read (PowerShell blocked by policy, a timeout, odd output), the pid might be a
 * reused one, so it is never killed: the request file is the only ask, and `unknown` says it is still running.
 */
export async function stop(
  home: string,
  launcher: string,
  deps: StopDeps = realStopDeps,
  graceMs = 20_000,
): Promise<'not-running' | 'other-install' | 'stopped' | 'forced' | 'unknown'> {
  const lock = readLock(home);
  if (!lock || !deps.alive(lock.pid)) return 'not-running';
  const cmd = deps.commandOf(lock.pid);
  if (cmd !== null && !cmd.toLowerCase().includes(launcher.toLowerCase())) return 'other-install';
  mkdirSync(dirname(stopRequestPath(home)), { recursive: true });
  writeFileSync(stopRequestPath(home), String(lock.pid));
  for (let waited = 0; waited < graceMs; waited += 250) {
    if (!deps.alive(lock.pid)) return 'stopped';
    await deps.sleep(250);
  }
  // unknown is NOT ours: the request stays for a launcher that is only slow (one with another pid removes it)
  if (cmd === null) return 'unknown';
  deps.kill(lock.pid);
  rmSync(stopRequestPath(home), { force: true });
  return 'forced';
}

export interface LinkEntry {
  path: string;
  target: string;
}

/** a path inside `base` (never `base` itself, never through `..`), compared without regard to case */
export function inside(base: string, p: string): boolean {
  const full = win32.resolve(p).toLowerCase();
  return full.startsWith(`${win32.resolve(base).toLowerCase()}\\`);
}

export interface LinkFs {
  isLink(p: string): boolean;
  /** the link's target, absolute */
  linkTarget(p: string): string | null;
  exists(p: string): boolean;
  makeJunction(path: string, target: string): void;
  /** removes the link itself, never what it points to */
  removeLink(p: string): void;
}

const realLinkFs: LinkFs = {
  isLink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  linkTarget: (p) => {
    try {
      return readLinkTarget(p);
    } catch {
      return null;
    }
  },
  exists: (p) => existsSync(p),
  makeJunction: (path, target) => {
    mkdirSync(win32.dirname(path), { recursive: true });
    symlinkSync(target, path, 'junction');
  },
  removeLink: (p) => rmdirSync(p),
};

/** a junction reads back as an absolute path (Node strips the \??\ prefix) */
const readLinkTarget = (p: string) => win32.resolve(readlinkSync(p));

/**
 * The installed copy's folder links (pnpm's workspace links, which an installer cannot carry). build-windows.ps1
 * writes them down in links.json and removes them; this puts them back as directory junctions (no admin rights, no
 * Developer Mode). A link is only ever made inside the install's `pasabot` folder, to a folder inside it.
 */
export function links(
  base: string,
  list: LinkEntry[],
  mode: 'make' | 'check' | 'remove',
  fs: LinkFs = realLinkFs,
): string[] {
  const problems: string[] = [];
  for (const l of list) {
    const path = win32.join(base, String(l.path));
    const target = win32.join(base, String(l.target));
    if (!inside(base, path) || !inside(base, target)) {
      problems.push(`refused (outside the install): ${l.path}`);
      continue;
    }
    if (mode === 'remove') {
      if (fs.isLink(path)) fs.removeLink(path);
      continue;
    }
    if (fs.isLink(path)) {
      const now = fs.linkTarget(path);
      if (now && win32.resolve(now).toLowerCase() === win32.resolve(target).toLowerCase()) continue;
      if (mode === 'check') {
        problems.push(`wrong link: ${l.path}`);
        continue;
      }
      fs.removeLink(path);
    } else if (fs.exists(path)) {
      problems.push(`in the way (not a link): ${l.path}`);
      continue;
    }
    if (mode === 'check') {
      problems.push(`missing link: ${l.path}`);
      continue;
    }
    if (!fs.exists(target)) {
      problems.push(`missing target: ${l.target}`);
      continue;
    }
    fs.makeJunction(path, target);
  }
  return problems;
}

export function readLinks(file: string): LinkEntry[] | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return arr.filter(
    (x): x is LinkEntry =>
      !!x && typeof (x as LinkEntry).path === 'string' && typeof (x as LinkEntry).target === 'string',
  );
}

const UNKNOWN_STOP =
  'PasaBot was asked to quit and is still running. Windows did not say which program that process is, so it was not ended. Quit PasaBot from its window (Settings) or sign out, then try again.';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const l = installLayout(fileURLToPath(import.meta.url));
  const home = dataHome();
  const runLinks = (mode: 'make' | 'check' | 'remove') => {
    const list = readLinks(l.links);
    if (!list) return mode === 'check' ? 1 : 0;
    const problems = links(l.root, list, mode);
    for (const p of problems) process.stdout.write(`${p}\n`);
    return problems.length ? 1 : 0;
  };
  switch (cmd) {
    case 'start':
      start(l, rest.includes('--no-open'));
      return 0;
    case 'stop': {
      const r = await stop(home, l.launcher);
      process.stdout.write(`${r}\n`);
      if (r !== 'unknown') return 0;
      process.stderr.write(`${UNKNOWN_STOP}\n`);
      return 1;
    }
    case 'links':
      return runLinks(rest.includes('--check') ? 'check' : rest.includes('--remove') ? 'remove' : 'make');
    case 'uninstall':
      if ((await stop(home, l.launcher)) === 'unknown') process.stderr.write(`${UNKNOWN_STOP}\n`);
      return runLinks('remove');
    default:
      process.stderr.write(
        'usage: windows-shell.js start [--no-open] | stop | links [--check|--remove] | uninstall\n',
      );
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`windows-shell: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
