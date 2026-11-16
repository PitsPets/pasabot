import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_MIGRATIONS_DIR,
  MigrationChecksumError,
  MigrationError,
  openDatabase,
  runMigrations,
  type Sqlite,
} from './index.js';

const CORE_TABLES = [
  'users',
  'passkeys',
  'devices',
  'sessions',
  'pairing_codes',
  'agents',
  'provider_accounts',
  'provider_sessions',
  'sections',
  'chats',
  'chat_members',
  'messages',
  'messages_fts',
  'reactions',
  'attachments',
  'blobs',
  'queue_items',
  'agent_queue_state',
  'runs',
  'run_events',
  'approvals',
  'events',
  'audit_log',
  'secrets',
  'settings',
  'automation_tokens',
  'run_tokens',
  'setup_tokens',
  'push_subscriptions',
];

const dirs: string[] = [];
const dbs: Sqlite[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pasabot-mig-'));
  dirs.push(d);
  return d;
}
function open(file: string) {
  const db = openDatabase(file);
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tables = (db: Sqlite) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe('test:migrations', () => {
  it('fresh database gets every core table, in WAL mode', () => {
    const home = tmp();
    const db = open(join(home, 'pasabot.db'));
    const res = runMigrations(db, [{ module: 'core', dir: CORE_MIGRATIONS_DIR }], {
      backupDir: join(home, 'backups'),
    });
    expect(res.applied.length).toBeGreaterThan(0);
    expect(res.backup).toBeNull(); // nothing to back up on a fresh db
    expect(tables(db)).toEqual(expect.arrayContaining(CORE_TABLES));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // audit_log is append-only
    db.prepare("INSERT INTO audit_log (id, at, actor_kind, action) VALUES ('a', 1, 'system', 'boot')").run();
    expect(() => db.prepare("UPDATE audit_log SET action='x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('upgrade applies only new files, in order, after a pre-migration backup', () => {
    const home = tmp();
    const mod = join(home, 'mod-migrations');
    mkdirSync(mod);
    writeFileSync(join(mod, '202611130001_one.sql'), 'CREATE TABLE notes_a (id TEXT PRIMARY KEY);');
    const db = open(join(home, 'pasabot.db'));
    const sets = [
      { module: 'notes', dir: mod },
      { module: 'core', dir: CORE_MIGRATIONS_DIR },
    ];
    const first = runMigrations(db, sets, { backupDir: join(home, 'backups') });
    expect(first.applied[0]!.module).toBe('core'); // core first even when listed last
    expect(first.applied.at(-1)).toEqual({ module: 'notes', name: '202611130001_one.sql' });

    writeFileSync(join(mod, '202611130002_two.sql'), 'CREATE TABLE notes_b (id TEXT PRIMARY KEY);');
    const second = runMigrations(db, sets, { backupDir: join(home, 'backups') });
    expect(second.applied).toEqual([{ module: 'notes', name: '202611130002_two.sql' }]);
    expect(second.backup).toMatch(/pre-\d+\.db$/);
    expect(readdirSync(join(home, 'backups'))).toHaveLength(1);
    expect(tables(db)).toEqual(expect.arrayContaining(['notes_a', 'notes_b']));

    const third = runMigrations(db, sets, { backupDir: join(home, 'backups') });
    expect(third.applied).toEqual([]);
    expect(third.backup).toBeNull();
  });

  it('detached approvals: the approvals rebuild keeps every existing row on a database that has them', () => {
    const home = tmp();
    const old = join(home, 'core-old');
    mkdirSync(old);
    for (const f of readdirSync(CORE_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')))
      if (f < '202611131500') writeFileSync(join(old, f), readFileSync(join(CORE_MIGRATIONS_DIR, f)));
    const db = open(join(home, 'pasabot.db'));
    runMigrations(db, [{ module: 'core', dir: old }]);
    db.prepare(
      "INSERT INTO agents (id, slug, name, provider_id, workspace_dir, created_at) VALUES ('a1', 'a1', 'A', 'fake', '/tmp/a1', 1)",
    ).run();
    db.prepare(
      "INSERT INTO queue_items (id, agent_id, seq, priority, kind, state, created_at) VALUES ('q1', 'a1', 1, 1, 'chat', 'done', 1)",
    ).run();
    db.prepare(
      "INSERT INTO runs (id, queue_item_id, agent_id, provider_id, state, started_at) VALUES ('r1', 'q1', 'a1', 'fake', 'done', 1)",
    ).run();
    db.prepare(
      "INSERT INTO approvals (id, run_id, agent_id, tier, action, summary, state, expires_at) VALUES ('ap1', 'r1', 'a1', 2, '{\"tool\":\"x\"}', 'old one', 'approved', 5)",
    ).run();
    const res = runMigrations(db, [{ module: 'core', dir: CORE_MIGRATIONS_DIR }], {
      backupDir: join(home, 'backups'),
    });
    expect(res.applied.map((a) => a.name)).toContain('202611131500_detached_approvals.sql');
    expect(res.backup).toMatch(/pre-\d+\.db$/);
    expect(db.prepare('SELECT id, run_id, agent_id, subject, state, action FROM approvals').all()).toEqual([
      { id: 'ap1', run_id: 'r1', agent_id: 'a1', subject: null, state: 'approved', action: '{"tool":"x"}' },
    ]);
    // a detached approval needs no run; an approval with neither a run nor a subject is refused
    db.prepare(
      "INSERT INTO approvals (id, subject, tier, summary, expires_at) VALUES ('ap2', 'workflow:r:s', 2, 'x', 9)",
    ).run();
    expect(() =>
      db.prepare("INSERT INTO approvals (id, tier, summary, expires_at) VALUES ('ap3', 2, 'x', 9)").run(),
    ).toThrow(/CHECK/);
    // one pending approval per subject
    expect(() =>
      db
        .prepare(
          "INSERT INTO approvals (id, subject, tier, summary, expires_at) VALUES ('ap4', 'workflow:r:s', 2, 'x', 9)",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('agent avatar salt: an existing database upgrades with every agent kept and an empty salt', () => {
    const home = tmp();
    const old = join(home, 'core-old');
    mkdirSync(old);
    for (const f of readdirSync(CORE_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')))
      if (f < '202611141500') writeFileSync(join(old, f), readFileSync(join(CORE_MIGRATIONS_DIR, f)));
    const db = open(join(home, 'pasabot.db'));
    runMigrations(db, [{ module: 'core', dir: old }]);
    db.prepare(
      "INSERT INTO agents (id, slug, name, provider_id, workspace_dir, created_at) VALUES ('a1', 'a1', 'A', 'fake', '/tmp/a1', 1)",
    ).run();
    const res = runMigrations(db, [{ module: 'core', dir: CORE_MIGRATIONS_DIR }], {
      backupDir: join(home, 'backups'),
    });
    expect(res.applied.map((a) => a.name)).toContain('202611141500_agent_avatar_salt.sql');
    expect(db.prepare('SELECT id, name, avatar_salt FROM agents').all()).toEqual([
      { id: 'a1', name: 'A', avatar_salt: '' },
    ]);
    db.prepare(
      "INSERT INTO agents (id, slug, name, provider_id, workspace_dir, created_at) VALUES ('a2', 'a2', 'B', 'fake', '/tmp/a2', 2)",
    ).run();
    expect(db.prepare("SELECT avatar_salt FROM agents WHERE id = 'a2'").get()).toEqual({ avatar_salt: '' });
  });

  it('a changed applied file refuses boot', () => {
    const home = tmp();
    const mod = join(home, 'm');
    mkdirSync(mod);
    writeFileSync(join(mod, '202611130001_one.sql'), 'CREATE TABLE notes_a (id TEXT PRIMARY KEY);');
    const db = open(join(home, 'pasabot.db'));
    const sets = [
      { module: 'core', dir: CORE_MIGRATIONS_DIR },
      { module: 'notes', dir: mod },
    ];
    runMigrations(db, sets);
    writeFileSync(join(mod, '202611130001_one.sql'), 'CREATE TABLE notes_a (id TEXT PRIMARY KEY, x TEXT);');
    expect(() => runMigrations(db, sets)).toThrow(MigrationChecksumError);
  });

  it('module tables must carry the module prefix; bad names are refused', () => {
    const home = tmp();
    const mod = join(home, 'm');
    mkdirSync(mod);
    writeFileSync(join(mod, '202611130001_one.sql'), 'CREATE TABLE users2 (id TEXT);');
    const db = open(join(home, 'pasabot.db'));
    expect(() => runMigrations(db, [{ module: 'notes', dir: mod }])).toThrow(/must be prefixed "notes_"/);
    writeFileSync(join(mod, '202611130001_one.sql'), 'CREATE TABLE notes_ok (id TEXT);');
    writeFileSync(join(mod, 'bad-name.sql'), 'SELECT 1;');
    expect(() => runMigrations(db, [{ module: 'notes', dir: mod }])).toThrow(MigrationError);
  });

  it('a failing migration rolls back and is not recorded', () => {
    const home = tmp();
    const mod = join(home, 'm');
    mkdirSync(mod);
    writeFileSync(
      join(mod, '202611130001_one.sql'),
      'CREATE TABLE notes_a (id TEXT); INSERT INTO nope VALUES (1);',
    );
    const db = open(join(home, 'pasabot.db'));
    expect(() => runMigrations(db, [{ module: 'notes', dir: mod }])).toThrow();
    expect(tables(db)).not.toContain('notes_a');
    expect(db.prepare('SELECT count(*) c FROM _migrations').get()).toEqual({ c: 0 });
  });
});
