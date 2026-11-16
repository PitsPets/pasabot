#!/usr/bin/env node
/**
 * "Check this computer" on Windows (W26 proof kit), run by the bundled node.exe: it needs no PowerShell of its own,
 * so it works where an application control policy (Smart App Control, App Control for Business) runs unsigned
 * PowerShell in Constrained Language Mode. It builds nothing and never touches your own PasaBot data: it starts the
 * installed launcher and server on free ports with a temporary data folder, checks each piece, stops everything,
 * deletes the folder and prints a PASS/FAIL table. A text report (no codes, keys or passwords) goes next to the
 * install; a failed run also keeps what the test run logged (codes hidden).
 *   Start menu > PasaBot > Check this computer        (or)
 *   "%LOCALAPPDATA%\Programs\PasaBot\node.exe" "%LOCALAPPDATA%\Programs\PasaBot\pasabot\apps\desktop\dist\selftest.js" [--pause]
 * windows\selftest.ps1 is a thin wrapper around this file (CI and older shortcuts call it).
 * A few checks read Windows' own state through PowerShell (access lists, window titles); where PowerShell refuses
 * them (Constrained Language Mode) they say SKIP and why, never FAIL.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appWindowCommand } from './app-window.js';
import { readLock, windowsPowerShell } from './instance.js';
import { installLayout, links, readLinks, stop, trayArgs, trayStateOf } from './windows-shell.js';

export type Result = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';
export interface Row {
  check: string;
  result: Result;
  detail: string;
}

/** never a setup code, session or password in the report or the logs file */
export function hideCodes(s: string): string {
  return s
    .replace(/token=[^&#\s"]+/g, 'token=<hidden>')
    .replace(/"(token|password|session|secret|key)"\s*:\s*"[^"]*"/g, '"$1":"<hidden>"')
    .replace(/\bbearer\s+\S+/gi, 'Bearer <hidden>');
}

/** a thrown `Skip` makes the check SKIP (with why), an `Info` makes it INFO: neither is a failure */
export class Skip extends Error {}
export class Info extends Error {}

export function table(rows: Row[]): string {
  const w = Math.max(5, ...rows.map((r) => r.check.length));
  return rows
    .map((r) => `${r.result.padEnd(5)} ${r.check.padEnd(w)}${r.detail ? `  ${hideCodes(r.detail)}` : ''}`)
    .join('\r\n');
}

export function summary(rows: Row[]): { fail: number; text: string } {
  const n = (x: Result) => rows.filter((r) => r.result === x).length;
  const fail = n('FAIL');
  const text =
    fail === 0
      ? `ALL GOOD: ${n('PASS')} passed, ${n('SKIP')} skipped`
      : `${fail} FAILED, ${n('PASS')} passed, ${n('SKIP')} skipped`;
  return { fail, text };
}

/** PowerShell's answer lines with every value as UTF-16 code units (ASCII in any console code page) */
export const decodeUnits = (s: string) =>
  s ? String.fromCharCode(...s.split(',').map((x) => Number.parseInt(x, 10))) : '';

/**
 * Who may open a file or folder: only cmdlets, property reads and core-type casts, so it may also work in
 * Constrained Language Mode. Lines: `me:<units>`, `prot:<True|False>`, `id:<units>` per access entry.
 */
export const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$a = Get-Acl -LiteralPath $env:PB_PATH',
  "'me:' + (([int[]][char[]][string]($env:USERDOMAIN + '\\' + $env:USERNAME)) -join ',')",
  "'prot:' + [string]$a.AreAccessRulesProtected",
  "foreach ($r in $a.Access) { 'id:' + (([int[]][char[]][string]$r.IdentityReference.Value) -join ',') }",
].join('\r\n');

export function parseAcl(out: string): { me: string; protectedList: boolean; ids: string[] } | null {
  let me: string | null = null;
  let prot: boolean | null = null;
  const ids: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(me|prot|id):(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'me') me = decodeUnits(m[2] ?? '');
    else if (m[1] === 'prot') prot = /^true$/i.test(m[2] ?? '');
    else ids.push(decodeUnits(m[2] ?? ''));
  }
  return me === null || prot === null ? null : { me, protectedList: prot, ids };
}

/** the access entries that are not this Windows user (by name, as Windows prints both) */
export const others = (a: { me: string; ids: string[] }) => [
  ...new Set(a.ids.filter((id) => id.toLowerCase() !== a.me.toLowerCase())),
];

const ps = (script: string, env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(
    windowsPowerShell(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } },
  );
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
export const encodePs = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

