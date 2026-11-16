/** Pure launcher pieces: port pick, single instance, settings, open-at-login, update check, strings, wire. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { autostartContent, autostartFile, isAutostartOn, setAutostart } from './autostart.js';
import { configPath, DEFAULT_CONFIG, readConfig, writeConfig } from './config.js';
import { acquireInstance, type InstanceDeps, lockPath, readLock } from './instance.js';
import { parseCommand } from './main.js';
import { pickPort, portFree } from './ports.js';
import { loadStrings, pickLocale, t } from './strings.js';
import { checkForUpdate, compareVersions, type Fetcher } from './update.js';

const scratch = mkdtempSync(join(tmpdir(), 'pasabot-desktop-units-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = () => join(scratch, `d${n++}`);

const hold = (): Promise<Server> =>
  new Promise((r) => {
    const s = createServer();
    s.listen({ port: 0, host: '127.0.0.1' }, () => r(s));
  });

describe('port pick', () => {
  it('keeps the preferred port while it is free', async () => {
    const s = await hold();
    const port = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    expect(await portFree(port)).toBe(true);
    expect(await pickPort(port)).toBe(port);
  });
  it('asks for 0 (a free port chosen by the OS) when the preferred one is taken', async () => {
    const s = await hold();
    const port = (s.address() as { port: number }).port;
    expect(await portFree(port)).toBe(false);
    expect(await pickPort(port)).toBe(0);
    await new Promise((r) => s.close(r));
  });
  it('asks for 0 on a nonsense preference', async () => {
    expect(await pickPort(0)).toBe(0);
    expect(await pickPort(70000)).toBe(0);
    expect(await pickPort(1.5)).toBe(0);
  });
});

describe('single instance', () => {
  const live = (cmd: string | null): InstanceDeps => ({ alive: () => true, commandOf: () => cmd });
  it('a second copy is refused and learns the first one\u2019s URL', () => {
    const home = dir();
    const first = acquireInstance(home, '/app/launcher.js', live(null), 1001);
    expect(first.ok).toBe(true);
    if (first.ok) first.lock.update({ url: 'http://127.0.0.1:7777', serverPid: 2002 });
    const second = acquireInstance(home, '/app/launcher.js', live('node /app/launcher.js'), 1002);
    expect(second).toEqual({
      ok: false,
      holder: {
        pid: 1001,
        entry: '/app/launcher.js',
        url: 'http://127.0.0.1:7777',
        serverPid: 2002,
        show: false,
      },
    });
    expect(statSync(lockPath(home)).mode & 0o777).toBe(0o600);
  });
  it('a lock left by a dead launcher is taken over', () => {
    const home = dir();
    acquireInstance(home, '/app/launcher.js', live(null), 1001);
    const next = acquireInstance(
      home,
      '/app/launcher.js',
      { alive: () => false, commandOf: () => null },
      1003,
    );
    expect(next.ok).toBe(true);
    expect(readLock(home)?.pid).toBe(1003);
  });
  it('a lock whose pid now belongs to another program (pid reuse) is taken over', () => {
    const home = dir();
    acquireInstance(home, '/app/launcher.js', live(null), 1001);
    const next = acquireInstance(home, '/app/launcher.js', live('/usr/bin/something-else'), 1004);
    expect(next.ok).toBe(true);
  });
  it('a garbled lock is taken over; release removes only our own lock', () => {
    const home = dir();
    acquireInstance(home, '/app/launcher.js', live(null), 1001);
    writeFileSync(lockPath(home), 'not json');
    const mine = acquireInstance(home, '/app/launcher.js', live(null), 1005);
    expect(mine.ok).toBe(true);
    // someone else's lock replaced ours: releasing must not delete theirs
    writeFileSync(lockPath(home), JSON.stringify({ pid: 4242, entry: '/x', url: null, serverPid: null }));
    if (mine.ok) mine.lock.release();
    expect(readLock(home)?.pid).toBe(4242);
  });
});

describe('settings', () => {
  it('defaults when missing or garbled; update check off by default', () => {
    const home = dir();
    expect(readConfig(home)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.updateCheck).toBe(false);
    writeConfig(home, { ...DEFAULT_CONFIG });
    writeFileSync(configPath(home), '{"port":"x","updateCheck":"yes","updateUrl":"http://plain"}');
    expect(readConfig(home)).toEqual(DEFAULT_CONFIG);
  });
  it('round-trips and is private (0600)', () => {
    const home = dir();
    const c = {
      port: 9000,
      sitesPort: 9001,
      updateCheck: true,
      updateUrl: 'https://example.test/latest.json',
    };
    writeConfig(home, c);
    expect(readConfig(home)).toEqual(c);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });
});

describe('open at login', () => {
  it('macOS: a LaunchAgent that opens the app, escaped, on/off by file', () => {
    const userHome = dir();
    const target = { platform: 'darwin' as const, userHome, appPath: '/Applications/Pasa & Bot.app' };
    expect(autostartFile(target)).toBe(join(userHome, 'Library/LaunchAgents/local.pasabot.desktop.plist'));
    expect(isAutostartOn(target)).toBe(false);
    setAutostart(target, true);
    const xml = readFileSync(autostartFile(target), 'utf8');
    expect(xml).toContain('<string>/usr/bin/open</string>');
    expect(xml).toContain('<string>/Applications/Pasa &amp; Bot.app</string>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(isAutostartOn(target)).toBe(true);
    setAutostart(target, false);
    expect(isAutostartOn(target)).toBe(false);
  });
  it('Linux: an XDG autostart entry with a quoted Exec', () => {
    const t1 = { platform: 'linux' as const, userHome: '/home/u', appPath: '/opt/pasa bot/run "x" $y' };
    expect(autostartFile(t1)).toBe('/home/u/.config/autostart/pasabot.desktop');
    expect(autostartContent(t1)).toContain('Exec="/opt/pasa bot/run \\"x\\" \\$y"');
  });
  it('Windows: a Startup-folder script; refuses quotes and line breaks', () => {
    const t2 = { platform: 'win32' as const, userHome: 'C:\\Users\\u', appPath: 'C:\\PasaBot\\PasaBot.cmd' };
    expect(autostartFile(t2)).toContain(join('Startup', 'PasaBot.cmd'));
    expect(autostartContent(t2)).toBe('@echo off\r\ncall "C:\\PasaBot\\PasaBot.cmd"\r\n');
    expect(autostartContent({ ...t2, appPath: 'C:\\PasaBot\\PasaBot.exe' })).toBe(
      '@echo off\r\nstart "" "C:\\PasaBot\\PasaBot.exe"\r\n',
    );
    expect(() => autostartContent({ ...t2, appPath: 'C:\\a"b' })).toThrow();
    expect(() => autostartContent({ ...t2, platform: 'darwin', appPath: '/a\n/b' })).toThrow();
  });
});

describe('update check', () => {
  const reply =
    (body: unknown, status = 200): Fetcher =>
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  it('orders versions', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1', '1.0.0')).toBeNull();
  });
  it('does nothing while off, and needs an https source', async () => {
    let called = false;
    const spy: Fetcher = async () => {
      called = true;
      return new Response('{}');
    };
    expect(
      await checkForUpdate({ enabled: false, current: '0.1.0', url: 'https://x.test/l.json', fetcher: spy }),
    ).toEqual({ status: 'off' });
    expect(await checkForUpdate({ enabled: true, current: '0.1.0', url: null, fetcher: spy })).toEqual({
      status: 'no-source',
    });
    expect(
      (await checkForUpdate({ enabled: true, current: '0.1.0', url: 'http://x.test/l', fetcher: spy }))
        .status,
    ).toBe('failed');
    expect(called).toBe(false);
  });
  it('reads one static file with a plain GET (nothing about the machine is sent) and reports a newer version', async () => {
    const seen: { url: string; o: unknown }[] = [];
    const fetcher: Fetcher = async (url, o) => {
      seen.push({ url, o });
      return new Response(JSON.stringify({ version: '0.2.0', page: 'https://example.test/download' }));
    };
    const r = await checkForUpdate({
      enabled: true,
      current: '0.1.0',
      url: 'https://example.test/l.json',
      fetcher,
    });
    expect(r).toEqual({
      status: 'available',
      info: { version: '0.2.0', page: 'https://example.test/download' },
    });
    expect(seen).toEqual([
      {
        url: 'https://example.test/l.json',
        o: expect.objectContaining({
          method: 'GET',
          headers: { accept: 'application/json' },
          maxBytes: 65536,
        }),
      },
    ]);
    expect((seen[0]!.o as { body?: unknown }).body).toBeUndefined();
  });
  it('same or older is current; junk fails; a non-https page is dropped', async () => {
    const base = { enabled: true, current: '0.2.0', url: 'https://example.test/l.json' };
    expect(await checkForUpdate({ ...base, fetcher: reply({ version: '0.2.0' }) })).toEqual({
      status: 'current',
    });
    expect(await checkForUpdate({ ...base, fetcher: reply({ version: '0.1.0' }) })).toEqual({
      status: 'current',
    });
    expect((await checkForUpdate({ ...base, fetcher: reply('<html>') })).status).toBe('failed');
    expect((await checkForUpdate({ ...base, fetcher: reply({ version: 'latest' }) })).status).toBe('failed');
    expect((await checkForUpdate({ ...base, fetcher: reply({}, 500) })).status).toBe('failed');
    expect(
      await checkForUpdate({ ...base, fetcher: reply({ version: '0.3.0', page: 'javascript:alert(1)' }) }),
    ).toEqual({ status: 'available', info: { version: '0.3.0', page: null } });
  });
});

describe('strings and wire', () => {
  it('en and fil have the same keys; locale tags map to what we ship', () => {
    const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as object;
    const fil = JSON.parse(readFileSync(new URL('../locales/fil.json', import.meta.url), 'utf8')) as object;
    expect(Object.keys(fil).sort()).toEqual(Object.keys(en).sort());
    expect(pickLocale('fil-PH')).toBe('fil');
    expect(pickLocale('tl_PH.UTF-8')).toBe('fil');
    expect(pickLocale('de-DE')).toBe('en');
    expect(pickLocale(undefined)).toBe('en');
    expect(t(loadStrings('en'), 'update.available', { version: '1.2.3' })).toBe('Version 1.2.3 is available');
  });
  it('only known commands pass the wire', () => {
    expect(parseCommand('{"cmd":"stop-all"}')).toEqual({ cmd: 'stop-all' });
    expect(parseCommand('{"cmd":"setup-link"}')).toEqual({ cmd: 'setup-link' });
    expect(parseCommand('{"cmd":"setup-link","url":"http://evil.example/"}')).toEqual({ cmd: 'setup-link' });
    expect(parseCommand('{"cmd":"autostart","on":true}')).toEqual({ cmd: 'autostart', on: true });
    expect(parseCommand('{"cmd":"update-check","on":"yes"}')).toEqual({ cmd: 'update-check', on: false });
    expect(parseCommand('{"cmd":"rm -rf"}')).toBeNull();
    expect(parseCommand('nope')).toBeNull();
  });
  it('a first line from Windows PowerShell 5.1 under code page 65001 (BOM, CRLF) is still understood', () => {
    // .NET Framework's stdin writer starts with a UTF-8 BOM; readline keeps it on the first line
    expect(parseCommand('﻿{"cmd":"setup-link"}')).toEqual({ cmd: 'setup-link' });
    expect(parseCommand('﻿{"cmd":"setup-link"}\r')).toEqual({ cmd: 'setup-link' });
    // only one leading mark is dropped, and nothing else changes what passes the wire
    expect(parseCommand('﻿﻿{"cmd":"setup-link"}')).toBeNull();
    expect(parseCommand('﻿{"cmd":"rm -rf"}')).toBeNull();
    expect(parseCommand('﻿')).toBeNull();
  });
});
