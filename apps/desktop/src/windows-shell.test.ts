/**
 * The Windows shell without PowerShell (code signing, Smart App Control): start, stop, folder links and uninstall run
 * by node.exe alone; the tray only where PowerShell runs it in Full Language mode. Proven here with the platform
 * injected; the real Windows run is windows/selftest.ps1 → dist/selftest.js on the installed copy.
 * Also the executable inventory (scripts/windows-binaries.mjs) on a folder made here: never a real binary run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { lockPath } from './instance.js';
import {
  inside,
  installLayout,
  type LinkFs,
  launcherAlone,
  links,
  localeTag,
  readLinks,
  type ShellDeps,
  start,
  stop,
  stopRequestPath,
  TRAY_PROBE_EXIT,
  trayArgs,
  trayStateOf,
  watchStopRequest,
} from './windows-shell.js';

const tmp = mkdtempSync(join(tmpdir(), 'pb-win-shell-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const SELF =
  'C:\\Users\\Peña\\AppData\\Local\\Programs\\PasaBot\\pasabot\\apps\\desktop\\dist\\windows-shell.js';

describe('the Windows starter (node.exe only; the tray only in Full Language mode)', () => {
  const l = installLayout(SELF);
  it('finds the install from where it sits', () => {
    expect(l.install).toBe('C:\\Users\\Peña\\AppData\\Local\\Programs\\PasaBot');
    expect(l.node).toBe(`${l.install}\\node.exe`);
    expect(l.launcher).toBe(`${l.install}\\pasabot\\apps\\desktop\\dist\\main.js`);
    expect(l.tray).toBe(`${l.install}\\PasaBotTray.ps1`);
    expect(l.links).toBe(`${l.install}\\links.json`);
  });

  const deps = (status: number | null, error?: unknown) => {
    const launched: { cmd: string; args: string[]; log: string | null }[] = [];
    const probes: string[][] = [];
    const d: ShellDeps = {
      env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Peña' },
      probe: (_c, a) => {
        probes.push(a);
        return { status, error };
      },
      launch: (cmd, args, _cwd, log) => launched.push({ cmd, args, log }),
      locale: () => 'fil-PH',
    };
    return { d, launched, probes };
  };

  it('Full Language: the probe passes, so the tray starts (it runs the launcher, as before)', () => {
    const { d, launched, probes } = deps(TRAY_PROBE_EXIT.ok);
    expect(start(l, false, d)).toBe('tray');
    expect(probes[0]).toContain('-Probe');
    expect(launched).toHaveLength(1);
    expect(launched[0]?.cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(launched[0]?.args).toEqual(trayArgs(l, false));
    expect(launched[0]?.args).not.toContain('-Probe');
  });

  it('Constrained Language Mode, no WinForms or no PowerShell: the launcher alone, with its own window', () => {
    for (const [status, error, state] of [
      [TRAY_PROBE_EXIT.constrained, undefined, 'constrained'],
      [TRAY_PROBE_EXIT.noWinForms, undefined, 'no-winforms'],
      [1, undefined, 'constrained'],
      [null, new Error('ENOENT'), 'no-powershell'],
    ] as const) {
      const { d, launched } = deps(status, error);
      expect(start(l, true, d)).toBe(state);
      expect(launched[0]?.cmd).toBe(l.node);
      expect(launched[0]?.args).toEqual(launcherAlone(l, 'fil-PH', true));
      expect(launched[0]?.args).toEqual(
        expect.arrayContaining(['--no-stdin', '--open-urls', '--app-window']),
      );
      expect(launched[0]?.log).toMatch(/\.pasabot[\\/]logs[\\/]desktop\.log$/);
    }
    expect(trayStateOf({ status: 0 })).toBe('tray');
  });

  it('only a plain language tag reaches the launcher', () => {
    expect(localeTag('pt-BR')).toBe('pt-BR');
    expect(localeTag('en-US-u-ca-gregory')).toBe('en-US');
    expect(localeTag('x; rm')).toBeNull();
    expect(localeTag(undefined)).toBeNull();
  });
});

describe('stop (Windows has no signals: a request file in the data folder)', () => {
  const launcher = 'C:\\PB\\pasabot\\apps\\desktop\\dist\\main.js';
  const lockIn = (pid: number) => {
    const home = mkdtempSync(join(tmp, 'home-'));
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify({ pid, entry: launcher, url: null, serverPid: null }));
    return home;
  };

  it('a launcher that quits when asked: stopped, never killed', async () => {
    const home = lockIn(4321);
    let up = true;
    const killed: number[] = [];
    const r = await stop(home, launcher, {
      alive: () => up,
      commandOf: () => `"C:\\PB\\node.exe" "${launcher.toUpperCase()}" --no-stdin`,
      kill: (p) => killed.push(p),
      sleep: async () => {
        // the launcher reads the request and quits
        expect(readFileSync(stopRequestPath(home), 'utf8')).toBe('4321');
        up = false;
      },
    });
    expect(r).toBe('stopped');
    expect(killed).toEqual([]);
  });

  it('one of ours that does not quit in time is ended (its tree), and the request is cleared', async () => {
    const home = lockIn(55);
    const killed: number[] = [];
    const r = await stop(
      home,
      launcher,
      {
        alive: () => true,
        commandOf: () => `"C:\\PB\\node.exe" "${launcher}"`,
        kill: (p) => killed.push(p),
        sleep: async () => {},
      },
      1000,
    );
    expect(r).toBe('forced');
    expect(killed).toEqual([55]);
    expect(existsSync(stopRequestPath(home))).toBe(false);
  });

  it('a command line that cannot be read is never killed: asked only, reported as unknown', async () => {
    const home = lockIn(56);
    const killed: number[] = [];
    const r = await stop(
      home,
      launcher,
      { alive: () => true, commandOf: () => null, kill: (p) => killed.push(p), sleep: async () => {} },
      1000,
    );
    expect(r).toBe('unknown');
    expect(killed).toEqual([]);
    // the ask stays for a launcher that is only slow; a launcher with another pid removes it unread
    expect(readFileSync(stopRequestPath(home), 'utf8')).toBe('56');
  });

  it('a command line that cannot be read, but the launcher quits when asked: stopped', async () => {
    const home = lockIn(57);
    let up = true;
    const r = await stop(home, launcher, {
      alive: () => up,
      commandOf: () => null,
      kill: () => {
        throw new Error('never killed');
      },
      sleep: async () => {
        up = false;
      },
    });
    expect(r).toBe('stopped');
  });

  it('nothing running, or a pid that now runs another program: left alone', async () => {
    const none = mkdtempSync(join(tmp, 'none-'));
    const d = {
      alive: () => true,
      commandOf: () => 'C:\\Windows\\svchost.exe',
      kill: () => {},
      sleep: async () => {},
    };
    expect(await stop(none, launcher, d)).toBe('not-running');
    expect(await stop(lockIn(9), launcher, d)).toBe('other-install');
    expect(await stop(lockIn(9), launcher, { ...d, alive: () => false })).toBe('not-running');
  });

  it('the launcher acts on a request naming its own pid only', async () => {
    const home = mkdtempSync(join(tmp, 'watch-'));
    mkdirSync(join(home, 'run'));
    let stops = 0;
    const cancel = watchStopRequest(home, 777, () => stops++, 10);
    writeFileSync(stopRequestPath(home), '778');
    await new Promise((r) => setTimeout(r, 60));
    expect(stops).toBe(0);
    expect(existsSync(stopRequestPath(home))).toBe(false);
    writeFileSync(stopRequestPath(home), '777\r\n');
    await new Promise((r) => setTimeout(r, 60));
    expect(stops).toBe(1);
    cancel();
  });
});

describe('folder links (the installed copy’s workspace junctions, was links.ps1)', () => {
  const base = 'C:\\PB\\pasabot';
  const fakeFs = (links: Record<string, string>, dirs: string[]) => {
    const made: [string, string][] = [];
    const removed: string[] = [];
    const fs: LinkFs = {
      isLink: (p) => p in links,
      linkTarget: (p) => links[p] ?? null,
      exists: (p) => p in links || dirs.includes(p),
      makeJunction: (p, t) => {
        made.push([p, t]);
        links[p] = t;
      },
      removeLink: (p) => {
        removed.push(p);
        delete links[p];
      },
    };
    return { fs, made, removed };
  };
  const list = [{ path: 'node_modules\\@pasabot\\core', target: 'packages\\core' }];

  it('makes each junction, checks it, removes it as a link only', () => {
    const { fs, made, removed } = fakeFs({}, [`${base}\\packages\\core`]);
    expect(links(base, list, 'check', fs)).toEqual(['missing link: node_modules\\@pasabot\\core']);
    expect(links(base, list, 'make', fs)).toEqual([]);
    expect(made).toEqual([[`${base}\\node_modules\\@pasabot\\core`, `${base}\\packages\\core`]]);
    expect(links(base, list, 'check', fs)).toEqual([]);
    expect(links(base, list, 'make', fs)).toEqual([]);
    expect(made).toHaveLength(1);
    expect(links(base, list, 'remove', fs)).toEqual([]);
    expect(removed).toEqual([`${base}\\node_modules\\@pasabot\\core`]);
  });

  it('never outside the install, never over a real folder, and a wrong link is put right', () => {
    const { fs } = fakeFs({ [`${base}\\node_modules\\x`]: 'C:\\elsewhere' }, [
      `${base}\\real`,
      `${base}\\packages\\x`,
    ]);
    expect(
      links(
        base,
        [
          { path: '..\\..\\Windows\\x', target: 'packages\\core' },
          { path: 'node_modules\\y', target: '..\\..\\Users' },
          { path: 'real', target: 'packages\\x' },
        ],
        'make',
        fs,
      ),
    ).toEqual([
      'refused (outside the install): ..\\..\\Windows\\x',
      'refused (outside the install): node_modules\\y',
      'in the way (not a link): real',
    ]);
    expect(links(base, [{ path: 'node_modules\\x', target: 'packages\\x' }], 'check', fs)).toEqual([
      'wrong link: node_modules\\x',
    ]);
    expect(links(base, [{ path: 'node_modules\\x', target: 'packages\\x' }], 'make', fs)).toEqual([]);
    expect(fs.linkTarget(`${base}\\node_modules\\x`)).toBe(`${base}\\packages\\x`);
    expect(inside(base, base)).toBe(false);
  });

  it('reads links.json as build-windows.ps1 writes it (UTF-8, maybe a BOM, maybe one object)', () => {
    const f = join(tmp, 'links.json');
    writeFileSync(f, `\ufeff${JSON.stringify(list)}`);
    expect(readLinks(f)).toEqual(list);
    writeFileSync(f, JSON.stringify(list[0]));
    expect(readLinks(f)).toEqual(list);
    expect(readLinks(join(tmp, 'missing.json'))).toBeNull();
  });
});

type Entry = { path: string; kind: string; action: string; origin: string; sha256: string; machine?: string };
const inventory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'windows-binaries.mjs',
);
const m = (await import(pathToFileURL(inventory).href)) as {
  scan(root: string, built?: unknown): Entry[];
  strictProblems(e: Entry[]): string[];
  peInfo(b: Buffer): { machine: string; embeddedSignature: boolean } | null;
  kindOf(rel: string, head: Buffer | null): string | null;
};

describe('the Windows executable inventory (scripts/windows-binaries.mjs)', () => {
  /** a minimal PE32+ header: MZ, e_lfanew, PE\0\0, machine, optional header magic, security directory */
  const pe = (machine: number, signed: boolean) => {
    const b = Buffer.alloc(512);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    b.writeUInt32LE(0x00004550, 0x80);
    b.writeUInt16LE(machine, 0x84);
    b.writeUInt16LE(0x20b, 0x98);
    if (signed) b.writeUInt32LE(0x1000, 0x98 + 112 + 32 + 4);
    return b;
  };
  const put = (root: string, rel: string, data: Buffer | string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
  };

  it('reads the CPU and whether a signature is embedded from the PE headers', () => {
    expect(m.peInfo(pe(0x8664, false))).toEqual({ machine: 'x64', embeddedSignature: false });
    expect(m.peInfo(pe(0xaa64, true))).toEqual({ machine: 'arm64', embeddedSignature: true });
    expect(m.peInfo(Buffer.from('#!/bin/sh'))).toBeNull();
    expect(m.kindOf('a/b.txt', pe(0x8664, false))).toBe('pe');
    expect(m.kindOf('a/b.ps1', null)).toBe('script');
    expect(m.kindOf('a/b.js', Buffer.from('//'))).toBeNull();
  });

  it('the self-test report never carries a code; access lists come as code units (any console code page)', async () => {
    const s = await import('./selftest.js');
    expect(s.hideCodes('http://x/#/setup?token=abc123 "password":"pw" Bearer xyz')).toBe(
      'http://x/#/setup?token=<hidden> "password":"<hidden>" Bearer <hidden>',
    );
    const units = (t: string) => Array.from(t, (c) => c.charCodeAt(0)).join(',');
    const a = s.parseAcl(
      `me:${units('PC\\Peña')}\r\nprot:True\r\nid:${units('PC\\PEÑA')}\r\nid:${units('BUILTIN\\Users')}\r\n`,
    );
    expect(a).toEqual({ me: 'PC\\Peña', protectedList: true, ids: ['PC\\PEÑA', 'BUILTIN\\Users'] });
    expect(s.others(a!)).toEqual(['BUILTIN\\Users']);
    expect(s.parseAcl('Cannot invoke method')).toBeNull();
    // no .NET static method call: it may also run in Constrained Language Mode
    expect(s.ACL_SCRIPT).not.toMatch(/\]::/);
    const rows = [
      { check: 'a', result: 'PASS' as const, detail: '' },
      { check: 'b', result: 'INFO' as const, detail: 'no tray' },
    ];
    expect(s.summary(rows)).toEqual({ fail: 0, text: 'ALL GOOD: 1 passed, 0 skipped' });
    expect(s.summary([...rows, { check: 'c', result: 'FAIL' as const, detail: 'x' }]).fail).toBe(1);
  });

  it('lists what Windows may run, with its origin and what the release does; --strict catches strays', () => {
    const root = mkdtempSync(join(tmp, 'payload-'));
    put(root, 'node.exe', pe(0x8664, true));
    put(root, 'PasaBotTray.ps1', 'param()');
    put(root, 'PasaBot.cmd', '@echo off');
    put(root, 'pasabot/apps/server/dist/main.js', 'export {}');
    put(
      root,
      'pasabot/node_modules/better-sqlite3/package.json',
      '{"name":"better-sqlite3","version":"13.1.1"}',
    );
    const engine = pe(0x8664, false);
    put(root, 'pasabot/node_modules/better-sqlite3/prebuilds/win32-x64.node', engine);
    const built = { builtFromSource: true, upstreamSha256: 'f'.repeat(64) };
    const all = m.scan(root, built);
    expect(all.map((e) => [e.path, e.action])).toEqual([
      ['PasaBot.cmd', 'cannot-sign'],
      ['PasaBotTray.ps1', 'sign'],
      ['node.exe', 'vendor-signed'],
      ['pasabot/node_modules/better-sqlite3/prebuilds/win32-x64.node', 'sign'],
    ]);
    expect(all.find((e) => e.path.endsWith('.node'))?.origin).toBe('better-sqlite3@13.1.1');
    expect(all[1]?.sha256).toBe(createHash('sha256').update('param()').digest('hex'));
    expect(m.strictProblems(all)).toEqual([]);
    // no record that this build compiled it, or the bytes are the upstream prebuild's: never ours to sign
    const engineHash = createHash('sha256').update(engine).digest('hex');
    for (const b of [
      undefined,
      null,
      { builtFromSource: false },
      { builtFromSource: true, upstreamSha256: engineHash },
    ]) {
      const e = m.scan(root, b).find((x) => x.path.endsWith('.node')) as Entry & {
        builtFromSource?: boolean;
      };
      expect([e.action, e.builtFromSource]).toEqual(['upstream-unsigned', false]);
    }
    expect(
      (all.find((e) => e.path.endsWith('.node')) as Entry & { builtFromSource?: boolean }).builtFromSource,
    ).toBe(true);
    put(root, 'pasabot/node_modules/better-sqlite3/prebuilds/linux-x64.node', 'ELF');
    put(root, 'pasabot/node_modules/some-new-dep/thing.dll', pe(0x8664, false));
    // pnpm's command shims at any depth: a workspace package's own node_modules\.bin too (round-5 CI: testkit's)
    put(root, 'pasabot/node_modules/.bin/tsc.cmd', '@echo off');
    put(root, 'pasabot/packages/testkit/node_modules/.bin/pasabot-server.cmd', '@echo off');
    put(root, 'pasabot/packages/testkit/node_modules/.bin/pasabot-server.ps1', 'exit');
    expect(m.strictProblems(m.scan(root, built))).toEqual([
      'remove: pasabot/node_modules/.bin/tsc.cmd',
      'remove: pasabot/node_modules/better-sqlite3/prebuilds/linux-x64.node',
      'unknown: pasabot/node_modules/some-new-dep/thing.dll',
      'remove: pasabot/packages/testkit/node_modules/.bin/pasabot-server.cmd',
      'remove: pasabot/packages/testkit/node_modules/.bin/pasabot-server.ps1',
    ]);
  });
});
