#!/usr/bin/env node
/**
 * `pasabot-desktop`: the launcher process a tray shell runs. Wire: one JSON object per line. The shell writes
 * commands to stdin (`{"cmd":"stop-all"}`, see launcher.ts `Command`), the launcher writes events to stdout
 * (`status`, `open`, `setup-link`, `already-running`, `show`, `reveal`, `notice`, `bye`). When stdin closes (the shell quit or was killed)
 * the launcher stops the server and exits, so nothing is left running. `--no-stdin` keeps it up until SIGTERM
 * (a shell-less start, e.g. a Linux desktop entry) and `--open-urls` makes it open links itself (opener.ts; setup codes
 * are then hidden on stdout). `--window` says the shell can show a window: a second launch then pokes this launcher
 * (SIGUSR2) and it sends the shell `show`; with `--open-urls` a poke opens the app (a fresh setup link while
 * unclaimed) in the browser instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appWindowCommand } from './app-window.js';
import { type Command, Launcher, type ShellEvent } from './launcher.js';
import { createOpener, shellSink } from './opener.js';

const COMMANDS = new Set([
  'status',
  'start',
  'stop',
  'open',
  'stop-all',
  'logs',
  'autostart',
  'update-check',
  'check-now',
  'open-update',
  'setup-link',
  'quit',
]);

/**
 * One command line from the shell, or null. A leading byte-order mark is dropped: Windows PowerShell 5.1 (.NET
 * Framework) writes a child's stdin with the console's input code page and has no way to choose another
 * (ProcessStartInfo.StandardInputEncoding is .NET Core only), and under code page 65001 (UTF-8: GitHub's Windows
 * runners, or the "Beta: Use Unicode UTF-8" setting) that writer puts a BOM before the first line. JSON.parse refuses
 * a BOM, so the tray's or the self-test's first command was silently lost.
 */
export function parseCommand(line: string): Command | null {
  let v: unknown;
  try {
    v = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const c = v as { cmd?: unknown; on?: unknown };
  if (typeof c.cmd !== 'string' || !COMMANDS.has(c.cmd)) return null;
  if (c.cmd === 'autostart' || c.cmd === 'update-check') return { cmd: c.cmd, on: c.on === true };
  return { cmd: c.cmd } as Command;
}

function findWorkspaceRoot(start: string): string | null {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, 'pnpm-workspace.yaml')) || existsSync(join(d, 'apps', 'server', 'package.json')))
      return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      home: { type: 'string' },
      root: { type: 'string' },
      payload: { type: 'string' },
      node: { type: 'string' },
      'server-entry': { type: 'string' },
      dev: { type: 'boolean', default: false },
      app: { type: 'string' },
      locale: { type: 'string' },
      'no-browser': { type: 'boolean', default: false },
      'no-stdin': { type: 'boolean', default: false },
      'open-urls': { type: 'boolean', default: false },
      // with --open-urls on Windows and Linux: open PasaBot in its own app window (an installed Edge/Chrome/Chromium
      // in app mode, app-window.ts), the default browser only when there is none
      'app-window': { type: 'boolean', default: false },
      window: { type: 'boolean', default: false },
    },
    strict: true,
  });
  let payload: { root?: string; updateUrl?: string | null } = {};
  if (values.payload) {
    payload = JSON.parse(readFileSync(values.payload, 'utf8')) as typeof payload;
    if (payload.root && !isAbsolute(payload.root))
      payload.root = resolve(dirname(values.payload), payload.root);
  }
  const self = fileURLToPath(import.meta.url);
  const root = values.root ?? payload.root ?? findWorkspaceRoot(dirname(self));
  if (!root) throw new Error('no PasaBot install found; pass --root');
  const home = resolve(values.home ?? process.env.PASABOT_HOME ?? join(homedir(), '.pasabot'));
  const entry =
    values['server-entry'] ??
    join(root, 'apps', 'server', values.dev ? 'src' : 'dist', 'host', values.dev ? 'main.ts' : 'main.js');
  let version = '0.0.0';
  try {
    version = (
      JSON.parse(readFileSync(join(root, 'apps', 'server', 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    // unknown version: the update check then never claims one is newer by mistake (0.0.0 is the oldest)
  }

  let shellGone = false;
  // --open-urls: no shell reads stdout (the Linux starter appends it to a log), so links are opened here and setup
  // codes are hidden on the wire
  const appWindow = values['app-window']
    ? (url: string) => appWindowCommand(process.platform, url, { home, env: process.env })
    : undefined;
  const emit: (e: ShellEvent) => void = shellSink({
    selfOpens: values['open-urls'] === true,
    open: createOpener(process.platform, undefined, appWindow),
    write: (line) => {
      if (!shellGone) process.stdout.write(`${line}\n`);
    },
  });
  process.stdout.on('error', () => {
    shellGone = true;
    void launcher.quit().then(() => process.exit(0));
  });

  const launcher = new Launcher({
    home,
    entry: self,
    server: {
      node: values.node ?? process.execPath,
      entry,
      execArgv: values.dev ? ['--conditions=source', '--import', import.meta.resolve('tsx')] : [],
      env: process.env,
    },
    version,
    emit,
    locale: values.locale ?? process.env.LC_ALL ?? process.env.LANG ?? null,
    appPath: values.app ?? null,
    userHome: homedir(),
    updateUrl: payload.updateUrl ?? process.env.PASABOT_UPDATE_URL ?? null,
    openSetupLink: !values['no-browser'],
    canShow: values.window,
    opensUrls: values['open-urls'],
  });
  // before the lock is taken: SIGUSR2's default action would kill a launcher a second launch pokes
  if (process.platform !== 'win32') process.on('SIGUSR2', () => launcher.requestShow());

  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    void launcher.quit().then(() => process.exit(0));
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, exit);

  if (!values['no-stdin']) {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const c = parseCommand(line);
      if (!c) return;
      if (c.cmd === 'quit') return exit();
      void launcher.handle(c).catch((e: unknown) => {
        emit({ event: 'notice', text: e instanceof Error ? e.message : String(e) });
      });
    });
    rl.on('close', exit);
  }
  if (!(await launcher.init())) process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e: unknown) => {
    process.stderr.write(`pasabot-desktop: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
