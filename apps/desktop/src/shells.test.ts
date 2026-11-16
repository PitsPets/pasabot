/**
 * Shells without a window (the Windows tray, the Linux starter): every way they open the app (the boot link, Open, a
 * second launch, Stop all on a server they did not start) opens a fresh setup link while there is no owner and the
 * bare address once one exists; links go to the OS opener as an argument array, and with no shell reading stdout the
 * setup code is hidden on the wire. Runs on any OS: the opener is injected, so no browser is ever started.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from './config.js';
import { lockPath, readLock } from './instance.js';
import { Launcher, type ShellEvent, type StatusEvent } from './launcher.js';
import { createOpener, hideSetupCode, isOpenable, openCommands, type Spawner, shellSink } from './opener.js';

const fake = fileURLToPath(new URL('./__fixtures__/fake-server.mjs', import.meta.url));
const mint = fileURLToPath(new URL('./__fixtures__/mint-setup-link.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pasabot-shells-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = () => join(scratch, `h${n++}`);
const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', ...extra });

/** a spawner that starts nothing: it records each argv; commands in `missing` fail as not installed */
function recorder(missing: string[] = []) {
  const argv: string[][] = [];
  const spawner: Spawner = (cmd, args) => {
    argv.push([cmd, ...args]);
    return {
      on: (_ev, listener) => {
        if (missing.includes(cmd))
          queueMicrotask(() => listener(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return undefined;
      },
    };
  };
  return { argv, spawner };
}

/** a launcher wired the way main.ts wires a shell-less one (`--open-urls`), with the opener injected */
function shellLess(
  platform: NodeJS.Platform,
  home: string,
  extra: Record<string, string> = {},
  more: Partial<ConstructorParameters<typeof Launcher>[0]> = {},
  port = 0,
) {
  writeConfig(home, { ...readConfig(home), port, sitesPort: 0 });
  const opened = recorder();
  const wire: string[] = [];
  const events: ShellEvent[] = [];
  const sink = shellSink({
    selfOpens: true,
    open: createOpener(platform, opened.spawner),
    write: (l) => wire.push(l),
  });
  const l = new Launcher({
    home,
    entry: fake,
    server: { node: process.execPath, entry: fake, env: env(extra), mintEntry: mint },
    version: '0.1.0',
    emit: (e) => {
      events.push(e);
      sink(e);
    },
    userHome: join(home, 'user'),
    platform,
    opensUrls: true,
    stopGraceMs: 1500,
    ...more,
  });
  const last = () => [...events].reverse().find((e): e is StatusEvent => e.event === 'status')!;
  return { l, events, last, opened: opened.argv, wire };
}

/** what the browser was asked to open, per platform */
const argvFor = (platform: NodeJS.Platform, url: string) =>
  platform === 'win32'
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
    : platform === 'darwin'
      ? ['open', url]
      : ['xdg-open', url];

describe('the OS opener', () => {
  it('opens with an argument array per platform: never a shell, never cmd.exe start', () => {
    const url = 'http://127.0.0.1:7777/#/setup?token=a&b=c^d';
    expect(openCommands('win32', url)).toEqual([['rundll32.exe', ['url.dll,FileProtocolHandler', url]]]);
    expect(openCommands('linux', url)).toEqual([
      ['xdg-open', [url]],
      ['gio', ['open', url]],
    ]);
    expect(openCommands('darwin', url)).toEqual([['open', [url]]]);
    for (const p of ['win32', 'linux', 'darwin'] as const)
      for (const [cmd] of openCommands(p, url))
        expect(cmd).not.toMatch(/^(cmd|sh|bash|powershell)(\.exe)?$/i);
  });
  it('Linux: no xdg-open installed falls back to gio open', async () => {
    const r = recorder(['xdg-open']);
    expect(createOpener('linux', r.spawner)('http://127.0.0.1:1/#/setup?token=abc')).toBe(true);
    await new Promise((res) => setTimeout(res, 10));
    expect(r.argv).toEqual([
      ['xdg-open', 'http://127.0.0.1:1/#/setup?token=abc'],
      ['gio', 'open', 'http://127.0.0.1:1/#/setup?token=abc'],
    ]);
  });
  it('opens only a plain http(s) address', () => {
    const r = recorder();
    const open = createOpener('win32', r.spawner);
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://127.0.0.1:1/ x',
      'http://127.0.0.1:1/"&calc',
      'http://127.0.0.1:1/\nx',
      'http://127.0.0.1:1/\u0007',
      '--help',
    ]) {
      expect(isOpenable(bad), bad).toBe(false);
      expect(open(bad)).toBe(false);
    }
    expect(r.argv).toEqual([]);
    expect(isOpenable('http://127.0.0.1:7777/#/setup?token=Ab-_09')).toBe(true);
  });
  it('hides the setup code', () => {
    expect(hideSetupCode('http://127.0.0.1:1/#/setup?token=s3cr3t')).toBe(
      'http://127.0.0.1:1/#/setup?token=<hidden>',
    );
    expect(hideSetupCode('http://127.0.0.1:1')).toBe('http://127.0.0.1:1');
  });
});

