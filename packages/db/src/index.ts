/** @pasabot/db — SQLite open/pragmas, the forward-only migration runner, Kysely types for core tables. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodPrivate, mkdirPrivate, tablePrefix } from '@pasabot/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

export type { CoreDatabase } from './schema.js';

import type { CoreDatabase } from './schema.js';

export type Sqlite = Database.Database;

/** Directory holding the core migrations shipped with this package. */
export const CORE_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const CORE_MODULE = 'core';

/** Open (creating if needed) a database with PasaBot's pragmas: WAL, synchronous=NORMAL, FKs on. */
export function openDatabase(file: string): Sqlite {
  if (file !== ':memory:') mkdirPrivate(dirname(file));
  const db = new Database(file);
  // owner-only: SQLite gives the -wal/-shm files the database file's own permissions
  if (file !== ':memory:') for (const f of [file, `${file}-wal`, `${file}-shm`]) chmodPrivate(f);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function createKysely<T = CoreDatabase>(db: Sqlite): Kysely<T> {
  return new Kysely<T>({ dialect: new SqliteDialect({ database: db }) });
}

export interface MigrationSet {
  /** 'core' or a module id */
  module: string;
  dir: string;
}
export interface MigrationResult {
  applied: { module: string; name: string }[];
  backup: string | null;
}

export class MigrationError extends Error {}
/** An already-applied migration file changed on disk: the server must refuse to boot. */
export class MigrationChecksumError extends MigrationError {}

const NAME_RE = /^\d{12}_[a-z0-9_-]+\.sql$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function listFiles(set: MigrationSet) {
  if (!existsSync(set.dir)) return [];
  return readdirSync(set.dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      if (!NAME_RE.test(name)) {
        throw new MigrationError(
          `${set.module}: migration "${name}" must be named <YYYYMMDDHHMM>_<slug>.sql`,
        );
      }
      const sql = readFileSync(join(set.dir, name), 'utf8');
      return { module: set.module, name, sql, sha: sha256(sql) };
    });
}

/** Module migrations may only create objects named with the module's prefix (`<id>_`). */
function checkPrefix(module: string, name: string, sql: string) {
  if (module === CORE_MODULE) return;
  const prefix = tablePrefix(module);
  const re =
    /\bCREATE\s+(?:VIRTUAL\s+|TEMP\s+|TEMPORARY\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z0-9_]+)/gi;
  for (const m of sql.matchAll(re)) {
    if (!m[2]!.startsWith(prefix)) {
      throw new MigrationError(
        `${module}/${name}: ${m[1]!.toLowerCase()} "${m[2]}" must be prefixed "${prefix}"`,
      );
    }
  }
}

/**
 * Apply pending migrations: core first, then modules in id order, each by filename; one transaction each.
 * Refuses (throws MigrationChecksumError) when an applied file changed. Before applying anything to a
 * database that already has migrations, writes `VACUUM INTO <backupDir>/pre-<ts>.db`.
 */
export function runMigrations(
  db: Sqlite,
  sets: MigrationSet[],
  opts: { backupDir?: string; now?: () => number } = {},
): MigrationResult {
  const now = opts.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    module TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL,
    PRIMARY KEY (module, name))`);
  const ordered = [
    ...sets.filter((s) => s.module === CORE_MODULE),
    ...sets.filter((s) => s.module !== CORE_MODULE).sort((a, b) => (a.module < b.module ? -1 : 1)),
  ];
  const applied = new Map<string, string>(
    (
      db.prepare('SELECT module, name, sha256 FROM _migrations').all() as {
        module: string;
        name: string;
        sha256: string;
      }[]
    ).map((r) => [`${r.module}/${r.name}`, r.sha256]),
  );
  const pending: ReturnType<typeof listFiles> = [];
  for (const set of ordered) {
    for (const f of listFiles(set)) {
      const known = applied.get(`${f.module}/${f.name}`);
      if (known === undefined) {
        checkPrefix(f.module, f.name, f.sql);
        pending.push(f);
      } else if (known !== f.sha) {
        throw new MigrationChecksumError(
          `migration ${f.module}/${f.name} was changed after it was applied (sha mismatch); refusing to boot`,
        );
      }
    }
  }
  let backup: string | null = null;
  if (pending.length > 0 && applied.size > 0 && opts.backupDir) {
    mkdirPrivate(opts.backupDir);
    backup = join(opts.backupDir, `pre-${now()}.db`);
    db.prepare('VACUUM INTO ?').run(backup);
    chmodPrivate(backup);
  }
  const record = db.prepare('INSERT INTO _migrations (module, name, sha256, applied_at) VALUES (?, ?, ?, ?)');
  for (const f of pending) {
    db.transaction(() => {
      db.exec(f.sql);
      record.run(f.module, f.name, f.sha, now());
    })();
  }
  return { applied: pending.map((f) => ({ module: f.module, name: f.name })), backup };
}
