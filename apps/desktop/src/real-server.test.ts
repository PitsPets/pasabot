/**
 * The launcher with the REAL pasabot-server (from source, temp $PASABOT_HOME, port 0, test-only vault passphrase so
 * no keychain is touched): the parent channel reports the URL and the setup link, the health route answers, Stop all
 * stops through the kill switch, and SIGKILL on the launcher leaves no server behind.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { writeConfig } from './config.js';
import { alive, readLock } from './instance.js';
import type { StatusEvent } from './launcher.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pasabot-desktop-real-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('desktop launcher + real server', () => {
  it('starts, reports URL + setup link, stops all, and dies with the launcher', async () => {
    const home = join(scratch, 'home');
    const userHome = join(scratch, 'user');
    mkdirSync(userHome, { recursive: true });
    writeConfig(home, { port: 0, sitesPort: 0, updateCheck: false, updateUrl: null });
    const child = spawn(
      process.execPath,
      [
        '--conditions=source',
        '--import',
        import.meta.resolve('tsx'),
        main,
        '--home',
        home,
        '--root',
        root,
        '--dev',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: userHome,
          // test-only value: keeps the server off the login keychain
          PASABOT_VAULT_PASSPHRASE: 'desktop-test-only-passphrase',
        },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    // --dev: the real server boots from source (main.ts via tsx), so no build is needed; give it room
    const lastStatus = () =>
      out
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as { event: string }];
          } catch {
            return []; // a line still being written
          }
        })
        .filter((e): e is StatusEvent => e.event === 'status')
        .at(-1);
    const until = async (ok: (s: StatusEvent | undefined) => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !ok(lastStatus())) await sleep(100);
      return lastStatus();
    };
    try {
      const running = await until((s) => s?.server === 'running' || s?.server === 'failed', 60_000);
      expect(running?.server, err).toBe('running');
      const url = running!.url!;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // first run, no owner: the launcher asked the shell to open the one-time setup link (the line right after the
      // running status; it may arrive in the next stdout chunk)
      for (let i = 0; i < 50 && !out.includes('"event":"open"'); i++) await sleep(100);
      expect(out).toMatch(/"event":"open","url":"http:\/\/127\.0\.0\.1:\d+\/#\/setup\?token=/);
      // the window asks for a fresh link (its page's code was refused): it comes over the server channel; seconds
      // after boot the server hands the same unused link back instead of minting another
      const bootLink = /"event":"open","url":"([^"]+)"/.exec(out)![1]!;
      child.stdin.write('{"cmd":"setup-link"}\n');
      for (let i = 0; i < 50 && !out.includes('"event":"setup-link"'); i++) await sleep(100);
      expect(/"event":"setup-link","url":"([^"]+)"/.exec(out)?.[1]).toBe(bootLink);
      // the link is never written to the server's log beyond the boot line
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(join(home, 'logs', 'desktop-server.log'), 'utf8');
      expect(
        log.split(new URL(bootLink.replace('/#/', '/')).searchParams.get('token')!).length - 1,
      ).toBeLessThanOrEqual(1);
      const health = (await (await fetch(`${url}/api/v1/health`)).json()) as { ok: boolean };
      expect(health.ok).toBe(true);

      child.stdin.write('{"cmd":"stop-all"}\n');
      const stopped = await until((s) => s?.allStopped === true, 20_000);
      expect(stopped?.allStopped).toBe(true);
      expect(stopped?.labels.status).toBe('Everything is stopped. Resume it from the web app.');

      const serverPid = readLock(home)!.serverPid!;
      expect(alive(serverPid)).toBe(true);
      child.kill('SIGKILL');
      const end = Date.now() + 20_000;
      while (Date.now() < end && alive(serverPid)) await sleep(100);
      expect(alive(serverPid)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 120_000);
});

describe('desktop launcher attached to a server it did not start (`pasabot start`)', () => {
  it('mints the window a fresh setup link with the real one-shot minter, which that server accepts', async () => {
    const { bootTestServer } = await import('../../../packages/testkit/src/index.js');
    const { Launcher } = await import('./launcher.js');
    const home = join(scratch, 'external');
    mkdirSync(join(home, 'run'), { recursive: true });
    const s = await bootTestServer({ home });
    try {
      const port = Number(new URL(s.url).port);
      writeConfig(home, { port, sitesPort: 0, updateCheck: false, updateUrl: null });
      writeFileSync(join(home, 'run', 'server.pid'), `${process.pid}\n`);
      const events: { event: string; url?: string | null }[] = [];
      const l = new Launcher({
        home,
        entry: main,
        server: {
          node: process.execPath,
          entry: fileURLToPath(new URL('../../server/src/host/main.ts', import.meta.url)),
          execArgv: ['--conditions=source', '--import', import.meta.resolve('tsx')],
          env: { PATH: process.env.PATH ?? '' },
        },
        version: '0.1.0',
        emit: (e) => events.push(e as never),
        userHome: join(scratch, 'user-external'),
        canShow: true,
      });
      expect(await l.init()).toBe(true);
      await l.handle({ cmd: 'setup-link' });
      const link = events.at(-1)?.url ?? '';
      expect(link.startsWith(`${s.url}/#/setup?token=`)).toBe(true);
      const claim = await fetch(`${s.url}/api/v1/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: link.split('token=')[1],
          displayName: 'Diwa',
          password: 'correct horse',
        }),
      });
      expect(claim.status).toBe(200);
      // an owner exists now: no link
      await l.handle({ cmd: 'setup-link' });
      expect(events.at(-1)).toEqual({ event: 'setup-link', url: null });
      await l.quit();
    } finally {
      await s.cleanup();
    }
  }, 60_000);
});

describe('a shell without a window (Windows tray, Linux starter) + real server', () => {
  it('after the boot code ran out, Open opens a fresh link that claims the server; once claimed, the bare address', async () => {
    const { Launcher } = await import('./launcher.js');
    const { createOpener, shellSink } = await import('./opener.js');
    const { openDatabase } = await import('../../../packages/db/src/index.js');
    const home = join(scratch, 'shell-less');
    const userHome = join(scratch, 'user-shell-less');
    mkdirSync(userHome, { recursive: true });
    writeConfig(home, { port: 0, sitesPort: 0, updateCheck: false, updateUrl: null });
    const opened: string[][] = [];
    const wire: string[] = [];
    const sink = shellSink({
      selfOpens: true,
      // injected: records the argv and starts nothing (no browser on CI)
      open: createOpener('linux', (cmd, args) => {
        opened.push([cmd, ...args]);
        return { on: () => undefined };
      }),
      write: (line) => wire.push(line),
    });
    const events: { event: string; url?: string | null }[] = [];
    const l = new Launcher({
      home,
      entry: main,
      server: {
        node: process.execPath,
        entry: fileURLToPath(new URL('../../server/src/host/main.ts', import.meta.url)),
        execArgv: ['--conditions=source', '--import', import.meta.resolve('tsx')],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: userHome,
          // test-only value: keeps the server off the login keychain
          PASABOT_VAULT_PASSPHRASE: 'desktop-test-only-passphrase',
        },
      },
      version: '0.1.0',
      emit: (e) => {
        events.push(e as never);
        sink(e);
      },
      userHome,
      platform: 'linux',
      opensUrls: true,
    });
    const claim = (link: string, displayName: string) =>
      fetch(`${url()}/api/v1/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: link.split('token=')[1], displayName, password: 'correct horse' }),
      });
    const url = () =>
      (events.filter((e) => e.event === 'status').at(-1) as StatusEvent | undefined)?.url ?? '';
    try {
      expect(await l.init()).toBe(true);
      expect(url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // the boot link went to the browser
      const boot = opened.at(-1)?.[1] ?? '';
      expect(opened.at(-1)?.[0]).toBe('xdg-open');
      expect(boot.startsWith(`${url()}/#/setup?token=`)).toBe(true);
      // the tab sat open past 30 minutes: every code has run out
      const db = openDatabase(join(home, 'pasabot.db'));
      try {
        db.prepare('UPDATE setup_tokens SET expires_at = ?').run(Date.now() - 1);
      } finally {
        db.close();
      }
      expect((await claim(boot, 'Late')).status).toBe(403);
      // "Open PasaBot" (or a second launch): a fresh link, asked at that moment, even within the 10 s reuse
      await l.handle({ cmd: 'open' });
      const fresh = opened.at(-1)?.[1] ?? '';
      expect(opened.at(-1)).toEqual(['xdg-open', fresh]);
      expect(fresh.startsWith(`${url()}/#/setup?token=`)).toBe(true);
      expect(fresh).not.toBe(boot);
      expect((await claim(fresh, 'Diwa')).status).toBe(200);
      // claimed: the bare address
      await l.handle({ cmd: 'open' });
      expect(opened.at(-1)).toEqual(['xdg-open', url()]);
      // no code on the wire (the starter appends stdout to a log); the fresh link never in the server log
      expect(wire.join('\n')).not.toMatch(/token=(?!<hidden>)/);
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(l.logFile, 'utf8');
      expect(log).not.toContain(fresh.split('token=')[1]!);
    } finally {
      await l.quit();
    }
  }, 90_000);
});
