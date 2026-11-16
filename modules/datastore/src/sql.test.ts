import { describe, expect, it } from 'vitest';
import { classify, SqlError } from './sql.js';

const refused = (sql: string) => {
  try {
    classify(sql);
  } catch (e) {
    expect(e).toBeInstanceOf(SqlError);
    return (e as SqlError).code;
  }
  throw new Error(`accepted: ${sql}`);
};

describe('datastore SQL gate', () => {
  it('rejects ATTACH, PRAGMA and the other connection-level statements, wherever they appear', () => {
    for (const sql of [
      "ATTACH DATABASE '/tmp/pasabot.db' AS b",
      "attach '/x' as y",
      'DETACH y',
      'PRAGMA writable_schema = 1',
      'pragma table_info(x)',
      'VACUUM',
      "VACUUM INTO '/tmp/copy.db'",
      'ANALYZE',
      'REINDEX',
      "SELECT load_extension('/tmp/evil')",
      'SELECT * FROM t WHERE 1 /* hide */ ; PRAGMA x', // also multi-statement
      'SELECT 1 -- comment\n; ATTACH x',
    ])
      expect(['forbidden', 'multi_statement']).toContain(refused(sql));
    expect(refused('/* c */ PRAGMA foo')).toBe('forbidden');
    expect(refused('PrAgMa foo')).toBe('forbidden');
  });

  it('rejects more than one statement, but allows a trailing semicolon', () => {
    expect(refused('SELECT 1; SELECT 2')).toBe('multi_statement');
    expect(refused('INSERT INTO t VALUES (1);DELETE FROM t')).toBe('multi_statement');
    expect(refused('SELECT 1;;x')).toBe('multi_statement');
    expect(classify('SELECT 1;')).toEqual({ kind: 'query' });
    expect(classify('SELECT 1 ; ; -- done')).toEqual({ kind: 'query' });
  });

  it('keywords inside strings, quoted names and comments are data, not statements', () => {
    expect(classify("SELECT 'ATTACH; PRAGMA x; DROP TABLE y' AS s")).toEqual({ kind: 'query' });
    expect(classify('SELECT "pragma" FROM t -- ATTACH\n')).toEqual({ kind: 'query' });
    expect(classify("INSERT INTO notes (body) VALUES ('it''s; fine')")).toEqual({
      kind: 'write',
      verb: 'insert',
      table: 'notes',
    });
    expect(classify('SELECT [a;b], `c;d` FROM t')).toEqual({ kind: 'query' });
    expect(classify("SELECT X'00ff' /* PRAGMA */")).toEqual({ kind: 'query' });
  });

  it('records REPLACE conflict resolution and upserts on writes', () => {
    expect(classify('REPLACE INTO t (id) VALUES (1)')).toEqual({
      kind: 'write',
      verb: 'insert',
      table: 't',
      conflict: 'replace',
    });
    expect(classify('insert or replace into t values (1)')).toMatchObject({ conflict: 'replace' });
    expect(classify('UPDATE OR REPLACE t SET id = 1')).toMatchObject({ verb: 'update', conflict: 'replace' });
    expect(
      classify('INSERT INTO t (id, n) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET n = excluded.n'),
    ).toMatchObject({ verb: 'insert', conflict: 'upsert' });
    expect(classify('INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING')).not.toHaveProperty('conflict');
    expect(classify('INSERT OR IGNORE INTO t VALUES (1)')).not.toHaveProperty('conflict');
    expect(classify('UPDATE OR ABORT t SET a = 1')).not.toHaveProperty('conflict');
    expect(classify("UPDATE t SET a = 'OR REPLACE'")).not.toHaveProperty('conflict');
  });

  it('refuses unterminated strings, names and comments', () => {
    expect(refused("SELECT 'abc")).toBe('syntax');
    expect(refused('SELECT "abc')).toBe('syntax');
    expect(refused('SELECT [abc')).toBe('syntax');
    expect(refused('SELECT 1 /* open')).toBe('syntax');
  });

  it('classifies each statement kind and its table', () => {
    expect(classify('WITH x AS (SELECT 1) SELECT * FROM x')).toEqual({ kind: 'query' });
    expect(classify('values (1)')).toEqual({ kind: 'query' });
    expect(classify('INSERT OR IGNORE INTO "Orders" VALUES (?)')).toEqual({
      kind: 'write',
      verb: 'insert',
      table: 'Orders',
    });
    expect(classify('REPLACE INTO t VALUES (1)')).toMatchObject({ verb: 'insert', table: 't' });
    expect(classify('update or replace t set a = 1')).toMatchObject({ verb: 'update', table: 't' });
    expect(classify('DELETE FROM [my t] WHERE a = :a')).toMatchObject({ verb: 'delete', table: 'my t' });
    expect(classify('CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, item TEXT)')).toEqual({
      kind: 'create',
      table: 'orders',
      ifNotExists: true,
    });
    expect(classify('ALTER TABLE orders RENAME TO purchases')).toEqual({
      kind: 'alter',
      table: 'orders',
      action: 'rename_table',
      newName: 'purchases',
    });
    expect(classify('ALTER TABLE orders ADD COLUMN qty INTEGER')).toMatchObject({ action: 'add_column' });
    expect(classify('ALTER TABLE orders DROP COLUMN qty')).toMatchObject({ action: 'drop_column' });
    expect(classify('ALTER TABLE orders RENAME COLUMN a TO b')).toMatchObject({ action: 'rename_column' });
    expect(classify('DROP TABLE IF EXISTS orders')).toEqual({
      kind: 'drop',
      table: 'orders',
      ifExists: true,
    });
  });

  it('refuses what the shared store does not keep: schemas, temp tables, views, triggers, sqlite_* names', () => {
    expect(refused('INSERT INTO main.t VALUES (1)')).toBe('forbidden');
    expect(refused('DELETE FROM temp.t')).toBe('forbidden');
    expect(refused('CREATE TEMP TABLE t (a)')).toBe('unsupported');
    expect(refused('CREATE TRIGGER x AFTER INSERT ON t BEGIN DELETE FROM u; END')).toBe('multi_statement');
    expect(refused('CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1 END')).toBe('unsupported');
    expect(refused('CREATE VIEW v AS SELECT 1')).toBe('unsupported');
    expect(refused('CREATE INDEX i ON t (a)')).toBe('unsupported');
    expect(refused('SELECT * FROM sqlite_master')).toBe('forbidden');
    expect(refused('CREATE TABLE "SQLite_x" (a)')).toBe('forbidden');
    expect(refused('BEGIN')).toBe('unsupported');
    expect(refused('DROP INDEX i')).toBe('unsupported');
    expect(refused('DROP TABLE t extra')).toBe('syntax');
    expect(refused('')).toBe('empty');
    expect(refused('  -- only a comment')).toBe('empty');
    expect(refused('x'.repeat(20_001))).toBe('syntax');
  });

  it('is linear: a 20 000-character hostile input is gated in well under 50 ms', () => {
    const inputs = [
      `SELECT ${"'".repeat(1)}${'a'.repeat(19_990)}`,
      `SELECT ${'('.repeat(19_990)}`,
      `SELECT ${'/*'.repeat(9_990)}`,
      `SELECT ${'"'.repeat(19_990)}`,
    ];
    for (const sql of inputs) {
      const t0 = performance.now();
      try {
        classify(sql);
      } catch {
        // refused or accepted, both fine: only time matters here
      }
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});
