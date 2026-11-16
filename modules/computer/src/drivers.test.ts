/**
 * The Linux driver against stub `Xvfb` / `xdotool` / `import` executables (no X server on this machine): exact
 * argv, the agent's own DISPLAY and nothing else in the helpers' environment, the owner's display refused, and
 * every stub Xvfb stopped by the test that started it. The macOS driver is proven against a fake Screen Helper
 * in helper.test.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkKeys, checkText } from './drivers/types.js';
import { displayNumber, missingXvfbBins, XvfbDriver } from './drivers/xvfb.js';
import { encodePng, pngSize } from './png.js';

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
const waitGone = async (pid: number) => {
  for (let i = 0; i < 100 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return gone(pid);
};

describe('XvfbDriver with stub helpers', () => {
  let dir: string;
  let bin: string;
  let log: string;
  const started: number[] = [];
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  /** a stub Xvfb that reports display `n` on fd 3 (as `-displayfd 3` asks) and then waits to be stopped */
  const xvfb = (n: number | 'none' | 'exit') =>
    write(
      'Xvfb',
      [
        `echo "xvfb $*" >> "${log}"`,
        `echo "xvfb-env DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY" >> "${log}"`,
        n === 'exit' ? 'echo "cannot open" >&2; exit 1' : n === 'none' ? '' : `echo ${n} >&3`,
        'exec sleep 300',
      ].join('\n'),
    );
  const driver = (o: Partial<ConstructorParameters<typeof XvfbDriver>[0]> = {}) =>
    new XvfbDriver({ width: 320, height: 200, path: `${bin}:/usr/bin:/bin`, ownerDisplay: ':0', ...o });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pasabot-xvfb-'));
    bin = join(dir, 'bin');
    log = join(dir, 'calls.log');
    mkdirSync(bin);
    writeFileSync(join(dir, 'shot.png'), encodePng(2, 1, new Uint8Array(8).fill(200)));
    write(
      'xdotool',
      `printf 'xdotool' >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"\necho "xdotool-env DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY HOME=$HOME" >> "${log}"`,
    );
    write('import', `echo "import $* DISPLAY=$DISPLAY" >> "${log}"\ncat "${join(dir, 'shot.png')}"`);
  });
  afterAll(async () => {
    for (const pid of started) expect(await waitGone(pid)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds what is missing on PATH', () => {
    xvfb(97);
    expect(missingXvfbBins(bin)).toEqual([]);
    expect(missingXvfbBins('/nonexistent')).toEqual(['Xvfb', 'xdotool', 'import']);
    expect(displayNumber(':0')).toBe(0);
    expect(displayNumber('localhost:10.0')).toBe(10);
    expect(displayNumber(undefined)).toBeNull();
  });

  it("starts its own display, drives it with exact argv in a scrubbed env, and never touches the owner's", async () => {
    xvfb(97);
    writeFileSync(log, '');
    process.env.XAUTHORITY = '/home/owner/.Xauthority';
    const d = driver();
    await d.start();
    const pid = d.pid()!;
    started.push(pid);
    expect(d.label()).toBe(':97');
    expect(d.alive()).toBe(true);
    await d.act({ kind: 'click', x: 10, y: 20 });
    await d.act({ kind: 'click', x: 1, y: 2, button: 'right' });
    await d.act({ kind: 'move', x: 319, y: 199 });
    await d.act({ kind: 'type', text: '--version; rm -rf ~' });
    await d.act({ kind: 'key', keys: 'ctrl+a  Return' });
    const png = await d.screenshot();
    expect(pngSize(png)).toEqual({ width: 2, height: 1 });
    await expect(d.act({ kind: 'click', x: 320, y: 0 })).rejects.toThrow(/outside the 320x200 display/);
    await expect(d.act({ kind: 'key', keys: '--help' })).rejects.toThrow(/cannot start with/);
    await expect(d.act({ kind: 'type', text: 'a\u0000b' })).rejects.toThrow(/control character/);
    await d.stop();
    expect(await waitGone(pid)).toBe(true);
    expect(d.alive()).toBe(false);
    delete process.env.XAUTHORITY;

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(
      /^xvfb -displayfd 3 -auth \S+\.xauth -screen 0 320x200x24 -nolisten tcp -nolisten local -noreset$/,
    );
    expect(lines[1]).toBe('xvfb-env DISPLAY= XAUTHORITY=');
    const cookie = lines[0]!.split(' ')[4]!;
    const calls = lines.filter((l) => l.startsWith('xdotool '));
    expect(calls).toEqual([
      'xdotool [mousemove] [--sync] [10] [20] [click] [1]',
      'xdotool [mousemove] [--sync] [1] [2] [click] [3]',
      'xdotool [mousemove] [--sync] [319] [199]',
      'xdotool [type] [--delay] [12] [--] [--version; rm -rf ~]',
      'xdotool [key] [--clearmodifiers] [--] [ctrl+a] [Return]',
    ]);
    // every helper saw the agent's display only: no owner XAUTHORITY, no HOME
    for (const l of lines.filter((x) => x.startsWith('xdotool-env')))
      expect(l).toBe(`xdotool-env DISPLAY=:97 XAUTHORITY=${cookie} HOME=`);
    expect(existsSync(cookie)).toBe(false);
    expect(lines.find((l) => l.startsWith('import'))).toBe('import -window root png:- DISPLAY=:97');
  });

  it('gives each display its own 0600 cookie file (only our helpers can connect), removed when it stops', async () => {
    xvfb(96);
    writeFileSync(log, '');
    const authDir = join(dir, 'home', 'modules', 'computer', 'xauth');
    const d = driver({ authDir });
    await d.start();
    started.push(d.pid()!);
    const first = readFileSync(log, 'utf8').split('\n')[0]!.split(' ');
    const file = first[first.indexOf('-auth') + 1]!;
    expect(file.startsWith(`${authDir}/`)).toBe(true);
    expect(first.slice(-5)).toEqual(['-nolisten', 'tcp', '-nolisten', 'local', '-noreset']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(authDir).mode & 0o777).toBe(0o700);
    const b = readFileSync(file);
    // libXau entry: FamilyWild, empty address, empty number, MIT-MAGIC-COOKIE-1, 16 random bytes
    expect(b.readUInt16BE(0)).toBe(0xffff);
    expect(b.readUInt16BE(2)).toBe(0);
    expect(b.readUInt16BE(4)).toBe(0);
    expect(b.subarray(8, 8 + b.readUInt16BE(6)).toString('latin1')).toBe('MIT-MAGIC-COOKIE-1');
    expect(b.readUInt16BE(26)).toBe(16);
    expect(b.length).toBe(28 + 16);
    expect(d.env()).toEqual({ PATH: `${bin}:/usr/bin:/bin`, DISPLAY: ':96', XAUTHORITY: file });
    // a second display gets a different cookie
    const d2 = driver({ authDir });
    xvfb(95);
    await d2.start();
    started.push(d2.pid()!);
    const file2 = d2.env().XAUTHORITY!;
    expect(file2).not.toBe(file);
    expect(readFileSync(file2).subarray(28).equals(b.subarray(28))).toBe(false);
    await d.stop();
    await d2.stop();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file2)).toBe(false);
  });

  it("refuses the owner's own display and stops that Xvfb", async () => {
    xvfb(0);
    const d = driver({ ownerDisplay: ':0.0' });
    const authDir = join(dir, 'refused-xauth');
    const r = driver({ ownerDisplay: ':0.0', authDir });
    await expect(r.start()).rejects.toThrow(/owner's own display/);
    expect(readdirSync(authDir)).toEqual([]);
    await expect(d.start()).rejects.toThrow(/owner's own display/);
    expect(d.alive()).toBe(false);
    await expect(d.screenshot()).rejects.toThrow(/not running/);
  });

  it('reports an Xvfb that dies or never answers, and leaves no process behind', async () => {
    xvfb('exit');
    await expect(driver().start()).rejects.toThrow(/exited \(1\) before it was ready: cannot open/);
    xvfb('none');
    const d = driver({ startTimeoutMs: 300 });
    await expect(d.start()).rejects.toThrow(/did not start in time/);
    expect(d.pid()).toBeNull();
  });

  it('an Xvfb that goes away (stopped from Background processes) marks the driver dead', async () => {
    xvfb(98);
    const d = driver();
    await d.start();
    const pid = d.pid()!;
    started.push(pid);
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100 && d.alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(d.alive()).toBe(false);
    expect(existsSync(log)).toBe(true);
  });
});

describe('input checks', () => {
  it('keys: chords of key names only, no option injection, at most 16', () => {
    expect(checkKeys('ctrl+shift+t  F5')).toEqual(['ctrl+shift+t', 'F5']);
    for (const bad of ['', '   ', '-x', 'a;b', 'ctrl+', '+a', 'é', `a${' a'.repeat(16)}`])
      expect(() => checkKeys(bad)).toThrow();
  });
  it('text: no control characters except newline and tab, at most 2000', () => {
    expect(checkText('hello\n\tworld')).toBe('hello\n\tworld');
    for (const bad of ['', 'a\u0007', 'x'.repeat(2001), '\u007f']) expect(() => checkText(bad)).toThrow();
  });
});
