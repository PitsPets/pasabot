/** Windows parity, proven on any OS by injecting the platform and the file system (no Windows machine needed). */
import { describe, expect, it, vi } from 'vitest';
import { findCli, userCliDirs, windowsExts } from './cli-path.js';
import {
  childTreeKiller,
  detachedGroup,
  killTree,
  resolveForSpawn,
  spawnTarget,
  UnsafeCommandError,
  WINDOWS_ENV_KEYS,
  windowsEnv,
} from './win.js';

const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

const PNPM_SHIM = [
  '@SETLOCAL',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\npx-cli\\bin\\npx-cli.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\..\\npx-cli\\bin\\npx-cli.js" %*',
  ')',
].join('\r\n');

describe('windowsEnv', () => {
  it('keeps what a Windows program needs, case-insensitively, and nothing on other platforms', () => {
    const env = { SYSTEMROOT: 'C:\\Windows', temp: 'C:\\T', APPDATA: 'C:\\A', SECRET: 'x', PATHEXT: '.EXE' };
    const w = windowsEnv(env, 'win32');
    expect(w).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\T', APPDATA: 'C:\\A', PATHEXT: '.EXE' });
    expect(Object.keys(w).every((k) => (WINDOWS_ENV_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(windowsEnv(env, 'linux')).toEqual({});
    expect(windowsEnv(env, 'darwin')).toEqual({});
  });
});

describe('killTree', () => {
  it('Windows: one taskkill of the whole tree, as an argument array (no shell)', () => {
    const calls: unknown[][] = [];
    const execFile = vi.fn((cmd: string, args: string[], opts: unknown) => {
      calls.push([cmd, args, opts]);
    });
    killTree(4242, 'SIGTERM', { platform: 'win32', execFile });
    expect(calls).toEqual([
      ['taskkill', ['/PID', '4242', '/T', '/F'], { windowsHide: true, timeout: 10_000 }],
    ]);
  });
  it('never signals a bad pid, and does not throw for a process that is gone', () => {
    const execFile = vi.fn();
    killTree(undefined, 'SIGTERM', { platform: 'win32', execFile });
    killTree(0, 'SIGTERM', { platform: 'win32', execFile });
    killTree(-5, 'SIGTERM', { platform: 'win32', execFile });
    expect(execFile).not.toHaveBeenCalled();
    expect(() => killTree(2 ** 22 + 12345, 'SIGTERM', { platform: 'linux' })).not.toThrow();
  });
  it('Windows: a child is taskkilled once, never again after it exited (its pid may belong to someone else)', () => {
    const execFile = vi.fn();
    const child = { pid: 777, exitCode: null as number | null, signalCode: null };
    const kill = childTreeKiller(child, { platform: 'win32', execFile });
    kill('SIGTERM'); // abort
    kill('SIGTERM'); // the turn's finally runs stop again
    kill('SIGKILL'); // the grace timer
    expect(execFile).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    const gone = childTreeKiller(
      { pid: 778, exitCode: 0, signalCode: null },
      { platform: 'win32', execFile: late },
    );
    gone('SIGKILL');
    expect(late).not.toHaveBeenCalled();
  });
  it('children are detached (own group) on POSIX only: Windows keeps them in the kill-on-close job', () => {
    expect(detachedGroup('win32')).toBe(false);
    expect(detachedGroup('linux')).toBe(true);
    expect(detachedGroup('darwin')).toBe(true);
  });
});

describe('spawnTarget (npm .cmd shims without cmd.exe)', () => {
  it('npm shim: runs the script on the shim’s node.exe when there is one, else this Node', () => {
    const shim = 'C:\\Users\\Peña\\AppData\\Roaming\\npm\\claude.cmd';
    const t = spawnTarget(shim, ['-p', 'line one\nline & two %PATH%'], {
      platform: 'win32',
      read: () => NPM_SHIM,
      exists: () => false,
      node: 'C:\\PasaBot\\node.exe',
    });
    expect(t).toEqual({
      cmd: 'C:\\PasaBot\\node.exe',
      args: [
        'C:\\Users\\Peña\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
        '-p',
        'line one\nline & two %PATH%', // passed as one argument, untouched
      ],
    });
    const local = spawnTarget(shim, [], {
      platform: 'win32',
      read: () => NPM_SHIM,
      exists: files('C:\\Users\\Peña\\AppData\\Roaming\\npm\\node.exe'),
    });
    expect(local.cmd).toBe('C:\\Users\\Peña\\AppData\\Roaming\\npm\\node.exe');
  });
  it('npm’s own npx.cmd / npm.cmd (Node.js installer): the bundled npx-cli.js / npm-cli.js runs on node.exe', () => {
    // the layout of npm 10's bin/npx.cmd as the Node 22 installer puts it in C:\Program Files\nodejs: the script is
    // named through %NPX_CLI_JS%, set earlier, so the "%~dp0\…" %* form never appears on the last line
    const NPX_CMD = [
      ":: Created by npm, please don't edit manually.",
      '@ECHO OFF',
      '',
      'SETLOCAL',
      '',
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'IF NOT EXIST "%NODE_EXE%" (',
      '  SET "NODE_EXE=node"',
      ')',
      '',
      'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
      'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
      'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
      '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"',
      ')',
      'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (',
      '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"',
      ')',
      '',
      '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
      '',
    ].join('\r\n');
    const NPM_CMD = NPX_CMD.replace(/NPX_CLI_JS/g, 'NPM_CLI_JS').replace(/npx-cli\.js/g, 'npm-cli.js');
    const dir = 'C:\\Program Files\\nodejs';
    const npx = spawnTarget(
      `${dir}\\npx.cmd`,
      ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\a & b'],
      {
        platform: 'win32',
        read: () => NPX_CMD,
        exists: files(`${dir}\\node.exe`, `${dir}\\node_modules\\npm\\bin\\npx-cli.js`),
      },
    );
    expect(npx).toEqual({
      cmd: `${dir}\\node.exe`,
      args: [
        `${dir}\\node_modules\\npm\\bin\\npx-cli.js`,
        '-y',
        '@modelcontextprotocol/server-filesystem',
        'C:\\a & b',
      ],
    });
    // npm i -g npm puts the same shim in %APPDATA%\npm, with no node.exe beside it: this Node runs it
    const roaming = 'C:\\Users\\Peña\\AppData\\Roaming\\npm';
    const npm = spawnTarget(`${roaming}\\npm.cmd`, ['view', 'x'], {
      platform: 'win32',
      read: () => NPM_CMD,
      exists: files(`${roaming}\\node_modules\\npm\\bin\\npm-cli.js`),
      node: 'C:\\PasaBot\\node.exe',
    });
    expect(npm).toEqual({
      cmd: 'C:\\PasaBot\\node.exe',
      args: [`${roaming}\\node_modules\\npm\\bin\\npm-cli.js`, 'view', 'x'],
    });
    // the script is missing: refused, never handed to cmd.exe
    expect(() =>
      spawnTarget(`${dir}\\npx.cmd`, [], { platform: 'win32', read: () => NPX_CMD, exists: () => false }),
    ).toThrow(UnsafeCommandError);
    // a hand-written .cmd that only looks similar (the variable set to anything) is still refused
    expect(() =>
      spawnTarget('C:\\x\\tool.cmd', [], {
        platform: 'win32',
        read: () => 'SET "NODE_EXE=evil.exe"\r\n"%NODE_EXE%" & del /q *\r\n',
        exists: () => true,
      }),
    ).toThrow(UnsafeCommandError);
  });
  it('pnpm shim: the relative script path is resolved against the shim folder', () => {
    const t = spawnTarget('C:\\pnpm\\bin\\npx.cmd', ['-y', 'pkg'], {
      platform: 'win32',
      read: () => PNPM_SHIM,
      exists: () => false,
      node: 'C:\\node\\node.exe',
    });
    expect(t).toEqual({
      cmd: 'C:\\node\\node.exe',
      args: ['C:\\pnpm\\npx-cli\\bin\\npx-cli.js', '-y', 'pkg'],
    });
  });
  it('a shim that starts an .exe starts that .exe directly', () => {
    const t = spawnTarget('C:\\x\\tool.cmd', ['a'], {
      platform: 'win32',
      read: () => '@"%~dp0\\bin\\tool.exe" %*',
    });
    expect(t).toEqual({ cmd: 'C:\\x\\bin\\tool.exe', args: ['a'] });
  });
  it('refuses a .cmd it cannot read safely, a target of another kind, and a NUL in an argument', () => {
    const o = { platform: 'win32' as const };
    expect(() => spawnTarget('C:\\x\\evil.bat', [], { ...o, read: () => 'del /q *' })).toThrow(
      UnsafeCommandError,
    );
    expect(() => spawnTarget('C:\\x\\y.cmd', [], { ...o, read: () => '"%~dp0\\run.ps1" %*' })).toThrow(
      UnsafeCommandError,
    );
    expect(() =>
      spawnTarget('C:\\x\\y.cmd', [], {
        ...o,
        read: () => {
          throw new Error('EACCES');
        },
      }),
    ).toThrow(UnsafeCommandError);
    expect(() => spawnTarget('C:\\x\\y.exe', ['a\0b'], o)).toThrow(UnsafeCommandError);
  });
  it('POSIX and Windows .exe: unchanged', () => {
    expect(spawnTarget('/usr/bin/claude', ['x'], { platform: 'linux' })).toEqual({
      cmd: '/usr/bin/claude',
      args: ['x'],
    });
    expect(spawnTarget('C:\\a\\claude.exe', ['x'], { platform: 'win32' })).toEqual({
      cmd: 'C:\\a\\claude.exe',
      args: ['x'],
    });
  });
  it('resolveForSpawn finds a bare name first (claude.exe before claude.cmd), then unwraps a shim', () => {
    const path = 'C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Users\\u\\.local\\bin';
    const exe = resolveForSpawn('claude', ['-p'], path, {
      platform: 'win32',
      read: () => NPM_SHIM,
      find: (b, p) =>
        findCli(b, p, {
          platform: 'win32',
          isFile: files(
            'C:\\Users\\u\\.local\\bin\\claude.exe',
            'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
          ),
        }),
    });
    // PATH order wins: npm's folder comes first here, so its shim is found and unwrapped
    expect(exe.cmd).toMatch(/node\.exe$|node$/);
    expect(exe.args[0]).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    );
    expect(resolveForSpawn('claude', ['-p'], '/usr/bin', { platform: 'darwin' })).toEqual({
      cmd: 'claude',
      args: ['-p'],
    });
  });
});

describe('findCli on Windows', () => {
  const path = 'C:\\Users\\u\\AppData\\Roaming\\npm;relative\\bin;C:\\Program Files\\nodejs';
  it('tries PATHEXT in order (.exe before .cmd) and never the extensionless sh shim', () => {
    const isFile = files(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.exe',
    );
    expect(findCli('claude', path, { platform: 'win32', isFile })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.exe',
    );
    const onlyCmd = files(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
    );
    expect(findCli('claude', path, { platform: 'win32', isFile: onlyCmd })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
    );
    const onlySh = files('C:\\Users\\u\\AppData\\Roaming\\npm\\claude');
    expect(findCli('claude', path, { platform: 'win32', isFile: onlySh })).toBeNull();
  });
  it('skips relative PATH entries and accepts absolute Windows paths (backslash or drive letter)', () => {
    expect(findCli('x', path, { platform: 'win32', isFile: files('relative\\bin\\x.exe') })).toBeNull();
    expect(
      findCli('C:\\tools\\claude.exe', '', { platform: 'win32', isFile: files('C:\\tools\\claude.exe') }),
    ).toBe('C:\\tools\\claude.exe');
    expect(
      findCli('C:\\tools\\claude', '', { platform: 'win32', isFile: files('C:\\tools\\claude.cmd') }),
    ).toBe('C:\\tools\\claude.cmd');
    expect(findCli('tools\\claude.exe', '', { platform: 'win32', isFile: () => true })).toBeNull();
  });
  it('PATHEXT is honoured but only program types count', () => {
    expect(windowsExts('.CMD;.EXE;.JS;.PS1')).toEqual(['.CMD', '.EXE']);
    expect(windowsExts(undefined)).toEqual(['.COM', '.EXE', '.BAT', '.CMD']);
  });
  it('per-user install folders on Windows: npm, the native installers, the free starter', () => {
    const d = userCliDirs('C:\\Users\\u', 'win32', { APPDATA: 'D:\\Roam', LOCALAPPDATA: 'D:\\Local' });
    expect(d).toContain('D:\\Roam\\npm');
    expect(d).toContain('C:\\Users\\u\\.local\\bin');
    expect(d).toContain('D:\\Local\\PasaBot\\bin');
  });
});
