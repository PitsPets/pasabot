// The datastore's SQLite connection, kept in its own child process (src/store.ts forks it): an agent's query (a
// runaway recursive CTE, a huge join) can only stall this process, and the module kills it with SIGKILL when a call
// runs past its time limit (a worker thread cannot be stopped inside a native sqlite3_step; a process can).
// Plain JavaScript so the same file runs from the TypeScript sources (tests, dev) and from the built package.
// Every SQL text reaching this file has passed the module's gate (src/sql.ts); this file is the second gate:
// it prepares exactly one statement (better-sqlite3 refuses more) and checks SQLite's own read-only flag.
import Database from 'better-sqlite3';

if (!process.send) throw new Error('sql-worker.mjs runs only as a child process of the datastore module');
const { path, maxPageCount } = JSON.parse(process.argv[2] ?? '{}');
const db = new Database(path);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('trusted_schema = OFF');
// better-sqlite3 enforces foreign keys by default; here a REFERENCES from one agent's table would pin another
// agent's rows (its creator could no longer delete them or drop the table). Declarations are kept, never enforced.
db.pragma('foreign_keys = OFF');
db.pragma(`max_page_count = ${Number(maxPageCount) | 0}`);
db.pragma('busy_timeout = 2000');

const quote = (name) => `"${String(name).split('"').join('""')}"`;

/** Values that cannot cross back as JSON become plain descriptions. */
function cell(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return { blob: Buffer.from(v).toString('base64') };
  return v;
}

function bind(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? [params.map(bindValue)] : [mapObject(params)];
}
function bindValue(v) {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}
function mapObject(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = bindValue(v);
  return out;
}

function tables() {
  const rows = db
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all();
  return rows.map((r) => ({
    name: r.name,
    ddl: r.sql,
    rows: db.prepare(`SELECT count(*) AS n FROM ${quote(r.name)}`).get().n,
    columns: db
      .prepare('SELECT name, type FROM pragma_table_info(?)')
      .all(r.name)
      .map((c) => ({ name: c.name, type: c.type })),
  }));
}

function countTables() {
  return db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .get().n;
}

function exists(name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE")
    .get(name);
}

/** Read rows from one prepared read-only statement, up to `limit` rows and about `maxBytes` of JSON. */
function read(stmt, args, limit, maxBytes) {
  const columns = stmt.columns().map((c) => c.name);
  stmt.raw(true);
  const rows = [];
  let bytes = 0;
  let truncated = false;
  for (const r of stmt.iterate(...args)) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    const row = r.map(cell);
    bytes += JSON.stringify(row).length;
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  return { columns, rows, truncated };
}

const ops = {
  tables: () => tables(),
  exists: ({ name }) => exists(name),
  query: ({ sql, params, limit, maxBytes }) => {
    const stmt = db.prepare(sql);
    if (!stmt.readonly || !stmt.reader)
      throw Object.assign(new Error('only read-only queries here'), { code: 'not_readonly' });
    return read(stmt, bind(params), limit, maxBytes);
  },
  browse: ({ name, limit, offset, maxBytes }) => {
    if (!exists(name)) throw Object.assign(new Error('no such table'), { code: 'not_found' });
    const stmt = db.prepare(`SELECT * FROM ${quote(name)} LIMIT ? OFFSET ?`);
    return read(stmt, [limit, offset], limit, maxBytes);
  },
  write: ({ sql, params, rows }) => {
    const stmt = db.prepare(sql);
    if (stmt.readonly) throw Object.assign(new Error('not a write statement'), { code: 'not_write' });
    if (rows) {
      let changes = 0;
      let lastInsertRowid = null;
      db.transaction(() => {
        for (const r of rows) {
          const res = stmt.run(...bind(r));
          changes += res.changes;
          lastInsertRowid = res.lastInsertRowid;
        }
      })();
      return { changes, lastInsertRowid: cell(lastInsertRowid) };
    }
    if (stmt.reader) {
      // RETURNING: the rows come back too
      const out = read(stmt, bind(params), 1000, 1_000_000);
      return { changes: out.rows.length, returning: out };
    }
    const res = stmt.run(...bind(params));
    return { changes: res.changes, lastInsertRowid: cell(res.lastInsertRowid) };
  },
  // one step, so no other call runs between the check and the CREATE: created false = it was already there
  create: ({ sql, name, maxTables }) => {
    const stmt = db.prepare(sql);
    if (stmt.reader) throw Object.assign(new Error('not a schema statement'), { code: 'not_ddl' });
    return db
      .transaction(() => {
        if (exists(name)) return { created: false };
        if (countTables() >= maxTables)
          throw Object.assign(new Error(`the datastore holds at most ${maxTables} tables`), {
            code: 'too_many',
          });
        stmt.run();
        if (!exists(name))
          throw Object.assign(new Error('the statement did not create that table'), { code: 'not_created' });
        return { created: true };
      })
      .immediate();
  },
  ddl: ({ sql }) => {
    const stmt = db.prepare(sql);
    if (stmt.reader) throw Object.assign(new Error('not a schema statement'), { code: 'not_ddl' });
    stmt.run();
    return { ok: true };
  },
  size: () => {
    const pages = db.pragma('page_count', { simple: true });
    const pageSize = db.pragma('page_size', { simple: true });
    return { bytes: pages * pageSize, maxBytes: maxPageCount * pageSize };
  },
};

process.on('message', (m) => {
  try {
    const fn = ops[m.op];
    if (!fn) throw new Error(`unknown op ${m.op}`);
    process.send({ id: m.id, ok: true, result: fn(m.args ?? {}) });
  } catch (e) {
    process.send({
      id: m.id,
      ok: false,
      error: { message: e instanceof Error ? e.message : String(e), code: e?.code ?? 'sqlite' },
    });
  }
});
// the module closed the channel (idle, shutdown) or the server died: close the file and go
process.on('disconnect', () => {
  try {
    db.close();
  } finally {
    process.exit(0);
  }
});
process.send({ ready: true });
