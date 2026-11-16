/**
 * `pasabot-server --help | -h | --version` print and exit: no server starts, no data dir is created, and the product
 * is named "PasaBot".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pasabot-args-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (arg: string) => {
  const home = join(scratch, `home-${arg.replace(/\W/g, '')}`);
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', entry, arg], {
    encoding: 'utf8',
    timeout: 20_000, // a server that started would never exit on its own: the timeout kills it and fails below
    env: { PATH: process.env.PATH ?? '', PASABOT_HOME: home, PASABOT_PORT: '0', PASABOT_SITES_PORT: '0' },
  });
  return { ...r, home };
};

describe('pasabot-server arguments', () => {
  it('--version prints "PasaBot <version>" and exits without starting or creating anything', () => {
    const r = run('--version');
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^PasaBot \d+\.\d+\.\d+\n$/);
    expect(existsSync(r.home)).toBe(false);
  });
  for (const arg of ['--help', '-h'])
    it(`${arg} prints the usage and exits without starting or creating anything`, () => {
      const r = run(arg);
      expect(r.signal).toBeNull();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('PasaBot server');
      expect(r.stdout).toContain('usage: pasabot-server');
      expect(r.stdout).not.toContain('listening');
      expect(existsSync(r.home)).toBe(false);
    });
});
