/**
 * The desktop launcher's one-shot minter (ARCHITECTURE 4.3) for a server it did not start: same rule as the server,
 * one live code at a time and none once an owner exists; it prints only the link.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, type TestServer } from '../../../../packages/testkit/src/index.js';
import { mintSetupLink } from './mint-setup-link.js';

const entry = fileURLToPath(new URL('./mint-setup-link.ts', import.meta.url));
const tokenOf = (link: string) => link.split('token=')[1]!;
const claim = (s: TestServer, token: string) =>
  fetch(`${s.url}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, displayName: 'Diwa', password: 'correct horse' }),
  });

let servers: TestServer[] = [];
let dirs: string[] = [];
const boot = async () => {
  const home = mkdtempSync(join(tmpdir(), 'pasabot-mint-'));
  dirs.push(home);
  const s = await bootTestServer({ home });
  servers.push(s);
  return { s, home };
};
afterEach(async () => {
  await Promise.all(servers.map((s) => s.cleanup()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  servers = [];
  dirs = [];
});

describe('mint-setup-link (a server the desktop app did not start)', () => {
  it('mints a link the running server accepts, and the older unused code stops working', async () => {
    const { s, home } = await boot();
    const link = mintSetupLink(home, `${s.url}/`)!;
    expect(link.startsWith(`${s.url}/#/setup?token=`)).toBe(true);
    expect((await claim(s, tokenOf(s.setupLink!))).status).toBe(403);
    expect((await claim(s, tokenOf(link))).status).toBe(200);
    // an owner exists now: nothing is minted
    expect(mintSetupLink(home, s.url)).toBeNull();
    expect(
      (s.db.prepare('SELECT COUNT(*) AS n FROM setup_tokens WHERE used_at IS NULL').get() as { n: number }).n,
    ).toBe(0);
  });

  it('no database yet: nothing is minted, nothing is created', () => {
    const home = mkdtempSync(join(tmpdir(), 'pasabot-mint-'));
    dirs.push(home);
    expect(mintSetupLink(home, 'http://127.0.0.1:7777')).toBeNull();
  });

  it('as a process: prints only the link on stdout, and nothing once an owner exists', async () => {
    const { s, home } = await boot();
    const run = () =>
      spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', entry, s.url], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: process.env.PATH ?? '', PASABOT_HOME: home },
      });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(
      new RegExp(`^${s.url.replace(/[.:/]/g, '\\$&')}/#/setup\\?token=[\\w-]{43}\\n$`),
    );
    expect((await claim(s, tokenOf(r.stdout.trim()))).status).toBe(200);
    const after = run();
    expect(after.status).toBe(0);
    expect(after.stdout).toBe('');
  });
});
