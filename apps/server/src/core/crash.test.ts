import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CORE_MIGRATIONS_DIR, openDatabase, runMigrations } from '@pasabot/db';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
  tempHome,
} from '../../../../packages/testkit/src/index.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const child = join(import.meta.dirname, '__fixtures__', 'crash-child.ts');

/** Run the server in a child process until both runs are mid-turn, then SIGKILL (or SIGTERM) it. */
async function crashMidRun(home: string, scenario: unknown, signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL') {
  const p = spawn(
    process.execPath,
    ['--conditions=source', '--import', 'tsx', child, home, JSON.stringify(scenario)],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PASABOT_SOURCE: '1' },
    },
  );
  let err = '';
  p.stderr.on('data', (d) => {
    err += String(d);
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`child never reported RUNNING: ${err}`)), 20_000);
    p.stdout.on('data', (d) => {
      if (String(d).includes('RUNNING')) {
        clearTimeout(t);
        resolve();
      }
    });
    p.on('exit', (code) => reject(new Error(`child exited early (${code}): ${err}`)));
  });
  p.removeAllListeners('exit');
  const exited = new Promise((r) => p.on('exit', (c, sig) => r(sig ?? c)));
  p.kill(signal);
  expect(await exited).toBe(signal === 'SIGKILL' ? 'SIGKILL' : 0);
}

