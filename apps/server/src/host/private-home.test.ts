/** The data dir is owner-only: an older home made with default permissions is tightened on boot. */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer } from '../../../../packages/testkit/src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('owner-only data dir', () => {
  it('home, its folders and the database are never group/world readable, even if they were before', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pasabot-perm-'));
    dirs.push(home);
    // an older install: world-readable home, logs folder and database file
    chmodSync(home, 0o755);
    mkdirSync(join(home, 'logs'), { mode: 0o755 });
    chmodSync(join(home, 'logs'), 0o755);
    writeFileSync(join(home, 'pasabot.db'), '', { mode: 0o644 });
    chmodSync(join(home, 'pasabot.db'), 0o644);
    const s = await bootTestServer({ home });
    try {
      for (const d of ['', 'blobs', 'workspaces', 'skills', 'sites', 'logs', 'backups', 'modules'])
        expect(statSync(join(home, d)).mode & 0o777, d || 'home').toBe(0o700);
      for (const f of ['pasabot.db', 'pasabot.db-wal'])
        expect(statSync(join(home, f)).mode & 0o077, f).toBe(0);
      // a module's own data folder too
      const mods = join(home, 'modules');
      for (const m of readdirSync(mods)) expect(statSync(join(mods, m)).mode & 0o077, m).toBe(0);
    } finally {
      await s.close();
    }
  });
});
