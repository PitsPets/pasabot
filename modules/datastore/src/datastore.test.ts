import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import datastoreModule from './server.js';
import { Datastore } from './store.js';

type Rpc = { error?: string } & Record<string, any>;
const rpc = async (url: string, bearer: string, name: string, args: unknown): Promise<Rpc> => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = j.result.content[0]!.text;
  return j.result.isError ? { error: text } : JSON.parse(text);
};

describe('datastore module (tools over /mcp + owner REST)', () => {
  let s: TestServer;
  let owner: string;
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let guardedB: { id: string; token: string };
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/datastore${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const run = (agentId: string, sender = { kind: 'owner', trust: 'trusted' }) => {
    const { token, runId } = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { id: 'x', name: 'Someone', ...sender } }), runId);
    return token;
  };
  /** a call that must ask first: wait for its approval, answer it, return the tier and the result */
  const asked = async (agentId: string, call: Promise<Rpc>, decision: 'approved' | 'denied' = 'approved') => {
    let row: { id: string; tier: number } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id, tier FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(agentId) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error('no approval was asked');
    s.approvals.decide(row.id, decision, 'owner');
    return { tier: row.tier, result: await call };
  };
  const pendingApprovals = () =>
    (s.db.prepare("SELECT count(*) AS n FROM approvals WHERE state = 'pending'").get() as { n: number }).n;

  beforeAll(async () => {
    s = await bootTestServer({ modules: [datastoreModule] });
    owner = seedUser(s.db).token;
    const aid = seedAgent(s.db, { trust: 'trusted', slug: 'tala' });
    const bid = seedAgent(s.db, { trust: 'trusted', slug: 'ligaya' });
    const gid = seedAgent(s.db, { trust: 'guarded' });
    a = { id: aid, token: run(aid) };
    b = { id: bid, token: run(bid) };
    guardedB = { id: gid, token: run(gid) };
  });
  afterAll(() => s.cleanup());

  it('keeps rows in a separate datastore.db, never in pasabot.db', async () => {
    const r = await rpc(s.url, a.token, 'datastore_create_table', {
      sql: 'CREATE TABLE fruits (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kilos REAL)',
    });
    expect(r).toEqual({ created: true, table: 'fruits' });
    expect(existsSync(join(s.home, 'modules', 'datastore', 'datastore.db'))).toBe(true);
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'fruits'").get()).toBeUndefined();
    expect(s.db.prepare('SELECT owner_agent_id FROM datastore_table WHERE name = ?').get('fruits')).toEqual({
      owner_agent_id: a.id,
    });
  });

  it('every agent lists tables with DDL, row count and creator, and can query and write them', async () => {
    expect(
      await rpc(s.url, a.token, 'datastore_write', {
        sql: 'INSERT INTO fruits (name, kilos) VALUES (?, ?)',
        params: ['mangga', 2.5],
      }),
    ).toMatchObject({ changes: 1 });
    const listed = (await rpc(s.url, b.token, 'datastore_list_tables', {})) as unknown as {
      name: string;
      ddl: string;
      rows: number;
      createdBy: { agentId: string; name: string };
      you: boolean;
    }[];
    const fruits = listed.find((t) => t.name === 'fruits')!;
    expect(fruits.ddl).toContain('CREATE TABLE fruits');
    expect(fruits.rows).toBe(1);
    expect(fruits.createdBy).toEqual({ agentId: a.id, name: 'tala' });
    expect(fruits.you).toBe(false);
    const q = await rpc(s.url, b.token, 'datastore_query', {
      sql: 'SELECT name, kilos FROM fruits WHERE kilos > ?',
      params: [1],
    });
    expect(q).toEqual({ columns: ['name', 'kilos'], rows: [['mangga', 2.5]], truncated: false });
  });

  it("agent B's DROP on A's table is refused, by every road, without asking the owner", async () => {
    const before = pendingApprovals();
    const viaDrop = await rpc(s.url, b.token, 'datastore_drop_table', { table: 'fruits' });
    expect(viaDrop.error).toMatch(/only the agent that created "fruits" may drop it/);
    const viaCase = await rpc(s.url, b.token, 'datastore_drop_table', { table: 'FRUITS' });
    expect(viaCase.error).toMatch(/only the agent that created/);
    const viaWrite = await rpc(s.url, b.token, 'datastore_write', { sql: 'DROP TABLE fruits' });
    expect(viaWrite.error).toMatch(/write statements only; this one is drop/);
    const viaQuery = await rpc(s.url, b.token, 'datastore_query', { sql: 'DROP TABLE fruits' });
    expect(viaQuery.error).toMatch(/query statements only/);
    const viaAlter = await rpc(s.url, b.token, 'datastore_alter_table', {
      sql: 'ALTER TABLE fruits DROP COLUMN kilos',
    });
    expect(viaAlter.error).toMatch(/only the agent that created "fruits" may alter it/);
    const viaRename = await rpc(s.url, b.token, 'datastore_alter_table', {
      sql: 'ALTER TABLE fruits RENAME TO mine_now',
    });
    expect(viaRename.error).toMatch(/only the agent that created/);
    // a query that sneaks a write in a CTE is caught by SQLite's own read-only flag
    const cte = await rpc(s.url, b.token, 'datastore_query', {
      sql: 'WITH x AS (SELECT 1) DELETE FROM fruits',
    });
    expect(cte.error).toMatch(/read-only/);
    expect(pendingApprovals()).toBe(before);
    expect(
      (await rpc(s.url, a.token, 'datastore_query', { sql: 'SELECT count(*) AS n FROM fruits' })).rows,
    ).toEqual([[1]]);
  });

  it('the creator drops its own table only after the owner approves (tier 3); denied keeps it', async () => {
    await rpc(s.url, a.token, 'datastore_create_table', { sql: 'CREATE TABLE scratch (x)' });
    const denied = await asked(
      a.id,
      rpc(s.url, a.token, 'datastore_drop_table', { table: 'scratch' }),
      'denied',
    );
    expect(denied.tier).toBe(3);
    expect(denied.result.error).toMatch(/not approved/);
    const ok = await asked(a.id, rpc(s.url, a.token, 'datastore_drop_table', { table: 'scratch' }));
    expect(ok).toEqual({ tier: 3, result: { dropped: 'scratch' } });
    const names = (
      (await rpc(s.url, a.token, 'datastore_list_tables', {})) as unknown as { name: string }[]
    ).map((t) => t.name);
    expect(names).not.toContain('scratch');
  });

  it('the creator alters its own table; adding a column needs no approval, dropping one asks', async () => {
    await rpc(s.url, a.token, 'datastore_create_table', { sql: 'CREATE TABLE stock (item TEXT, qty INT)' });
    expect(
      await rpc(s.url, a.token, 'datastore_alter_table', { sql: 'ALTER TABLE stock ADD COLUMN note TEXT' }),
    ).toEqual({ altered: 'stock' });
    const dropCol = await asked(
      a.id,
      rpc(s.url, a.token, 'datastore_alter_table', { sql: 'ALTER TABLE stock DROP COLUMN note' }),
    );
    expect(dropCol).toEqual({ tier: 3, result: { altered: 'stock' } });
    expect(
      await rpc(s.url, a.token, 'datastore_alter_table', { sql: 'ALTER TABLE stock RENAME TO supplies' }),
    ).toEqual({ altered: 'supplies' });
    // the creator follows the rename
    expect(s.db.prepare('SELECT owner_agent_id FROM datastore_table WHERE name = ?').get('supplies')).toEqual(
      {
        owner_agent_id: a.id,
      },
    );
  });

  it("rows in another agent's table: insert/update ask the owner (tier 2), delete is tier 3", async () => {
    const tierOf = (name: string, input: unknown, agentId: string) => {
      const t = s.tools.get(name)!.tier;
      return typeof t === 'function' ? t(input, { agent: { id: agentId } } as never) : t;
    };
    expect(tierOf('datastore_write', { sql: 'INSERT INTO fruits (name) VALUES (1)' }, a.id)).toBe(1);
    expect(tierOf('datastore_write', { sql: 'INSERT INTO fruits (name) VALUES (1)' }, b.id)).toBe(2);
    expect(tierOf('datastore_write', { sql: 'UPDATE fruits SET kilos = 1' }, b.id)).toBe(2);
    expect(tierOf('datastore_write', { sql: 'DELETE FROM fruits' }, b.id)).toBe(3);
    expect(tierOf('datastore_write', { sql: 'DELETE FROM fruits' }, a.id)).toBe(1);
    expect(tierOf('datastore_query', { sql: 'SELECT 1' }, b.id)).toBe(0);
    expect(tierOf('datastore_list_tables', {}, b.id)).toBe(0);
    expect(tierOf('datastore_create_table', { sql: 'CREATE TABLE z (a)' }, b.id)).toBe(1);
    expect(tierOf('datastore_drop_table', { table: 'fruits' }, a.id)).toBe(3);
    // a trusted agent on an owner turn writes another agent's table without a card (tier 2 auto at `trusted`)
    expect(
      await rpc(s.url, b.token, 'datastore_write', {
        sql: "INSERT INTO fruits (name, kilos) VALUES ('saging', 1)",
      }),
    ).toMatchObject({ changes: 1 });
    // a guarded agent is asked first
    const g = await asked(
      guardedB.id,
      rpc(s.url, guardedB.token, 'datastore_write', {
        sql: "INSERT INTO fruits (name, kilos) VALUES ('lansones', 3)",
      }),
    );
    expect(g).toMatchObject({ tier: 2, result: { changes: 1 } });
  });

  it('parser rejects ATTACH, PRAGMA and multi-statement SQL on every tool, before SQLite sees it', async () => {
    const pasabotDb = join(s.home, 'pasabot.db');
    for (const [tool, sql] of [
      ['datastore_query', `ATTACH DATABASE '${pasabotDb}' AS core`],
      ['datastore_write', `ATTACH DATABASE '${pasabotDb}' AS core`],
      ['datastore_create_table', 'PRAGMA writable_schema = ON'],
      ['datastore_query', 'PRAGMA table_list'],
      ['datastore_query', 'SELECT 1; SELECT 2'],
      ['datastore_write', "INSERT INTO fruits (name) VALUES ('x'); DELETE FROM fruits"],
      ['datastore_create_table', 'CREATE TABLE ok (a); DROP TABLE fruits'],
      ['datastore_query', 'SELECT * FROM sqlite_master'],
      ['datastore_write', 'INSERT INTO main.fruits (name) VALUES (1)'],
    ] as const) {
      const r = await rpc(s.url, a.token, tool, { sql });
      expect(r.error, `${tool}: ${sql}`).toMatch(/not allowed|one SQL statement|reserved|schema-qualified/);
    }
    expect(
      (await rpc(s.url, a.token, 'datastore_query', { sql: 'SELECT count(*) FROM fruits' })).rows[0][0],
    ).toBeGreaterThan(0);
  });

  it('10 000-row insert in one call takes under a second', async () => {
    await rpc(s.url, a.token, 'datastore_create_table', {
      sql: 'CREATE TABLE readings (id INTEGER PRIMARY KEY, sensor TEXT, value REAL, ok INTEGER)',
    });
    const rows = Array.from({ length: 10_000 }, (_, i) => [`sensor-${i % 7}`, i / 3, i % 2 === 0]);
    const t0 = performance.now();
    const r = await rpc(s.url, a.token, 'datastore_write', {
      sql: 'INSERT INTO readings (sensor, value, ok) VALUES (?, ?, ?)',
      rows,
    });
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ changes: 10_000 });
    expect(ms).toBeLessThan(1000);
    console.log(`10k-row insert over /mcp: ${ms.toFixed(0)} ms`);
    const n = await rpc(s.url, a.token, 'datastore_query', { sql: 'SELECT count(*), sum(ok) FROM readings' });
    expect(n.rows).toEqual([[10_000, 5000]]);
  });

  it('a runaway query is stopped at the time limit and the store keeps working', async () => {
    const store = new Datastore({ path: join(s.home, 'runaway.db'), maxPageCount: 1000, timeoutMs: 300 });
    const t0 = performance.now();
    await expect(
      store.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        undefined,
        10,
        1000,
      ),
    ).rejects.toThrow(/longer than 300 ms/);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect((await store.query('SELECT 41 + 1', undefined, 10, 1000)).rows).toEqual([[42]]);
    await store.close();
  });

  /** true once no process with this id is left (signal 0 only checks) */
  const gone = async (pid: number, withinMs: number) => {
    const until = performance.now() + withinMs;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw e;
      }
      if (performance.now() > until) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('a runaway statement inside one native step is really stopped: its process is gone and holds no lock', async () => {
    const store = new Datastore({ path: join(s.home, 'zombie.db'), maxPageCount: 1000, timeoutMs: 300 });
    await store.ddl('CREATE TABLE own (n)');
    const endless = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c';
    // a read: the aggregate never returns a row, so it never leaves sqlite3_step
    const first = store.workerPid!;
    await expect(store.query(endless, undefined, 10, 1000)).rejects.toThrow(/longer than 300 ms/);
    expect(await gone(first, 1000)).toBe(true);
    // a write that holds the WAL write lock while it spins
    await store.query('SELECT 1', undefined, 1, 100);
    const second = store.workerPid!;
    expect(second).not.toBe(first);
    await expect(store.write(`INSERT INTO own ${endless}`)).rejects.toThrow(/longer than 300 ms/);
    expect(await gone(second, 1000)).toBe(true);
    // the lock went with it: the next write lands at once, not after busy_timeout (2 s) with SQLITE_BUSY
    const t0 = performance.now();
    expect(await store.write('INSERT INTO own VALUES (1)')).toMatchObject({ changes: 1 });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect((await store.query('SELECT count(*) FROM own', undefined, 1, 100)).rows).toEqual([[1]]);
    // a close in the middle of a runaway statement does not hang either
    const third = store.workerPid!;
    const stuck = store.query(endless, undefined, 10, 1000).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 50));
    await store.close();
    expect(await stuck).toBeInstanceOf(Error);
    expect(await gone(third, 1000)).toBe(true);
  });

  it('injection: a stranger-started turn of a trusted agent cannot touch another agent’s table unasked', async () => {
    const stranger = run(b.id, { kind: 'external', trust: 'guarded' });
    const write = await asked(
      b.id,
      rpc(s.url, stranger, 'datastore_write', { sql: 'UPDATE fruits SET kilos = 0' }),
      'denied',
    );
    expect(write.tier).toBe(2);
    expect(write.result.error).toMatch(/not approved/);
    const drop = await rpc(s.url, stranger, 'datastore_drop_table', { table: 'fruits' });
    expect(drop.error).toMatch(/only the agent that created/);
    const attach = await rpc(s.url, stranger, 'datastore_query', {
      sql: `SELECT 1 /* */ ; ATTACH '${join(s.home, 'pasabot.db')}' AS core`,
    });
    expect(attach.error).toMatch(/one SQL statement/);
  });

  it('a secret value stored in a row never leaves the server', async () => {
    await s.vault.put('global', 'supplier_key', 'sk-test-9f8e7d6c5b4a3210');
    await rpc(s.url, a.token, 'datastore_write', {
      sql: 'INSERT INTO fruits (name, kilos) VALUES (?, 0)',
      params: ['sk-test-9f8e7d6c5b4a3210'],
    });
    const q = await rpc(s.url, b.token, 'datastore_query', {
      sql: 'SELECT name FROM fruits WHERE kilos = 0',
    });
    expect(JSON.stringify(q)).not.toContain('sk-test-9f8e7d6c5b4a3210');
    expect(q.rows[0][0]).toContain('[secret');
    const browse = await (await api('/tables/fruits/rows?limit=200')).text();
    expect(browse).not.toContain('sk-test-9f8e7d6c5b4a3210');
  });

  it('a table that changed hands after the tier was decided is refused, never run', async () => {
    await rpc(s.url, a.token, 'datastore_create_table', { sql: 'CREATE TABLE handoff (x)' });
    const def = s.tools.get('datastore_write')!;
    const ctx = { agent: { id: a.id } } as never;
    const input = { sql: 'DELETE FROM handoff' };
    expect((def.tier as (i: unknown, c: never) => number)(input, ctx)).toBe(1); // own table: no approval
    s.db.prepare('UPDATE datastore_table SET owner_agent_id = ? WHERE name = ?').run(b.id, 'handoff');
    await expect(def.handler(input, ctx)).rejects.toThrow(/changed while this call waited/);
  });

  it('two agents racing to create one table: exactly one becomes its creator, IF NOT EXISTS never takes it over', async () => {
    const create = s.tools.get('datastore_create_table')!;
    const ctxA = { agent: { id: a.id } } as never;
    const ctxB = { agent: { id: b.id } } as never;
    for (let k = 0; k < 5; k++) {
      const name = `race${k}`;
      const results = await Promise.allSettled([
        create.handler({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY)` }, ctxA),
        create.handler({ sql: `CREATE TABLE IF NOT EXISTS ${name} (a)` }, ctxB),
        create.handler({ sql: `CREATE TABLE IF NOT EXISTS ${name} (a)` }, ctxB),
      ]);
      const made = results.filter(
        (r) => r.status === 'fulfilled' && (r.value as { created: boolean }).created,
      );
      expect(made, name).toHaveLength(1);
      const winner = results[0]!.status === 'fulfilled' ? a.id : b.id;
      expect(s.db.prepare('SELECT owner_agent_id FROM datastore_table WHERE name = ?').get(name)).toEqual({
        owner_agent_id: winner,
      });
    }
    // a no-op IF NOT EXISTS on an existing table leaves its creator alone
    expect(await create.handler({ sql: 'CREATE TABLE IF NOT EXISTS fruits (a)' }, ctxB)).toEqual({
      created: false,
      table: 'fruits',
    });
    expect(s.db.prepare('SELECT owner_agent_id FROM datastore_table WHERE name = ?').get('fruits')).toEqual({
      owner_agent_id: a.id,
    });
  });

  it("REPLACE conflict resolution on another agent's table deletes rows, so it is tier 3 like DELETE", async () => {
    const tierOf = (sql: string, agentId: string) =>
      (s.tools.get('datastore_write')!.tier as (i: unknown, c: never) => number)({ sql }, {
        agent: { id: agentId },
      } as never);
    for (const sql of [
      'UPDATE OR REPLACE fruits SET id = 1',
      'REPLACE INTO fruits (id) VALUES (1)',
      "INSERT OR REPLACE INTO fruits (id, name) VALUES (1, 'x')",
    ]) {
      expect(tierOf(sql, b.id), sql).toBe(3);
      expect(tierOf(sql, a.id), sql).toBe(1);
    }
    // an upsert only changes the existing row, like UPDATE
    expect(
      tierOf("INSERT INTO fruits (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = 'y'", b.id),
    ).toBe(2);
    // end to end: a trusted agent on an owner turn is asked first, and a denied call deletes nothing
    const before = (await rpc(s.url, a.token, 'datastore_query', { sql: 'SELECT count(*) FROM fruits' }))
      .rows;
    expect(before[0][0]).toBeGreaterThan(1);
    const denied = await asked(
      b.id,
      rpc(s.url, b.token, 'datastore_write', { sql: 'UPDATE OR REPLACE fruits SET id = 1' }),
      'denied',
    );
    expect(denied.tier).toBe(3);
    // W38: replacing rows of another agent's table is the fixed delete class
    expect(denied.result.error).toMatch(/did not approve this delete action/);
    expect(
      (await rpc(s.url, a.token, 'datastore_query', { sql: 'SELECT count(*) FROM fruits' })).rows,
    ).toEqual(before);
  });

  it("W38: deleting rows of another agent's or a shared table is class delete (always asks, app only); own rows do not", async () => {
    const classOf = (sql: string, agentId: string) =>
      (s.tools.get('datastore_write')!.actionClass as (i: unknown, c: never) => string | undefined)({ sql }, {
        agent: { id: agentId },
      } as never);
    expect(classOf('DELETE FROM fruits', b.id)).toBe('delete');
    expect(classOf('REPLACE INTO fruits (id, name) VALUES (1, ?)', b.id)).toBe('delete');
    expect(classOf("UPDATE fruits SET name = 'y'", b.id)).toBeUndefined();
    expect(classOf('DELETE FROM fruits', a.id)).toBeUndefined();
    // a shared table (no agent created it, e.g. the owner's) counts as not the agent's own
    await rpc(s.url, a.token, 'datastore_create_table', { sql: 'CREATE TABLE shared_notes (x)' });
    s.db.prepare('UPDATE datastore_table SET owner_agent_id = NULL WHERE name = ?').run('shared_notes');
    expect(classOf('DELETE FROM shared_notes', a.id)).toBe('delete');

    // over /mcp at trust "trusted" on an owner turn: the card names the table and its maker
    const pending = rpc(s.url, b.token, 'datastore_write', {
      sql: 'DELETE FROM fruits WHERE id = ?',
      params: [1],
    });
    let id = '';
    for (let n = 0; n < 200 && !id; n++) {
      id =
        (
          s.db.prepare("SELECT id FROM approvals WHERE agent_id = ? AND state = 'pending'").get(b.id) as
            | { id: string }
            | undefined
        )?.id ?? '';
      if (!id) await new Promise((r) => setTimeout(r, 20));
    }
    const card = s.approvals.get(id)!;
    expect(card.ask?.class).toBe('delete');
    expect(card.ask?.fields.slice(0, 2)).toEqual([
      { key: 'target', value: 'delete rows of table "fruits"' },
      { key: 'where', value: 'shared datastore, a table another agent made (tala)' },
    ]);
    // ApprovalService.decide from a module (or a channel) cannot approve it
    expect(s.approvals.forModules().decide(id, 'approved', 'owner')).toBeNull();
    s.approvals.decide(id, 'denied', 'owner');
    expect((await pending).error).toMatch(/did not approve this delete action/);
    // the agent's own rows: no card at all
    const before = pendingApprovals();
    expect(
      await rpc(s.url, a.token, 'datastore_write', { sql: 'DELETE FROM fruits WHERE id = -1' }),
    ).toMatchObject({
      changes: 0,
    });
    expect(pendingApprovals()).toBe(before);
  });

  it("a REFERENCES from another agent's table cannot pin the creator's rows or block its drop", async () => {
    await rpc(s.url, a.token, 'datastore_create_table', { sql: 'CREATE TABLE f2 (id INTEGER PRIMARY KEY)' });
    expect(
      await rpc(s.url, a.token, 'datastore_write', { sql: 'INSERT INTO f2 VALUES (1), (2)' }),
    ).toMatchObject({
      changes: 2,
    });
    expect(
      await rpc(s.url, b.token, 'datastore_create_table', { sql: 'CREATE TABLE pin (x REFERENCES f2(id))' }),
    ).toEqual({ created: true, table: 'pin' });
    expect(
      await rpc(s.url, b.token, 'datastore_write', { sql: 'INSERT INTO pin SELECT id FROM f2' }),
    ).toMatchObject({
      changes: 2,
    });
    expect(
      await rpc(s.url, a.token, 'datastore_write', { sql: 'DELETE FROM f2 WHERE id = 1' }),
    ).toMatchObject({
      changes: 1,
    });
    const ok = await asked(a.id, rpc(s.url, a.token, 'datastore_drop_table', { table: 'f2' }));
    expect(ok).toEqual({ tier: 3, result: { dropped: 'f2' } });
  });

  it('query results are capped; duplicate names are refused', async () => {
    const q = await rpc(s.url, b.token, 'datastore_query', { sql: 'SELECT id FROM readings', limit: 5 });
    expect(q.rows).toHaveLength(5);
    expect(q.truncated).toBe(true);
    const dup = await rpc(s.url, b.token, 'datastore_create_table', { sql: 'CREATE TABLE Fruits (a)' });
    expect(dup.error).toMatch(/already exists/);
    expect(
      await rpc(s.url, b.token, 'datastore_create_table', { sql: 'CREATE TABLE IF NOT EXISTS fruits (a)' }),
    ).toEqual({ created: false, table: 'fruits' });
  });

  it('owner REST lists, browses and runs read-only queries; nobody else may', async () => {
    const t = (await (await api('/tables')).json()) as {
      tables: { name: string; rows: number; createdBy: { name: string } | null }[];
      size: { bytes: number; maxBytes: number };
    };
    expect(t.tables.find((x) => x.name === 'fruits')).toMatchObject({ createdBy: { name: 'tala' } });
    expect(t.size.maxBytes).toBe(65_536 * 4096);
    const rows = (await (await api('/tables/fruits/rows?limit=2')).json()) as {
      columns: string[];
      rows: unknown[];
    };
    expect(rows.columns).toEqual(['id', 'name', 'kilos']);
    expect(rows.rows).toHaveLength(2);
    expect((await api('/tables/nope/rows')).status).toBe(404);
    const ok = await api('/query', {
      method: 'POST',
      body: JSON.stringify({ sql: 'SELECT name FROM fruits LIMIT 1' }),
    });
    expect(ok.status).toBe(200);
    for (const sql of ['DELETE FROM fruits', "ATTACH 'x' AS y", 'SELECT 1; SELECT 2']) {
      const bad = await api('/query', { method: 'POST', body: JSON.stringify({ sql }) });
      expect(bad.status, sql).toBe(400);
    }
    const member = seedUser(s.db, 'member', 'Mia').token;
    expect((await api('/tables', {}, member)).status).toBe(403);
    expect((await api('/tables', {}, a.token)).status).toBe(401);
  });
});
