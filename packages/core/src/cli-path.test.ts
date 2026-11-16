import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cliSearchDirAncestors,
  cliSearchDirs,
  cliSearchPath,
  findCli,
  systemCliDirs,
  userCliDirs,
} from './cli-path.js';

const home = mkdtempSync(join(tmpdir(), 'pb-clipath-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('cliSearchPath / findCli', () => {
  it('keeps PATH first and appends existing install folders of HOME (a launchd server has a bare PATH)', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const p = cliSearchPath({ PATH: '/usr/bin:/bin', HOME: home }).split(delimiter);
    expect(p.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(p).toContain(join(home, '.local', 'bin'));
    expect(p).not.toContain(join(home, '.bun', 'bin')); // missing folders are not added
    expect(p).toContain(dirname(process.execPath)); // npm CLIs need `node`
    expect(new Set(p).size).toBe(p.length);
  });
  it('finds a CLI in an install folder that is not on PATH, and nothing for a missing one', () => {
    const bin = join(home, '.local', 'bin', 'pb-fake-cli');
    writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n');
    chmodSync(bin, 0o755);
    const path = cliSearchPath({ PATH: '/usr/bin:/bin', HOME: home });
    expect(findCli('pb-fake-cli', path)).toBe(bin);
    expect(findCli('pb-not-there', path)).toBeNull();
    expect(findCli(bin, '')).toBe(bin);
    expect(findCli(join(home, 'nope'), '')).toBeNull();
  });
  it('searches system and package-manager folders before per-user ones (a planted ~/.local/bin file cannot shadow them)', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const p = cliSearchPath({ PATH: '/usr/bin:/bin', HOME: home }).split(delimiter);
    const user = p.indexOf(join(home, '.local', 'bin'));
    for (const d of systemCliDirs()) if (p.includes(d)) expect(p.indexOf(d)).toBeLessThan(user);
    expect(userCliDirs(home)).toContain(join(home, '.local', 'bin'));
    expect(userCliDirs(home).every((d) => d.startsWith(home))).toBe(true);
  });
  it('skips relative PATH entries (they resolve against the server cwd) and lists every searched folder for the sandbox', () => {
    const rel = mkdtempSync(join(home, 'rel-'));
    writeFileSync(join(rel, 'pb-rel-cli'), '#!/bin/sh\n');
    chmodSync(join(rel, 'pb-rel-cli'), 0o755);
    const relName = rel.slice(home.length + 1);
    const cwd = process.cwd();
    process.chdir(home);
    try {
      expect(findCli('pb-rel-cli', `${relName}${delimiter}.`)).toBeNull();
    } finally {
      process.chdir(cwd);
    }
    const dirs = cliSearchDirs({ PATH: `/usr/bin${delimiter}.${delimiter}${relName}`, HOME: home });
    expect(dirs).toContain('/usr/bin');
    expect(dirs).toContain(dirname(process.execPath));
    expect(dirs.every((d) => d.startsWith('/'))).toBe(true);
    expect(cliSearchDirAncestors(['/a/b/c'])).toEqual(['/a/b', '/a']);
  });
});