for (const platform of ['win32', 'linux'] as const) {
  describe(`a shell without a window (${platform})`, () => {
    it('boot, Open after Open: a fresh tokened link each time while unclaimed, the bare address once claimed', async () => {
      const home = dir();
      const owner = join(home, 'owner');
      const { l, opened, wire, last } = shellLess(platform, home, {
        FAKE_SETUP: '1',
        FAKE_OWNER_FILE: owner,
      });
      await l.init();
      const url = last().url!;
      // the boot link, then each Open asks the server at that moment (the code of the last one may have run out)
      await l.handle({ cmd: 'open' });
      await l.handle({ cmd: 'open' });
      expect(opened).toEqual([
        argvFor(platform, `${url}/#/setup?token=t`),
        argvFor(platform, `${url}/#/setup?token=t1`),
        argvFor(platform, `${url}/#/setup?token=t2`),
      ]);
      writeFileSync(owner, '1');
      await l.handle({ cmd: 'open' });
      expect(opened.at(-1)).toEqual(argvFor(platform, url));
      // nobody reads a shell-less launcher's stdout but a log: no code on the wire, no link in the server log
      const all = wire.join('\n');
      expect(all).toContain('"event":"open"');
      expect(all).not.toMatch(/token=(?!<hidden>)/);
      let log = '';
      try {
        log = readFileSync(l.logFile, 'utf8');
      } catch {
        // the fake server writes no log
      }
      expect(log).not.toContain('token=');
      await l.quit();
    });

    it('a server it did not start (external): Open and Stop all use the one-shot minter, never the bare address', async () => {
      const home = dir();
      const log = join(home, 'mint.log');
      mkdirSync(join(home, 'run'), { recursive: true });
      writeFileSync(join(home, 'run', 'server.pid'), `${process.pid}\n`);
      const { l, opened, wire, last } = shellLess(
        platform,
        home,
        { FAKE_MINT: '1', FAKE_MINT_LOG: log },
        {},
        7777,
      );
      await l.init();
      expect(last().server).toBe('external');
      // the first launch has no boot link from a server it did not start: it opens a minted one at once
      const link = 'http://127.0.0.1:7777/#/setup?token=minted';
      expect(opened).toEqual([argvFor(platform, link)]);
      await l.handle({ cmd: 'open' });
      await l.handle({ cmd: 'stop-all' });
      expect(opened).toEqual([argvFor(platform, link), argvFor(platform, link), argvFor(platform, link)]);
      // minted from this data dir at the moment of each open
      expect(readFileSync(log, 'utf8')).toBe(`${home} http://127.0.0.1:7777\n`.repeat(3));
      expect(wire.join('\n')).not.toMatch(/token=(?!<hidden>)/);
      await l.quit();
      // an owner exists (the minter prints nothing): the bare address
      const owned = dir();
      mkdirSync(join(owned, 'run'), { recursive: true });
      writeFileSync(join(owned, 'run', 'server.pid'), `${process.pid}\n`);
      const o = shellLess(platform, owned, {}, {}, 7777);
      await o.l.init();
      // claimed: the first launch opens nothing, as for a server it starts itself
      expect(o.opened).toEqual([]);
      await o.l.handle({ cmd: 'open' });
      expect(o.opened).toEqual([argvFor(platform, 'http://127.0.0.1:7777')]);
      await o.l.quit();
      // a shell with a window (it asks on its own) and --no-browser open nothing at first launch, and mint nothing
      for (const more of [{ canShow: true }, { openSetupLink: false }]) {
        const h = dir();
        const mintLog = join(h, 'mint.log');
        mkdirSync(join(h, 'run'), { recursive: true });
        writeFileSync(join(h, 'run', 'server.pid'), `${process.pid}\n`);
        const q = shellLess(platform, h, { FAKE_MINT: '1', FAKE_MINT_LOG: mintLog }, more, 7777);
        await q.l.init();
        expect(q.last().server).toBe('external');
        expect(q.opened).toEqual([]);
        expect(() => readFileSync(mintLog, 'utf8')).toThrow();
        await q.l.quit();
      }
    });
  });
}

describe('a second launch of a shell without a window', () => {
  const holder = { pid: 4321, entry: fake, url: 'http://127.0.0.1:7777', serverPid: null };
  function second(
    platform: NodeJS.Platform,
    holderLock: object,
    delivered: boolean,
    extra: Record<string, string>,
  ) {
    const home = dir();
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify(holderLock));
    const poked: number[] = [];
    const s = shellLess(platform, home, extra, {
      instanceDeps: {
        alive: () => true,
        commandOf: () => null,
        poke: (pid) => {
          poked.push(pid);
          return delivered;
        },
      },
    });
    return { ...s, poked, home };
  }

  it('Linux: the first copy (it opens links itself) is poked and opens a fresh link; this copy opens nothing', async () => {
    const firstHome = dir();
    const first = shellLess('linux', firstHome, { FAKE_SETUP: '1' });
    await first.l.init();
    const url = first.last().url!;
    // it records that a poke is handled, so a second launch hands off to it instead of minting a code of its own
    expect(readLock(firstHome)?.show).toBe(true);
    first.l.requestShow();
    for (let i = 0; i < 50 && first.opened.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(first.opened).toEqual([
      argvFor('linux', `${url}/#/setup?token=t`),
      argvFor('linux', `${url}/#/setup?token=t1`),
    ]);
    expect(first.events.some((e) => e.event === 'show')).toBe(false);
    await first.l.quit();

    const s = second('linux', { ...holder, show: true }, true, { FAKE_MINT: '1' });
    expect(await s.l.init()).toBe(false);
    expect(s.poked).toEqual([4321]);
    expect(s.opened).toEqual([]);
  });

  it('Windows (no signals, never handed off) and no owner yet: the browser opens a freshly minted link', async () => {
    const s = second('win32', holder, false, { FAKE_MINT: '1' });
    expect(await s.l.init()).toBe(false);
    expect(s.opened).toEqual([argvFor('win32', `${holder.url}/#/setup?token=minted`)]);
    expect(s.wire.join('\n')).not.toMatch(/token=(?!<hidden>)/);
    // an owner exists: the bare address
    const o = second('win32', holder, false, {});
    expect(await o.l.init()).toBe(false);
    expect(o.opened).toEqual([argvFor('win32', holder.url)]);
  });
});