describe('test:crash', () => {
  const home = tempHome('pasabot-crash-');
  let s: TestServer | undefined;
  afterAll(async () => {
    await s?.close();
    home.cleanup();
  });

  it('kill -9 mid Fake run: interrupted, chat waits, routine does not block, Retry runs it', async () => {
    // seed the db the child will use
    const db = openDatabase(join(home.dir, 'pasabot.db'));
    runMigrations(db, [{ module: 'core', dir: CORE_MIGRATIONS_DIR }]);
    const tala = seedAgent(db, { slug: 'tala' });
    const bayani = seedAgent(db, { slug: 'bayani' });
    const owner = seedUser(db);
    const chat = seedChat(db, { userIds: [owner.id], agentIds: [tala] });
    db.close();

    await crashMidRun(home.dir, {
      items: [
        { agentId: tala, chatId: chat, kind: 'message', label: 'm1' },
        { agentId: tala, chatId: chat, kind: 'message', label: 'm2' },
        { agentId: bayani, chatId: null, kind: 'routine', label: 'r1' },
      ],
      expectRunning: 2,
    });

    // give each crashed turn a live run bearer, as W0b will (`run_tokens`), to prove recovery revokes it
    const pre = openDatabase(join(home.dir, 'pasabot.db'));
    const crashedRuns = pre.prepare("SELECT id, agent_id FROM runs WHERE state = 'running'").all() as {
      id: string;
      agent_id: string;
    }[];
    expect(crashedRuns).toHaveLength(2);
    for (const r of crashedRuns) {
      pre
        .prepare('INSERT INTO run_tokens (token_hash, run_id, agent_id, created_at) VALUES (?, ?, ?, ?)')
        .run(`hash-${r.id}`, r.id, r.agent_id, Date.now());
    }
    pre.close();

    // restart in-process with a fast Fake
    const order: string[] = [];
    const fast = new FakeProvider({
      script: (input) => {
        order.push(input.user.text);
        return [{ event: { type: 'text.final', text: 'ok' } }, { event: { type: 'done', stop: 'end' } }];
      },
    });
    s = await bootTestServer({ home: home.dir, providers: [fast] });
    const byLabel = (label: string) =>
      s!.db.prepare("SELECT * FROM queue_items WHERE json_extract(payload, '$.label') = ?").get(label) as {
        id: string;
        state: string;
      };

    // both mid-run items are interrupted, never silently retried
    expect(byLabel('m1').state).toBe('interrupted');
    expect(byLabel('r1').state).toBe('interrupted');
    // their runs are closed as interrupted, their bearers revoked, and run.finished was published
    for (const label of ['m1', 'r1']) {
      const run = s.db.prepare('SELECT * FROM runs WHERE queue_item_id = ?').get(byLabel(label).id) as {
        id: string;
        state: string;
        finished_at: number | null;
      };
      expect(run.state, label).toBe('interrupted');
      expect(run.finished_at, label).not.toBeNull();
      expect(
        s.db.prepare('SELECT revoked_at FROM run_tokens WHERE run_id = ?').get(run.id),
        label,
      ).toMatchObject({ revoked_at: expect.any(Number) });
      const fin = s.db
        .prepare("SELECT data FROM events WHERE type = 'run.finished' AND json_extract(data, '$.id') = ?")
        .get(run.id) as { data: string } | undefined;
      expect(JSON.parse(fin!.data).state, label).toBe('interrupted');
    }
    // the interrupted chat run left a Retry/Skip system message in the chat
    const sys = s.db
      .prepare("SELECT blocks FROM messages WHERE chat_id = ? AND author_kind = 'system'")
      .all(chat) as {
      blocks: string;
    }[];
    expect(sys.map((m) => JSON.parse(m.blocks)[0])).toEqual([
      { kind: 'core.interrupted', v: 1, data: { queueItemId: byLabel('m1').id, partial: 'working' } },
    ]);
    // no reply is left streaming (no stale typing bubble): its partial text lives in the card
    expect(
      (s.db.prepare("SELECT count(*) AS n FROM messages WHERE status = 'streaming'").get() as { n: number })
        .n,
    ).toBe(0);
    expect(
      (
        s.db
          .prepare("SELECT count(*) AS n FROM messages WHERE author_kind = 'agent' AND chat_id = ?")
          .get(chat) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    // the interrupted routine notified the owner instead
    const notes = s.db.prepare("SELECT data FROM events WHERE type = 'notification'").all() as {
      data: string;
    }[];
    expect(notes.some((n) => JSON.parse(n.data).text.includes('routine'))).toBe(true);

    // the interrupted routine does not block bayani's next chat item; tala's next chat item waits behind m1
    s.queue.enqueue({
      agentId: bayani,
      kind: 'message',
      payload: { text: 'm3', label: 'm3' },
      source: { sender: { kind: 'owner', id: owner.id, name: 'Owner', trust: 'trusted' } },
    });
    await expect.poll(() => byLabel('m3').state).toBe('done');
    await new Promise((r) => setTimeout(r, 200));
    expect(byLabel('m2').state).toBe('queued');
    expect(order).toEqual(['m3']);

    // Retry (plain REST) runs m1, and only then m2 - conversational order is kept
    const retry = await fetch(`${s.url}/api/v1/queue/${byLabel('m1').id}/retry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(retry.status).toBe(200);
    await expect.poll(() => byLabel('m2').state).toBe('done');
    expect(byLabel('m1').state).toBe('done');
    expect(order).toEqual(['m3', 'm1', 'm2']);

    // the interrupted routine can be retried too; Skip only applies to interrupted items
    expect(
      (
        await fetch(`${s.url}/api/v1/queue/${byLabel('r1').id}/retry`, {
          method: 'POST',
          headers: { authorization: `Bearer ${owner.token}` },
        })
      ).status,
    ).toBe(200);
    await expect.poll(() => byLabel('r1').state).toBe('done');
    expect(
      (
        await fetch(`${s.url}/api/v1/queue/${byLabel('r1').id}/skip`, {
          method: 'POST',
          headers: { authorization: `Bearer ${owner.token}` },
        })
      ).status,
    ).toBe(409);
  });

  it('SIGTERM mid-run (graceful shutdown) leaves the turn interrupted with Retry/Skip, never cancelled', async () => {
    const h = tempHome('pasabot-term-');
    const db = openDatabase(join(h.dir, 'pasabot.db'));
    runMigrations(db, [{ module: 'core', dir: CORE_MIGRATIONS_DIR }]);
    const tala = seedAgent(db, { slug: 'tala' });
    const owner = seedUser(db);
    const chat = seedChat(db, { userIds: [owner.id], agentIds: [tala] });
    db.close();

    await crashMidRun(
      h.dir,
      {
        items: [
          { agentId: tala, chatId: chat, kind: 'message', label: 't1' },
          { agentId: tala, chatId: chat, kind: 'message', label: 't2' },
        ],
        expectRunning: 1,
      },
      'SIGTERM',
    );

    const order: string[] = [];
    const fast = new FakeProvider({
      script: (input) => {
        order.push(input.user.text);
        return [{ event: { type: 'text.final', text: 'ok' } }, { event: { type: 'done', stop: 'end' } }];
      },
    });
    const t = await bootTestServer({ home: h.dir, providers: [fast] });
    try {
      const byLabel = (label: string) =>
        t.db.prepare("SELECT * FROM queue_items WHERE json_extract(payload, '$.label') = ?").get(label) as {
          id: string;
          state: string;
        };
      expect(byLabel('t1').state).toBe('interrupted');
      expect(
        (
          t.db.prepare('SELECT state FROM runs WHERE queue_item_id = ?').get(byLabel('t1').id) as {
            state: string;
          }
        ).state,
      ).toBe('interrupted');
      const sys = t.db
        .prepare("SELECT blocks FROM messages WHERE chat_id = ? AND author_kind = 'system'")
        .all(chat) as { blocks: string }[];
      expect(sys.map((m) => JSON.parse(m.blocks)[0])).toEqual([
        { kind: 'core.interrupted', v: 1, data: { queueItemId: byLabel('t1').id, partial: 'working' } },
      ]);
      // the next chat item waits behind the interrupted one
      await new Promise((r) => setTimeout(r, 200));
      expect(byLabel('t2').state).toBe('queued');
      expect(order).toEqual([]);
      const retry = await fetch(`${t.url}/api/v1/queue/${byLabel('t1').id}/retry`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(retry.status).toBe(200);
      await expect.poll(() => byLabel('t2').state).toBe('done');
      expect(order).toEqual(['t1', 't2']);
    } finally {
      await t.close();
      h.cleanup();
    }
  });

  it('boot recovery: leased -> queued, retryOnCrash items requeue up to 3 attempts', async () => {
    const h = tempHome('pasabot-recover-');
    const first = await bootTestServer({ home: h.dir, dispatcher: { autoStart: false } });
    const a = seedAgent(first.db);
    const src = { sender: { kind: 'system' as const, id: null, name: 'sys', trust: 'standard' as const } };
    const leased = first.queue.enqueue({ agentId: a, kind: 'message', payload: {}, source: src }).item;
    const b = seedAgent(first.db);
    const idem = first.queue.enqueue({
      agentId: b,
      kind: 'routine',
      payload: { retryOnCrash: true },
      source: src,
    }).item;
    // a conversational kind never auto-retries, whatever its payload says
    const c = seedAgent(first.db);
    const chatty = first.queue.enqueue({
      agentId: c,
      kind: 'message',
      payload: { retryOnCrash: true },
      source: src,
    }).item;
    first.queue.leaseNext(a, 'dead-boot');
    first.queue.leaseNext(b, 'dead-boot');
    first.queue.leaseNext(c, 'dead-boot');
    first.queue.markRunning(idem.id, 'dead-boot');
    first.queue.markRunning(chatty.id, 'dead-boot');
    expect(() =>
      first.queue.registerKind('demo.chat', { priority: 0, blocksOnInterrupt: true, idempotent: true }),
    ).toThrow(/cannot be idempotent/);
    await first.close();
    const second = await bootTestServer({ home: h.dir, dispatcher: { autoStart: false } });
    expect(second.queue.get(leased.id)?.state).toBe('queued');
    expect(second.queue.get(idem.id)).toMatchObject({ state: 'queued', attempts: 1 });
    expect(second.queue.get(chatty.id)?.state).toBe('interrupted');
    second.db
      .prepare("UPDATE queue_items SET state = 'running', attempts = 3, lease_owner = 'dead' WHERE id = ?")
      .run(idem.id);
    await second.close();
    const third = await bootTestServer({ home: h.dir, dispatcher: { autoStart: false } });
    expect(third.queue.get(idem.id)?.state).toBe('interrupted');
    await third.close();
    h.cleanup();
  });
});
