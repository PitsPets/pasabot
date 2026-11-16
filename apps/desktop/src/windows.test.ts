/**
 * The desktop launcher's Windows and Linux paths, proven on this Mac by injecting the platform, the process table,
 * the registry and the file system (nothing here starts a browser or PowerShell). What only a real Windows PC can
 * prove is listed in docs/WINDOWS.md and checked by windows/selftest.ps1.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appWindowArgs,
  appWindowCommand,
  type BrowserProbe,
  linuxBrowsers,
  parseRegDefault,
  windowsBrowsers,
} from './app-window.js';
import {
  autostartContent,
  autostartFile,
  autostartPossible,
  cmdSafePath,
  setAutostart,
} from './autostart.js';
import { acquireInstance, commandOf, windowsCommandLineScript, windowsPowerShell } from './instance.js';
import { createOpener, type Spawned } from './opener.js';

const tmp = mkdtempSync(join(tmpdir(), 'pb-desk-win-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('single instance on Windows (pid reuse after a crash or reboot)', () => {
  it('reads the holder’s command line through PowerShell by full path, the pid as a number only', () => {
    const calls: [string, string[]][] = [];
    const out = commandOf(4242, 'win32', (cmd, args) => {
      calls.push([cmd, args]);
      const line = '"C:\\PB\\node.exe" "C:\\PB\\pasabot\\apps\\desktop\\dist\\main.js" --open-urls';
      return { status: 0, stdout: `${Buffer.from(line, 'utf8').toString('base64')}\r\n` };
    });
    expect(out).toContain('main.js');
    expect(calls[0]?.[0]).toBe(windowsPowerShell(process.env));
    expect(calls[0]?.[1].at(-1)).toBe(windowsCommandLineScript(4242));
    expect(windowsCommandLineScript(4242)).toContain('ProcessId=4242');
    expect(commandOf(-1, 'win32', () => ({ status: 0, stdout: 'x' }))).toBeNull();
    expect(commandOf(5, 'win32', () => ({ status: 1, stdout: '' }))).toBeNull();
    expect(commandOf(5, 'win32', () => ({ status: 0, stdout: '' }))).toBe('');
  });
  it('a user folder with ñ (C:\\Users\\Peña) survives the console code page: the live launcher keeps its lock', () => {
    const entry =
      'C:\\Users\\Peña\\AppData\\Local\\Programs\\PasaBot\\PasaBot\\pasabot\\apps\\desktop\\dist\\main.js';
    const run = () => ({
      status: 0,
      stdout: Buffer.from(`"C:\\node.exe" "${entry}" --open-urls`, 'utf8').toString('base64'),
    });
    expect(windowsCommandLineScript(7)).toContain('ToBase64String');
    const cmd = commandOf(7, 'win32', run);
    expect(cmd).toContain(entry);
    const home = mkdtempSync(join(tmp, 'pena-'));
    expect(acquireInstance(home, entry, { alive: () => false, commandOf: () => null }, 7).ok).toBe(true);
    const second = acquireInstance(
      home,
      entry,
      { alive: () => true, commandOf: (p) => commandOf(p, 'win32', run) },
      8,
    );
    expect(second.ok).toBe(false);
  });
  it('a lock whose pid now runs another program is taken over; a live launcher (any capitals) is not', () => {
    const home = mkdtempSync(join(tmp, 'h-'));
    const entry = 'C:\\Users\\Peña\\AppData\\Local\\Programs\\PasaBot\\pasabot\\apps\\desktop\\dist\\main.js';
    const first = acquireInstance(home, entry, { alive: () => false, commandOf: () => null }, 1111);
    expect(first.ok).toBe(true);
    // after a reboot pid 1111 is svchost: stale, taken over
    const reused = acquireInstance(
      home,
      entry,
      { alive: () => true, commandOf: () => 'C:\\Windows\\System32\\svchost.exe -k netsvcs' },
      2222,
    );
    expect(reused.ok).toBe(true);
    // the real launcher, spelled with other capitals by the shell: still ours, so this copy hands over
    const held = acquireInstance(
      home,
      entry,
      { alive: () => true, commandOf: () => `"node.exe" "${entry.toUpperCase()}"` },
      3333,
    );
    expect(held.ok).toBe(false);
  });
});

describe('open at login on Windows and Linux', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\Peña\\AppData\\Local',
    APPDATA: 'C:\\Users\\Peña\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\Peña',
  };
  it('the Startup script names %LOCALAPPDATA%, never the user folder (cmd.exe reads .cmd in the OEM code page)', () => {
    const t = {
      platform: 'win32' as const,
      userHome: 'C:\\Users\\Peña',
      appPath: 'C:\\Users\\Peña\\AppData\\Local\\Programs\\PasaBot\\PasaBot.cmd',
      env,
    };
    const body = autostartContent(t);
    expect(body).toBe('@echo off\r\ncall "%LOCALAPPDATA%\\Programs\\PasaBot\\PasaBot.cmd"\r\n');
    expect(/^[\x20-\x7e\r\n]*$/.test(body)).toBe(true);
  });
  it('a path cmd.exe could misread makes the toggle unavailable instead of silently broken', () => {
    expect(cmdSafePath('D:\\Programmé\\PasaBot.cmd', env)).toBeNull();
    expect(cmdSafePath('D:\\100%\\PasaBot.cmd', env)).toBeNull();
    expect(cmdSafePath('D:\\a&b\\PasaBot.cmd', env)).toBeNull();
    expect(cmdSafePath('D:\\Apps\\PasaBot\\PasaBot.cmd', env)).toBe('D:\\Apps\\PasaBot\\PasaBot.cmd');
    expect(
      autostartPossible({ platform: 'win32', userHome: 'C:\\x', appPath: 'D:\\Programmé\\PasaBot.cmd', env }),
    ).toBe(false);
  });
  it('a redirected roaming profile: the Startup folder under %APPDATA%', () => {
    const f = autostartFile({
      platform: 'win32',
      userHome: 'C:\\Users\\u',
      appPath: 'x',
      appData: '\\\\srv\\u\\Roaming',
    });
    expect(f).toContain('\\\\srv\\u\\Roaming');
    expect(f).toMatch(/Startup.PasaBot\.cmd$/);
  });
  it('Linux: $XDG_CONFIG_HOME/autostart when it is set', () => {
    const xdg = join(tmp, 'xdg');
    const t = {
      platform: 'linux' as const,
      userHome: tmp,
      appPath: '/opt/pasabot/pasabot',
      env: { XDG_CONFIG_HOME: xdg },
    };
    expect(autostartFile(t)).toBe(join(xdg, 'autostart', 'pasabot.desktop'));
    setAutostart(t, true);
    expect(readFileSync(join(xdg, 'autostart', 'pasabot.desktop'), 'utf8')).toContain(
      'Exec="/opt/pasabot/pasabot"',
    );
    expect(autostartFile({ ...t, env: { XDG_CONFIG_HOME: 'relative' } })).toBe(
      join(tmp, '.config', 'autostart', 'pasabot.desktop'),
    );
  });
});

const probe = (files: string[], reg: Record<string, string> = {}): BrowserProbe => ({
  exists: (p) => files.includes(p),
  regDefault: (k) => reg[k] ?? null,
});

describe('app window without any SDK (an installed Chromium-family browser in app mode)', () => {
  const env = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  it('Windows: Edge from App Paths first, then known folders, then Chrome', () => {
    const p = probe([edge, chrome], {
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe': edge,
    });
    expect(windowsBrowsers(env, p)).toEqual([edge, chrome]);
    expect(windowsBrowsers(env, probe([chrome]))).toEqual([chrome]);
    expect(windowsBrowsers(env, probe([]))).toEqual([]);
    // a registry value naming something that is not an absolute .exe is ignored
    expect(
      windowsBrowsers(
        env,
        probe([], {
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe': 'cmd /c x',
        }),
      ),
    ).toEqual([]);
  });
  it('reads reg query output, quoted or with %VARS%', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\...\\msedge.exe\r\n    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"\r\n';
    expect(parseRegDefault(out)).toBe(edge);
    expect(parseRegDefault('    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\x\\chrome.exe')).toBe(
      '%LOCALAPPDATA%\\x\\chrome.exe',
    );
    expect(parseRegDefault('ERROR: nothing')).toBeNull();
  });
  it('the command: app mode on the link, PasaBot’s own profile in the data folder, as an argument array', () => {
    const url = 'http://127.0.0.1:7777/#/setup?token=abc&x=1';
    const c = appWindowCommand('win32', url, { home: 'C:\\Users\\u\\.pasabot', env, probe: probe([edge]) });
    expect(c).toEqual([edge, appWindowArgs(url, 'C:\\Users\\u\\.pasabot\\app-window')]);
    expect(c?.[1][0]).toBe(`--app=${url}`); // one argument, `&` and `#` untouched
    expect(appWindowCommand('darwin', url, { home: '/h', env: {}, probe: probe([]) })).toBeNull();
  });
  it('Linux: chromium / google-chrome / brave on PATH', () => {
    expect(
      linuxBrowsers('/usr/bin:/snap/bin', probe(['/snap/bin/chromium', '/usr/bin/google-chrome'])),
    ).toEqual(['/snap/bin/chromium', '/usr/bin/google-chrome']);
    expect(
      appWindowCommand('linux', 'http://127.0.0.1:1/', {
        home: '/h',
        env: { PATH: '/usr/bin' },
        probe: probe([]),
      }),
    ).toBeNull();
  });
  it('the opener tries the app window first, then the default browser when it cannot start', () => {
    const tried: [string, string[]][] = [];
    const failing: Spawned = {
      on: (_e, l) => setImmediate(() => l(Object.assign(new Error('x'), { code: 'EACCES' }))),
    };
    const ok: Spawned = { on: () => undefined };
    const open = createOpener(
      'win32',
      (cmd, args) => {
        tried.push([cmd, args]);
        return tried.length === 1 ? failing : ok;
      },
      (url) => [edge, appWindowArgs(url, 'C:\\p')],
    );
    expect(open('http://127.0.0.1:7777/')).toBe(true);
    return new Promise<void>((resolve) =>
      setImmediate(() =>
        setImmediate(() => {
          expect(tried.map((t) => t[0])).toEqual([edge, 'rundll32.exe']);
          resolve();
        }),
      ),
    );
  });
});
