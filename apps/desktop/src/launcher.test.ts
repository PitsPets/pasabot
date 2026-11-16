/**
 * The launcher around a stand-in server that speaks the parent channel: start, stop all, clean shutdown with SIGKILL
 * escalation, a second copy, a taken port, and no orphan when the launcher itself is killed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { configPath, readConfig, writeConfig } from './config.js';
import { alive, lockPath, readLock } from './instance.js';
import { Launcher, type ShellEvent, type StatusEvent } from './launcher.js';
import { ServerProcess } from './server-proc.js';

const fake = fileURLToPath(new URL('./__fixtures__/fake-server.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pasabot-desktop-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = () => join(scratch, `h${n++}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gone(pid: number, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return false;
}

const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', ...extra });

function launcher(home: string, extra: Record<string, string> = {}) {
  // never the real default ports in tests: 0 = any free port, unless the test wrote its own settings
  if (!existsSync(configPath(home))) writeConfig(home, { ...readConfig(home), port: 0, sitesPort: 0 });
  const events: ShellEvent[] = [];
  const l = new Launcher({
    home,
    entry: fake, // any file our own process command line contains would do; the fake keeps it simple
    server: { node: process.execPath, entry: fake, env: env(extra) },
    version: '0.1.0',
    emit: (e) => events.push(e),
    userHome: join(home, 'user'),
    appPath: '/Applications/PasaBot.app',
    platform: 'darwin',
    stopGraceMs: 1500,
  });
  const last = () => [...events].reverse().find((e): e is StatusEvent => e.event === 'status')!;
  return { l, events, last };
}

describe('ServerProcess', () => {
  it('reports the real URL (port 0), presses stop all, and stops cleanly', async () => {
    const proc = new ServerProcess({ node: process.execPath, entry: fake, env: env() });
    const ready = await proc.start(0, 0);
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ready.stopped).toBe(false);
    expect(await proc.requestState()).toEqual({ stopped: false, since: null });
    expect((await proc.stopAll()).stopped).toBe(true);
    const pid = proc.pid!;
    await proc.stop(2000);
    expect(proc.running).toBe(false);
    expect(alive(pid)).toBe(false);
  });
  it('escalates to SIGKILL when the server ignores the clean stop', async () => {
    const proc = new ServerProcess({ node: process.execPath, entry: fake, env: env({ FAKE_STUBBORN: '1' }) });
    await proc.start(0, 0);
    const pid = proc.pid!;
    const t0 = Date.now();
    await proc.stop(500);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(alive(pid)).toBe(false);
  });
  it('asks for a fresh setup link over the channel; a silent server answers null in time, a stopped one at once', async () => {
    const proc = new ServerProcess({ node: process.execPath, entry: fake, env: env({ FAKE_SETUP: '1' }) });
    const ready = await proc.start(0, 0);
    expect(ready.setupLink).toBe(`${ready.url}/#/setup?token=t`);
    expect(await proc.requestSetupLink()).toBe(`${ready.url}/#/setup?token=t1`);
    // two asks at once: both are answered
    const [a, b] = await Promise.all([proc.requestSetupLink(), proc.requestSetupLink()]);
    expect(a).toMatch(/token=t[23]$/);
    expect(b).toMatch(/token=t[23]$/);
    await proc.stop(2000);
    expect(await proc.requestSetupLink()).toBeNull();

    const mute = new ServerProcess({
      node: process.execPath,
      entry: fake,
      env: env({ FAKE_LINK_MUTE: '1' }),
    });
    await mute.start(0, 0);
    const t0 = Date.now();
    expect(await mute.requestSetupLink(300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(mute.listenerCount('setup-link')).toBe(0);
    await mute.stop(2000);
  });
  it('a server that dies before it is ready is an error, not a hang', async () => {
    const proc = new ServerProcess({ node: process.execPath, entry: fake, env: env({ FAKE_CRASH: '1' }) });
    await expect(proc.start(0, 0)).rejects.toThrow(/exited before it was ready \(exit 3\)/);
    expect(proc.running).toBe(false);
  });
});

describe('Launcher', () => {
  it("offers Quit and Open at sign-in to the web app's Settings on Linux and Windows, and acts on the owner's tap", async () => {
    const home = dir();
    writeConfig(home, { ...readConfig(home), port: 0, sitesPort: 0 });
    const log = join(home, 'offers.jsonl');
    let quitAsked = 0;
    const l = new Launcher({
      home,
      entry: fake,
      server: { node: process.execPath, entry: fake, env: env({ FAKE_DESKTOP: '1', FAKE_DESKTOP_LOG: log }) },
      version: '0.1.0',
      emit: () => {},
      userHome: join(home, 'user'),
      appPath: '/opt/pasabot/bin/pasabot-desktop',
      platform: 'linux',
      env: {},
      stopGraceMs: 1500,
      onQuitRequest: () => quitAsked++,
    });
    expect(await l.init()).toBe(true);
    const end = Date.now() + 10_000;
    while (quitAsked === 0 && Date.now() < end) await sleep(50);
    expect(quitAsked).toBe(1);
    expect(existsSync(join(home, 'user', '.config', 'autostart', 'pasabot.desktop'))).toBe(true);
    const offers = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x) as { quit: boolean; autostart: boolean; autostartAvailable: boolean });
    expect(offers[0]).toMatchObject({ quit: true, autostart: false, autostartAvailable: true });
    expect(offers.at(-1)).toMatchObject({ quit: true, autostart: true, autostartAvailable: true });
    await l.quit();
  });

  it('offers nothing on macOS (its own app menus have both) and ignores an ask', async () => {
    const home = dir();
    const log = join(home, 'offers.jsonl');
    mkdirSync(home, { recursive: true });
    const { l } = launcher(home, { FAKE_DESKTOP: '1', FAKE_DESKTOP_LOG: log });
    expect(l.desktopOffer()).toEqual({ quit: false, autostart: false, autostartAvailable: false });
    expect(await l.init()).toBe(true);
    await sleep(300);
    expect(existsSync(join(home, 'user', 'Library', 'LaunchAgents', 'local.pasabot.desktop.plist'))).toBe(
      false,
    );
    expect(JSON.parse(readFileSync(log, 'utf8').split('\n')[0]!)).toMatchObject({ quit: false });
    await l.quit();
  });

  it('starts the server, describes the menu, stops all, and quits leaving nothing behind', async () => {
    const home = dir();
    const { l, events, last } = launcher(home, { FAKE_SETUP: '1' });
    expect(await l.init()).toBe(true);
    const s = last();
    expect(s.server).toBe('running');
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(s.labels.status).toBe('PasaBot is running');
    expect(s.can).toEqual({ open: true, stopAll: true, start: false, stop: true });
    expect(s.updateCheck).toBe(false);
    expect(s.updateLine).toBeNull();
    // first run: the setup link is opened for the person; the lock knows the URL and the server pid
    expect(events.find((e) => e.event === 'open')).toEqual({
      event: 'open',
      url: `${s.url}/#/setup?token=t`,
    });
    const lock = readLock(home)!;
    expect(lock.url).toBe(s.url);
    const serverPid = lock.serverPid!;
    expect(alive(serverPid)).toBe(true);

    await l.handle({ cmd: 'stop-all' });
    expect(last().allStopped).toBe(true);
    expect(last().labels.status).toBe('Everything is stopped. Resume it from the web app.');
    expect(last().can.stopAll).toBe(false);

    await l.handle({ cmd: 'autostart', on: true });
    expect(last().autostart).toBe(true);
    expect(existsSync(join(home, 'user', 'Library', 'LaunchAgents', 'local.pasabot.desktop.plist'))).toBe(
      true,
    );

    await l.quit();
    expect(events.at(-1)).toEqual({ event: 'bye' });
    expect(alive(serverPid)).toBe(false);
    expect(existsSync(lockPath(home))).toBe(false);
  });

  it('setup-link: the shell gets a fresh link from the server channel, null once there is no server', async () => {
    const home = dir();
    const { l, events } = launcher(home, { FAKE_SETUP: '1' });
    await l.init();
    const url = (events.find((e) => e.event === 'open') as { url: string }).url.replace(/\/#.*$/, '');
    const links = () => events.filter((e) => e.event === 'setup-link');
    await l.handle({ cmd: 'setup-link' });
    expect(links().at(-1)).toEqual({ event: 'setup-link', url: `${url}/#/setup?token=t1` });
    // asks that arrive together are one ask: one answer
    const before = links().length;
    await Promise.all([l.handle({ cmd: 'setup-link' }), l.handle({ cmd: 'setup-link' })]);
    expect(links().length).toBe(before + 1);
    await l.handle({ cmd: 'stop' });
    await l.handle({ cmd: 'setup-link' });
    expect(links().at(-1)).toEqual({ event: 'setup-link', url: null });
    await l.quit();
  });

  it('setup-link never waits behind a slow command (the window is waiting on it)', async () => {
    const home = dir();
    const { l, events } = launcher(home, { FAKE_SETUP: '1' });
    await l.init();
    // a command queue blocked by a long stop all must not hold the link back
    let release = () => {};
    (l as unknown as { busy: Promise<unknown> }).busy = new Promise<void>((r) => {
      release = r;
    });
    const queued = l.handle({ cmd: 'status' });
    await l.handle({ cmd: 'setup-link' });
    expect(events.some((e) => e.event === 'setup-link' && e.url !== null)).toBe(true);
    release();
    await queued;
    await l.quit();
  });

  it('a taken preferred port falls back to a free one, and that one is remembered', async () => {
    const home = dir();
    const blocker: Server = await new Promise((r) => {
      const s = createServer();
      s.listen({ port: 0, host: '127.0.0.1' }, () => r(s));
    });
    const taken = (blocker.address() as { port: number }).port;
    writeConfig(home, { ...readConfig(home), port: taken, sitesPort: 0 });
    const { l, last } = launcher(home);
    await l.init();
    const port = Number(new URL(last().url!).port);
    expect(port).not.toBe(taken);
    expect(readConfig(home).port).toBe(port);
    await l.quit();
    await new Promise((r) => blocker.close(r));
  });

  it('a server that dies on its own shows as failed and is not restarted in a loop', async () => {
    const home = dir();
    const { l, last } = launcher(home);
    await l.init();
    process.kill(l.serverPid!, 'SIGKILL');
    for (let i = 0; i < 100 && last().server !== 'failed'; i++) await sleep(20);
    expect(last().server).toBe('failed');
    expect(last().labels.status).toBe('PasaBot could not start: SIGKILL');
    expect(last().can.start).toBe(true);
    await l.handle({ cmd: 'start' });
    expect(last().server).toBe('running');
    await l.quit();
  });

  it('a server started by `pasabot start` for this data dir is left alone (no second server)', async () => {
    const home = dir();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeConfig(home, { ...readConfig(home), port: 7777 });
    writeFileSync(join(home, 'run', 'server.pid'), `${process.pid}\n/x/apps/server/dist/host/main.js\n`);
    const { l, last, events } = launcher(home);
    await l.init();
    expect(last().server).toBe('external');
    expect(l.serverPid).toBeNull();
    await l.handle({ cmd: 'stop-all' });
    expect(events.at(-1)).toEqual({ event: 'open', url: 'http://127.0.0.1:7777' });
    // an owner exists (the minter prints nothing): the window gets null, and Open is the bare address
    await l.handle({ cmd: 'setup-link' });
    expect(events.at(-1)).toEqual({ event: 'setup-link', url: null });
    await l.handle({ cmd: 'open' });
    expect(events.at(-1)).toEqual({ event: 'open', url: 'http://127.0.0.1:7777' });
    await l.quit();
  });

  it('attached to a server it did not start, the window still gets a fresh setup link (minted from the data dir)', async () => {
    const home = dir();
    const log = join(home, 'mint.log');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeConfig(home, { ...readConfig(home), port: 7777 });
    writeFileSync(join(home, 'run', 'server.pid'), `${process.pid}\n/x/apps/server/dist/host/main.js\n`);
    const { l, last, events } = launcher(home, { FAKE_MINT: '1', FAKE_MINT_LOG: log });
    await l.init();
    expect(last().server).toBe('external');
    // no boot link from a server it did not start: a shell without a window opens a minted one at first launch
    expect(events.at(-1)).toEqual({ event: 'open', url: 'http://127.0.0.1:7777/#/setup?token=minted' });
    await l.handle({ cmd: 'setup-link' });
    expect(events.at(-1)).toEqual({ event: 'setup-link', url: 'http://127.0.0.1:7777/#/setup?token=minted' });
    // a shell without a window (the Windows tray) opens the same kind of fresh link, never the bare address
    await l.handle({ cmd: 'open' });
    expect(events.at(-1)).toEqual({ event: 'open', url: 'http://127.0.0.1:7777/#/setup?token=minted' });
    expect(readFileSync(log, 'utf8')).toBe(`${home} http://127.0.0.1:7777\n`.repeat(3));
    await l.quit();
  });

  it('a shell without a window (the Windows tray): Open is a fresh setup link while there is no owner', async () => {
    const home = dir();
    const { l, events, last } = launcher(home, { FAKE_SETUP: '1' });
    await l.init();
    await l.handle({ cmd: 'open' });
    expect(events.at(-1)).toEqual({ event: 'open', url: `${last().url}/#/setup?token=t1` });
    await l.quit();
    // an owner exists (the server answers null): the bare address, as before
    const owned = launcher(dir());
    await owned.l.init();
    await owned.l.handle({ cmd: 'open' });
    expect(owned.events.at(-1)).toEqual({ event: 'open', url: owned.last().url });
    await owned.l.quit();
  });
});

describe('second launch hands off to the first copy\u2019s window', () => {
  function second(
    home: string,
    holder: object,
    poked: number[],
    delivered = true,
    extra: Record<string, string> = {},
  ) {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify(holder));
    const events: ShellEvent[] = [];
    const l = new Launcher({
      home,
      entry: fake,
      server: { node: process.execPath, entry: fake, env: env(extra) },
      version: '0.1.0',
      emit: (e) => events.push(e),
      userHome: join(home, 'user'),
      canShow: true,
      instanceDeps: {
        alive: () => true,
        commandOf: () => null,
        poke: (pid) => {
          poked.push(pid);
          return delivered;
        },
      },
    });
    return { l, events };
  }
  const holder = { pid: 4321, entry: fake, url: 'http://127.0.0.1:7777', serverPid: null };
  it('a holder whose shell has a window is poked, and this copy only quits', async () => {
    const poked: number[] = [];
    const { l, events } = second(dir(), { ...holder, show: true }, poked);
    expect(await l.init()).toBe(false);
    expect(poked).toEqual([4321]);
    expect(events).toEqual([{ event: 'already-running', url: holder.url, handedOff: true }]);
  });
  it('an older holder (no window in its lock) is never poked: the URL is opened as before', async () => {
    const poked: number[] = [];
    const { l, events } = second(dir(), holder, poked);
    expect(await l.init()).toBe(false);
    expect(poked).toEqual([]);
    expect(events).toEqual([{ event: 'already-running', url: holder.url, handedOff: false }]);
  });
  it('no window to hand off to and no owner yet: the browser opens a fresh setup link, never the bare address', async () => {
    const home = dir();
    const log = join(home, 'mint.log');
    const { l, events } = second(home, holder, [], true, { FAKE_MINT: '1', FAKE_MINT_LOG: log });
    expect(await l.init()).toBe(false);
    expect(events).toEqual([
      { event: 'already-running', url: `${holder.url}/#/setup?token=minted`, handedOff: false },
    ]);
    // minted from this data dir, on the first copy's address
    expect(readFileSync(log, 'utf8')).toBe(`${home} ${holder.url}\n`);
  });
  it('a poke that cannot be delivered falls back to opening the URL', async () => {
    const { l, events } = second(dir(), { ...holder, show: true }, [], false);
    expect(await l.init()).toBe(false);
    expect(events).toEqual([{ event: 'already-running', url: holder.url, handedOff: false }]);
  });
  it('the copy that holds the lock records that it can show a window, and a poke becomes `show`', async () => {
    const home = dir();
    const { l, events } = launcher(home);
    const shown = new Launcher({
      home: dir(),
      entry: fake,
      server: { node: process.execPath, entry: fake, env: env() },
      version: '0.1.0',
      emit: (e) => events.push(e),
      userHome: join(home, 'user'),
      canShow: true,
      startOnLaunch: false,
    });
    expect(await shown.init()).toBe(true);
    shown.requestShow();
    expect(events.at(-1)).toEqual({ event: 'show' });
    await shown.quit();
    // the default launcher (no window: Windows tray, Linux) records show: false, so it is never poked
    expect(await l.init()).toBe(true);
    expect(readLock(home)?.show).toBe(false);
    await l.quit();
  });
});

function runMain(home: string, pidFile: string, ...extra: string[]) {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  if (!existsSync(configPath(home))) writeConfig(home, { ...readConfig(home), port: 0, sitesPort: 0 });
  const child = spawn(
    process.execPath,
    [
      '--conditions=source',
      '--import',
      import.meta.resolve('tsx'),
      main,
      '--home',
      home,
      '--server-entry',
      fake,
      '--no-browser',
      ...extra,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], env: env({ FAKE_PID_FILE: pidFile }) },
  );
  const io = { out: '' };
  child.stdout.on('data', (d: Buffer) => {
    io.out += d.toString();
  });
  return { child, io };
}

async function until(io: { out: string }, text: string) {
  for (let i = 0; i < 300 && !io.out.includes(text); i++) await sleep(50);
  expect(io.out).toContain(text);
}

describe('single instance across processes', () => {
  it('a second copy on the same data dir starts nothing and only tells the shell to open the first', async () => {
    const home = dir();
    const first = runMain(home, join(home, 'a.pid'));
    await until(first.io, '"server":"running"');
    const url = readLock(home)!.url;
    const second = runMain(home, join(home, 'b.pid'));
    const code = await new Promise<number | null>((r) => second.child.once('exit', (c) => r(c)));
    expect(code).toBe(0);
    expect(second.io.out).toBe(`${JSON.stringify({ event: 'already-running', url, handedOff: false })}\n`);
    expect(existsSync(join(home, 'b.pid'))).toBe(false);
    first.child.stdin.end();
    await new Promise((r) => first.child.once('exit', r));
  });
  it('with a window (--window) the second copy pokes the first, which tells its shell to show the window', async () => {
    const home = dir();
    const first = runMain(home, join(home, 'a.pid'), '--window');
    await until(first.io, '"server":"running"');
    expect(readLock(home)?.show).toBe(true);
    const url = readLock(home)!.url;
    const second = runMain(home, join(home, 'b.pid'), '--window');
    const code = await new Promise<number | null>((r) => second.child.once('exit', (c) => r(c)));
    expect(code).toBe(0);
    expect(second.io.out).toBe(`${JSON.stringify({ event: 'already-running', url, handedOff: true })}\n`);
    await until(first.io, '{"event":"show"}');
    expect(existsSync(join(home, 'b.pid'))).toBe(false);
    first.child.stdin.end();
    await new Promise((r) => first.child.once('exit', r));
  });
});

describe('no orphan server', () => {
  it('killing the launcher with SIGKILL still takes the server down (the channel closes)', async () => {
    const home = dir();
    const pidFile = join(home, 'server.pid.txt');
    const { child, io } = runMain(home, pidFile);
    await until(io, '"server":"running"');
    const serverPid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(serverPid)).toBe(true);
    child.kill('SIGKILL');
    expect(await gone(serverPid)).toBe(true);
  });

  it('closing stdin (the tray app quit or crashed) stops the server and the launcher', async () => {
    const home = dir();
    const pidFile = join(home, 'server.pid.txt');
    const { child, io } = runMain(home, pidFile);
    await until(io, '"server":"running"');
    const serverPid = Number(readFileSync(pidFile, 'utf8'));
    const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(io.out).toContain('{"event":"bye"}');
    expect(alive(serverPid)).toBe(false);
    expect(existsSync(lockPath(home))).toBe(false);
  });
});
