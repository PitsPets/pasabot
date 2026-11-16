/**
 * Supply chain (ARCHITECTURE 8): a stdio server started through a package launcher never runs dependency install
 * scripts or source builds, and its own env (from the owner or a connector manifest) cannot turn that back on.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SafeNet } from '@pasabot/core';
import { afterAll, describe, expect, it } from 'vitest';
import { LAUNCHER_GUARD_ENV, stdioEnv, withSession } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const ECHO = join(here, '__fixtures__', 'echo-mcp.mjs');
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pasabot-mcp-guard-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe('stdio launcher guard', () => {
  it('the spawned server sees the guard, and its own env cannot switch it off', async () => {
    const env = {
      PLAIN: 'visible',
      npm_config_ignore_scripts: 'false',
      NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      'npm_config_ignore-scripts': 'false',
      UV_NO_BUILD: '0',
      uv_no_build: '0',
    };
    const seen = await withSession(
      { transport: 'stdio', command: process.execPath, args: [ECHO], env } as never,
      { net: undefined as unknown as SafeNet, timeoutMs: 10_000 },
      async (s) => {
        const read = async (name: string) => textOf(await s.callTool('read_env', { name }));
        return {
          PLAIN: await read('PLAIN'),
          npm_config_ignore_scripts: await read('npm_config_ignore_scripts'),
          NPM_CONFIG_IGNORE_SCRIPTS: await read('NPM_CONFIG_IGNORE_SCRIPTS'),
          'npm_config_ignore-scripts': await read('npm_config_ignore-scripts'),
          UV_NO_BUILD: await read('UV_NO_BUILD'),
          uv_no_build: await read('uv_no_build'),
        };
      },
    );
    expect(seen).toEqual({
      PLAIN: 'visible',
      npm_config_ignore_scripts: 'true',
      NPM_CONFIG_IGNORE_SCRIPTS: '(unset)',
      'npm_config_ignore-scripts': '(unset)',
      UV_NO_BUILD: '1',
      uv_no_build: '(unset)',
    });
    expect(stdioEnv({})).toMatchObject(LAUNCHER_GUARD_ENV);
  });

  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  it.skipIf(npm.status !== 0)(
    "real npm: a dependency's postinstall runs without the guard and not with it (offline, local tarball)",
    () => {
      const root = temp();
      const evil = join(root, 'evil');
      mkdirSync(evil);
      writeFileSync(
        join(evil, 'package.json'),
        JSON.stringify({
          name: 'evil',
          version: '1.0.0',
          scripts: { postinstall: "node -e \"require('fs').writeFileSync(process.env.MARK,'ran')\"" },
        }),
      );
      const cache = join(root, 'cache');
      const base = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), npm_config_cache: cache };
      const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', root], {
        cwd: evil,
        env: { ...base, npm_config_ignore_scripts: 'true' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(pack.status, pack.stderr).toBe(0);
      const install = (name: string, env: Record<string, string>) => {
        const app = join(root, name);
        mkdirSync(app);
        writeFileSync(
          join(app, 'package.json'),
          JSON.stringify({
            name,
            version: '1.0.0',
            private: true,
            dependencies: { evil: '../evil-1.0.0.tgz' },
          }),
        );
        const mark = join(root, `${name}.mark`);
        const r = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund'], {
          cwd: app,
          env: { ...env, MARK: mark },
          encoding: 'utf8',
          timeout: 60_000,
        });
        expect(r.status, r.stderr).toBe(0);
        expect(existsSync(join(app, 'node_modules', 'evil', 'package.json'))).toBe(true);
        return existsSync(mark);
      };
      // control: the same install without the guard runs the script, so the check below can fail
      expect(install('control', base)).toBe(true);
      // what an MCP stdio server gets: the script never runs, even when its env asks for it
      const guarded = stdioEnv({ ...base, NPM_CONFIG_IGNORE_SCRIPTS: 'false' });
      expect(install('guarded', guarded)).toBe(false);
    },
    120_000,
  );
});
