#!/usr/bin/env node
/**
 * One-shot setup-link minter for the desktop launcher (ARCHITECTURE 4.3) when it is attached to a server it did not
 * start (`pasabot start` for the same data dir, launcher status `external`) and so has no parent channel to ask, or
 * when a second launch of a tray shell wants to open a fresh link instead of the bare address.
 *
 * `node mint-setup-link.js <base url>` with $PASABOT_HOME: the same rule as the server and `pasabot setup-link`: one
 * live code at a time (every older unused code stops working), none once an owner exists. It prints the link on
 * stdout and nothing else (no database yet, or an owner exists: it prints nothing). It never logs the link. Only a
 * process of the same user that can open the data dir's database can run it, as with `pasabot setup-link`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@pasabot/db';

const SETUP_TTL_MS = 30 * 60_000;

/** a fresh setup link for the data dir at `home`, on `base`; null when there is no database or an owner exists */
export function mintSetupLink(home: string, base: string): string | null {
  const dbPath = join(home, 'pasabot.db');
  if (!existsSync(dbPath)) return null;
  const db = openDatabase(dbPath);
  try {
    if (db.prepare("SELECT 1 FROM users WHERE kind = 'owner' LIMIT 1").get()) return null;
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    db.transaction(() => {
      db.prepare('DELETE FROM setup_tokens WHERE used_at IS NULL').run();
      db.prepare('INSERT INTO setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
        createHash('sha256').update(token).digest('hex'),
        now,
        now + SETUP_TTL_MS,
      );
    })();
    // the token rides in the fragment, as the server's own links do (4.1 "tokens never in URLs")
    return `${base.replace(/\/$/, '')}/#/setup?token=${token}`;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? '';
  if (!/^https?:\/\//.test(base)) {
    process.stderr.write('usage: mint-setup-link <base url>\n');
    process.exit(2);
  }
  try {
    const link = mintSetupLink(process.env.PASABOT_HOME ?? join(homedir(), '.pasabot'), base);
    if (link) process.stdout.write(`${link}\n`);
    process.exit(0);
  } catch (e) {
    // the reason only, never a token
    process.stderr.write(`mint-setup-link: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