function aclOf(path: string) {
  const r = ps(ACL_SCRIPT, { PB_PATH: path });
  const a = r.status === 0 ? parseAcl(r.stdout) : null;
  if (!a)
    throw new Skip(
      'Windows PowerShell would not read the access list here (Constrained Language Mode?); the server checks it at every start and shows a card',
    );
  return a;
}

interface Launcher {
  name: string;
  proc: ChildProcess;
  seen: string[];
  err: string[];
  next(
    match: (e: Record<string, unknown>) => boolean,
    seconds: number,
  ): Promise<Record<string, unknown> | null>;
  send(o: unknown): void;
}

async function run(o: { install: string; pause: boolean }): Promise<number> {
  const l = installLayout(join(o.install, 'pasabot', 'apps', 'desktop', 'dist', 'windows-shell.js'));
  const server = join(l.root, 'apps', 'server', 'dist', 'host', 'main.js');
  const osKeyJs = join(l.root, 'apps', 'server', 'dist', 'vault', 'os-key.js');
  const report = join(o.install, 'selftest-report.txt');
  const logsFile = join(o.install, 'selftest-logs.txt');
  const tmp = join(tmpdir(), `pasabot-selftest-${Math.random().toString(16).slice(2, 10)}`);
  const rows: Row[] = [];
  const launchers: Launcher[] = [];
  // set inside the checks (`as`: never narrowed to null here)
  let url = null as string | null;
  let session = null as string | null;
  let serverPid = null as number | null;
  let L1 = null as Launcher | null;
  const say = (r: Row) => {
    rows.push(r);
    const color = { PASS: 32, FAIL: 31, SKIP: 33, INFO: 36 }[r.result];
    process.stdout.write(`\x1b[${color}m${r.result.padEnd(5)}\x1b[0m ${r.check}\n`);
    if (r.detail) process.stdout.write(`      ${hideCodes(r.detail)}\n`);
  };
  const check = async (name: string, f: () => Promise<string> | string) => {
    try {
      say({ check: name, result: 'PASS', detail: await f() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      say({
        check: name,
        result: e instanceof Skip ? 'SKIP' : e instanceof Info ? 'INFO' : 'FAIL',
        detail: msg,
      });
    }
  };
  const startLauncher = (extra: string[]): Launcher => {
    const proc = spawn(
      process.execPath,
      [l.launcher, '--payload', l.payload, '--home', tmp, '--no-browser', ...extra],
      { env: { ...process.env, PASABOT_HOME: tmp }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const queue: Record<string, unknown>[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const me: Launcher = {
      name: `launcher ${launchers.length + 1}`,
      proc,
      seen: [],
      err: [],
      send: (x) => proc.stdin?.write(`${JSON.stringify(x)}\n`),
      next: async (match, seconds) => {
        const until = Date.now() + seconds * 1000;
        for (;;) {
          while (queue.length) {
            const e = queue.shift() as Record<string, unknown>;
            if (match(e)) return e;
          }
          if (ended || Date.now() >= until) return null;
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 250);
          });
        }
      },
    };
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        me.seen.push(String(e.event));
        queue.push(e);
      } catch {
        me.seen.push('(not JSON)');
      }
      wake?.();
    });
    proc.stdout?.on('end', () => {
      ended = true;
      me.seen.push('(end of output)');
      wake?.();
    });
    proc.stderr?.on('data', (d: Buffer) => me.err.push(d.toString('utf8')));
    launchers.push(me);
    return me;
  };
  const exited = (p: ChildProcess, ms: number) =>
    new Promise<boolean>((r) => {
      if (p.exitCode !== null || p.signalCode !== null) return r(true);
      const t = setTimeout(() => r(false), ms);
      p.once('exit', () => {
        clearTimeout(t);
        r(true);
      });
    });
  const killTree = (pid: number | undefined) => {
    if (!pid) return;
    spawnSync(
      win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
  };
  const get = async (path: string, session?: string) => {
    const r = await fetch(`${url}${path}`, {
      headers: session ? { authorization: `Bearer ${session}` } : {},
      signal: AbortSignal.timeout(60_000),
    });
    return r;
  };

  const info = `Windows ${process.env.OS ?? ''} ${process.arch}, node ${process.version}, ${new Date().toISOString()}`;
  process.stdout.write('\nPasaBot: checking this computer (a test folder, never your own data)\n\n');

  await check('PasaBot is installed', () => {
    for (const f of [l.node, l.launcher, server, l.payload])
      if (!existsSync(f)) throw new Error(`missing: ${f}`);
    return `node ${process.version}`;
  });
  await check('Package links are in place', () => {
    const list = readLinks(l.links);
    if (!list) throw new Error(`missing: ${l.links}`);
    const bad = links(l.root, list, 'check');
    if (bad.length) throw new Error(bad.slice(0, 3).join('; '));
    return `${list.length} junctions point inside the install`;
  });
  await check('Tray (optional)', () => {
    const r = spawnSync(windowsPowerShell(), trayArgs(l, true), {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    });
    const state = trayStateOf({ status: r.error ? null : r.status, error: r.error });
    if (state === 'tray')
      return 'PowerShell runs the tray in Full Language mode: the PasaBot icon shows by the clock';
    throw new Info(
      state === 'constrained'
        ? 'PowerShell runs in Constrained Language Mode here (application control): no tray icon; PasaBot works from its window, and Start menu > PasaBot > Stop PasaBot stops it'
        : state === 'no-winforms'
          ? 'Windows Forms did not load: no tray icon; PasaBot works from its window'
          : 'Windows PowerShell did not start: no tray icon; PasaBot works from its window',
    );
  });

  mkdirSync(tmp, { recursive: true });
  // any free ports: never the ones your own PasaBot uses
  writeFileSync(join(tmp, 'desktop.json'), '{"port":0,"sitesPort":0}');
  try {
    await check('The app starts (launcher + server)', async () => {
      L1 = startLauncher([]);
      const s = await L1.next(
        (e) => e.event === 'status' && (e.server === 'running' || e.server === 'failed'),
        120,
      );
      if (!s) throw new Error(`no 'running' status within 120 s; see ${tmp}\\logs\\desktop-server.log`);
      if (s.server !== 'running')
        throw new Error(`the server failed: ${(s.labels as { status?: string } | undefined)?.status ?? ''}`);
      url = String(s.url);
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))
        throw new Error(`unexpected address ${url} (must be 127.0.0.1 only)`);
      serverPid = readLock(tmp)?.serverPid ?? null;
      return `listening on ${url} (127.0.0.1 only: no firewall prompt)`;
    });
    if (url && L1) {
      const first = L1 as Launcher;
      await check('Health answers', async () => {
        const h = (await (await get('/api/v1/health')).json()) as { ok?: boolean; version?: string };
        if (!h.ok) throw new Error('health says not ok');
        return `version ${h.version}`;
      });
      await check('First-run page loads', async () => {
        const r = await get('/');
        if (r.status !== 200 || !/<html/i.test(await r.text())) throw new Error(`HTTP ${r.status}`);
        const s = (await (await get('/api/v1/setup')).json()) as { needsSetup?: boolean };
        if (!s.needsSetup) throw new Error('a fresh data folder should need setup');
        return 'the claim page is served';
      });
      let link: string | null = null;
      await check('Setup link is made (private channel)', async () => {
        first.send({ cmd: 'setup-link' });
        const e = await first.next((x) => x.event === 'setup-link', 20);
        if (!e) throw new Error(`no answer within 20 s (events: ${first.seen.join(', ') || 'none'})`);
        if (!e.url || !/#\/setup\?token=[A-Za-z0-9_-]+/.test(String(e.url)))
          throw new Error('the link has no code');
        link = String(e.url);
        return 'a fresh one-time link over the launcher-server channel';
      });
      if (link) {
        const code = /token=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? '';
        await check('Claim works', async () => {
          const body = JSON.stringify({
            token: code,
            displayName: 'Selftest',
            password: crypto.randomUUID(),
          });
          const post = () =>
            fetch(`${url}/api/v1/setup`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              signal: AbortSignal.timeout(20_000),
            });
          const r = await post();
          const j = (await r.json()) as { token?: string };
          if (!r.ok || !j.token) throw new Error('no session after the claim');
          session = j.token;
          if ((await post()).ok) throw new Error('the same code worked twice');
          return 'owner created; the same code is refused the second time';
        });
      }
      await check('Data folder is yours only (access list)', () => {
        const a = aclOf(tmp);
        if (!a.protectedList) throw new Error('inheritance is still on');
        const o = others(a);
        if (o.length) throw new Error(`also open to: ${o.join(', ')}`);
        return 'inheritance off, only this Windows user';
      });
      // Windows protection (DPAPI) is for your own data folder only: a server on any other folder, such as this
      // test one, keeps its key in a vault.key inside that folder (vault/index.ts hostMasterKeySource)
      await check('Test folder keeps its own vault key', () => {
        const k = join(tmp, 'vault.key');
        if (!existsSync(k)) throw new Error('no vault.key in the test folder: the vault did not open');
        if (existsSync(join(tmp, 'vault.dpapi')))
          throw new Error('the test folder used Windows protection, which is for your own data folder only');
        let o: string[] = [];
        try {
          o = others(aclOf(k));
        } catch (e) {
          if (e instanceof Skip)
            return 'a vault.key inside the test folder (its access list: see the line above)';
          throw e;
        }
        if (o.length) throw new Error(`vault.key is also open to: ${o.join(', ')}`);
        return 'a vault.key only this Windows user can open, inside the test folder';
      });
      await check('Vault key is protected by Windows (DPAPI)', async () => {
        if (!existsSync(osKeyJs)) throw new Error(`missing: ${osKeyJs}`);
        const dir = join(tmp, 'dpapi-check');
        mkdirSync(dir, { recursive: true });
        const m = (await import(pathToFileURL(osKeyJs).href)) as {
          dpapiMasterKey(home: string, hasDataKey: boolean): Buffer;
        };
        const a = m.dpapiMasterKey(dir, false);
        const b = m.dpapiMasterKey(dir, true);
        const same = a.equals(b) && a.length === 32;
        a.fill(0);
        b.fill(0);
        if (!same) throw new Error('the key did not open again unchanged');
        if (!existsSync(join(dir, 'vault.dpapi'))) throw new Error('no vault.dpapi was written');
        if (existsSync(join(dir, 'vault.key'))) throw new Error('a plain vault.key file was written');
        return 'made and opened again with this Windows user’s protection (vault.dpapi, no plain key)';
      });
      await check('No open local channel (named pipe)', () => {
        const pipes = readdirSync('\\\\.\\pipe\\').filter((p) => /pasabot/i.test(p));
        if (pipes.length) throw new Error(`a PasaBot pipe is open: ${pipes.join(', ')}`);
        return 'the launcher-server channel is an inherited handle no other program can open';
      });
      await check('Owner-only notices answer', async () => {
        if (!session) throw new Skip('no owner session (the claim did not work)');
        const n = (await (await get('/api/v1/system/notices', session)).json()) as {
          notices?: { id: string }[];
        };
        const ids = (n.notices ?? []).map((x) => x.id);
        if (!ids.includes('windows-no-sandbox')) throw new Error('the no-sandbox card is missing');
        return `cards: ${ids.join(', ')}`;
      });
      await check('Brains found on this PC', async () => {
        if (!session) throw new Skip('no owner session');
        const b = (await (await get('/api/m/provider-ops/brains', session)).json()) as {
          brains?: { name: string; state: string }[];
          serverOs?: string;
        };
        if (b.serverOs !== 'windows') throw new Error('the brains page does not know it runs on Windows');
        return (b.brains ?? []).map((x) => `${x.name}=${x.state}`).join(', ');
      });
    }
    await check('App window command (argument array)', () => {
      const link = 'http://127.0.0.1:1/#/setup?token=abc&x=1';
      const c = appWindowCommand('win32', link, { home: 'C:\\h', env: process.env });
      if (!c) throw new Skip('no Edge, Chrome or Brave found (PasaBot then opens the default browser)');
      if (!c[0].toLowerCase().endsWith('.exe')) throw new Error(`not an .exe: ${c[0]}`);
      if (c[1][0] !== `--app=${link}`) throw new Error('the link was changed on the way');
      return `${win32.basename(c[0])} --app=<link> --user-data-dir=<data folder>\\app-window`;
    });
    await check('App window opens and closes', async () => {
      if (!url) throw new Skip('no server');
      const c = appWindowCommand('win32', `${url}/`, { home: tmp, env: process.env });
      if (!c) throw new Skip('no Chromium-family browser');
      const since = Date.now();
      const p = spawn(c[0], c[1], { stdio: 'ignore', detached: false });
      p.on('error', () => {});
      const quit = await exited(p, 6000);
      const name = win32.basename(c[0], '.exe');
      // only windows of a browser process started by this check (never the person's own browser windows)
      const r = ps(
        `@(Get-Process -Name $env:PB_NAME -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge (Get-Date).AddSeconds(-${Math.ceil((Date.now() - since) / 1000) + 1}) -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }).Count`,
        { PB_NAME: name },
      );
      killTree(p.pid);
      if (quit && r.status === 0 && r.stdout.trim() === '0') throw new Error('the browser exited at once');
      if (r.status !== 0 || r.stdout.trim() === '0')
        throw new Skip('started, but no window title could be read (a locked or remote session?)');
      return 'a PasaBot window opened in app mode and was closed';
    });
    await check('Second launch hands over (single instance)', async () => {
      if (!L1) throw new Skip('the first launch did not start');
      const L2 = startLauncher(['--no-stdin']);
      const e = await L2.next((x) => x.event === 'already-running', 60);
      if (!(await exited(L2.proc, 30_000))) {
        L2.proc.kill();
        throw new Error('the second copy did not quit');
      }
      if (!e) throw new Error(`no already-running event; ${L2.err.join('').trim()}`);
      return 'the second copy found the first and quit';
    });
    await check('Clean stop (nothing left running)', async () => {
      if (!L1) throw new Skip('nothing was started');
      const first = L1 as Launcher;
      first.proc.stdin?.end();
      if (!(await exited(first.proc, 30_000))) throw new Error('the launcher did not quit within 30 s');
      await new Promise((r) => setTimeout(r, 1000));
      if (serverPid && alive(serverPid)) throw new Error(`the server (pid ${serverPid}) is still running`);
      if (existsSync(join(tmp, 'run', 'desktop.lock'))) throw new Error('the lock file was left behind');
      return 'launcher and server are gone, the lock is released';
    });
    // the path PasaBot takes without a tray: the launcher alone, stopped by "Stop PasaBot" (no PowerShell at all)
    await check('Stop PasaBot works without the tray', async () => {
      const L3 = startLauncher(['--no-stdin']);
      const s = await L3.next(
        (e) => e.event === 'status' && (e.server === 'running' || e.server === 'failed'),
        120,
      );
      if (s?.server !== 'running') throw new Error('the launcher alone did not start its server');
      const r = await stop(tmp, l.launcher);
      if (r !== 'stopped') throw new Error(`stop said: ${r}`);
      if (!(await exited(L3.proc, 10_000))) throw new Error('the launcher is still running');
      if (existsSync(join(tmp, 'run', 'desktop.lock'))) throw new Error('the lock file was left behind');
      return 'asked through the data folder, it stopped its server and quit (no tray, no PowerShell)';
    });
  } finally {
    for (const x of launchers)
      if (x.proc.exitCode === null && x.proc.signalCode === null) killTree(x.proc.pid);
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if (rows.some((r) => r.result === 'FAIL')) {
        const parts = ['PasaBot check of this computer: what the test run logged (codes hidden)', info];
        for (const x of launchers)
          parts.push(
            '',
            `== ${x.name}: events read: ${x.seen.join(', ') || 'none'}`,
            `== ${x.name}: error output`,
            x.err.join('').trimEnd(),
          );
        const logs = join(tmp, 'logs');
        if (existsSync(logs))
          for (const f of readdirSync(logs)) {
            const lines = readFileSync(join(logs, f), 'utf8').split(/\r?\n/);
            parts.push('', `== logs\\${f} (last 80 lines)`, ...lines.slice(-80));
          }
        writeFileSync(logsFile, `${hideCodes(parts.join('\r\n'))}\r\n`);
      } else rmSync(logsFile, { force: true });
    } catch (e) {
      process.stdout.write(
        `Could not keep the logs of the test run: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    // junction-safe delete of the test folder: rmdir never follows a link
    spawnSync(
      win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      ['/c', 'rmdir', '/s', '/q', tmp],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
  }

  const s = summary(rows);
  process.stdout.write(`\n${s.fail ? '\x1b[31m' : '\x1b[32m'}${s.text}\x1b[0m\n`);
  try {
    writeFileSync(
      report,
      `${['PasaBot check of this computer', info, '', table(rows), '', s.text].join('\r\n')}\r\n`,
    );
    process.stdout.write(`Report: ${report}\n`);
    if (s.fail && existsSync(logsFile)) process.stdout.write(`Logs of the test run: ${logsFile}\n`);
  } catch (e) {
    process.stdout.write(`Could not write the report: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  if (o.pause) {
    process.stdout.write('\nPress Enter to close.\n');
    await new Promise((r) => process.stdin.once('data', r));
  }
  return s.fail ? 1 : 0;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--install');
  const install =
    at >= 0 && args[at + 1]
      ? resolve(args[at + 1] as string)
      : installLayout(join(fileURLToPath(import.meta.url), '..', 'windows-shell.js')).install;
  run({ install, pause: args.includes('--pause') }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`selftest: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
