/** `pasabot setup-link`: mint a fresh single-use setup token (30 min) on this machine and print the link. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@pasabot/db';
import { defineCommand, pasabotHome, serverUrl } from '../command.js';

export default defineCommand({
  name: 'setup-link',
  summary: 'print a one-time link to claim this server as its owner',
  run() {
    const dbPath = join(pasabotHome(), 'pasabot.db');
    if (!existsSync(dbPath)) throw new Error(`no server data at ${dbPath}; start the server once first`);
    const db = openDatabase(dbPath);
    try {
      if (db.prepare("SELECT 1 FROM users WHERE kind = 'owner' LIMIT 1").get()) {
        process.stdout.write('This server already has an owner. Sign in with `pasabot login`.\n');
        return 1;
      }
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      // one live code at a time, as the server mints them: every older unused code stops working
      db.transaction(() => {
        db.prepare('DELETE FROM setup_tokens WHERE used_at IS NULL').run();
        db.prepare('INSERT INTO setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
          createHash('sha256').update(token).digest('hex'),
          now,
          now + 30 * 60_000,
        );
      })();
      const base = (process.env.PASABOT_PUBLIC_URL ?? serverUrl()).replace(/\/$/, '');
      process.stdout.write(`Open within 30 minutes (single use):\n  ${base}/#/setup?token=${token}\n`);
      return 0;
    } finally {
      db.close();
    }
  },
});
