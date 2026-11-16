import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, seedAgent, type TestServer } from '../../../../packages/testkit/src/index.js';
import type { Executor } from './dispatcher.js';

const owner = { sender: { kind: 'owner' as const, id: 'o', name: 'Owner', trust: 'trusted' as const } };

describe('test:queue-priority', () => {
  let s: TestServer;
  afterEach(() => s.cleanup());

  function recorder() {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const executor: Executor = async (item) => {
      const label = (JSON.parse(item.payload) as { label: string }).label;
      order.push(label);
      if (label.startsWith('slow')) await new Promise<void>((r) => gates.set(label, r));
      return { state: 'done' };
    };
    return { order, gates, executor };
  }

  it('chat items overtake queued routine fires; FIFO within each priority', async () => {
    const rec = recorder();
    s = await bootTestServer({ executor: rec.executor });
    const a = seedAgent(s.db);
    s.queue.pause(a);
    const enq = (kind: string, label: string) =>
      s.queue.enqueue({ agentId: a, kind, payload: { label }, source: owner });
    enq('routine', 'r1');
    enq('message', 'c1');
    enq('routine', 'r2');
    enq('task', 't1');
    enq('message', 'c2');
    enq('routine', 'r3');
    s.queue.resume(a);
    await s.dispatcher.idle();
    expect(rec.order).toEqual(['c1', 'c2', 't1', 'r1', 'r2', 'r3']);
  });

  it('a chat item enqueued while a routine runs goes next, ahead of older routine fires', async () => {
    const rec = recorder();
    s = await bootTestServer({ executor: rec.executor });
    const a = seedAgent(s.db);
    const enq = (kind: string, label: string) =>
      s.queue.enqueue({ agentId: a, kind, payload: { label }, source: owner });
    enq('routine', 'slow-r0');
    await expect.poll(() => rec.order).toEqual(['slow-r0']);
    enq('routine', 'r1');
    enq('routine', 'r2');
    enq('message', 'c1');
    expect(s.queue.list(a).map((i) => [i.kind, i.state])).toEqual([
      ['message', 'queued'],
      ['routine', 'running'],
      ['routine', 'queued'],
      ['routine', 'queued'],
    ]);
    rec.gates.get('slow-r0')!();
    await s.dispatcher.idle();
    expect(rec.order).toEqual(['slow-r0', 'c1', 'r1', 'r2']);
  });

  it('one runner per agent, a global pool across agents, idem keys dedupe, depth cap refuses', async () => {
    const rec = recorder();
    s = await bootTestServer({
      executor: rec.executor,
      dispatcher: { maxConcurrentAgents: 2 },
      queue: { depthCap: 3 },
    });
    const [a, b, c] = [seedAgent(s.db), seedAgent(s.db), seedAgent(s.db)];
    for (const [ag, l] of [
      [a, 'slow-a1'],
      [a, 'a2'],
      [b, 'slow-b1'],
      [c, 'slow-c1'],
    ] as const) {
      s.queue.enqueue({ agentId: ag, kind: 'message', payload: { label: l }, source: owner });
    }
    await expect.poll(() => rec.order.length).toBe(2);
    expect(s.dispatcher.runningItems()).toHaveLength(2); // pool of 2: the third agent waits
    expect(rec.order).not.toContain('a2'); // a's second item waits for a's first
    rec.gates.get('slow-a1')?.();
    rec.gates.get('slow-b1')?.();
    await expect.poll(() => rec.order.length).toBe(4);
    rec.gates.get('slow-c1')?.();
    await s.dispatcher.idle();
    expect(new Set(rec.order)).toEqual(new Set(['slow-a1', 'a2', 'slow-b1', 'slow-c1']));

    const first = s.queue.enqueue({
      agentId: a,
      kind: 'message',
      payload: { label: 'x' },
      source: owner,
      idemKey: 'k1',
    });
    const again = s.queue.enqueue({
      agentId: a,
      kind: 'message',
      payload: { label: 'x' },
      source: owner,
      idemKey: 'k1',
    });
    expect(again).toEqual({ item: expect.objectContaining({ id: first.item.id }), duplicate: true });

    s.queue.pause(b);
    for (let i = 0; i < 3; i++)
      s.queue.enqueue({ agentId: b, kind: 'message', payload: { label: `f${i}` }, source: owner });
    expect(() => s.queue.enqueue({ agentId: b, kind: 'message', payload: {}, source: owner })).toThrow(
      /full/,
    );
  });

  it('held items wait for resume_at; unknown kinds are refused; modules can register kinds', async () => {
    const rec = recorder();
    s = await bootTestServer({ executor: rec.executor });
    const a = seedAgent(s.db);
    expect(() => s.queue.enqueue({ agentId: a, kind: 'nope', payload: {}, source: owner })).toThrow(
      /unknown queue kind/,
    );
    s.queue.registerKind('collab.delegate', { priority: 10, blocksOnInterrupt: true });
    s.queue.pause(a);
    const { item } = s.queue.enqueue({
      agentId: a,
      kind: 'collab.delegate',
      payload: { label: 'held' },
      source: owner,
    });
    s.queue.hold(item.id, Date.now() + 150, 'rate_limit');
    s.queue.resume(a);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.queue.get(item.id)?.state).toBe('held');
    await expect.poll(() => s.queue.get(item.id)?.state, { timeout: 3000 }).toBe('done');
  });

  it('a failed state write never wedges the agent: the lease is swept at runtime and the queue moves on', async () => {
    const rec = recorder();
    s = await bootTestServer({
      executor: rec.executor,
      queue: { leaseMs: 150 },
      dispatcher: { renewMs: 30, sweepMs: 30, pollMs: 20 },
    });
    const a = seedAgent(s.db);
    const realFinish = s.queue.finish.bind(s.queue);
    let fail = true;
    s.queue.finish = (...args) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return realFinish(...args);
    };
    const r1 = s.queue.enqueue({ agentId: a, kind: 'routine', payload: { label: 'r1' }, source: owner }).item;
    const r2 = s.queue.enqueue({ agentId: a, kind: 'routine', payload: { label: 'r2' }, source: owner }).item;
    await expect.poll(() => s.queue.get(r2.id)?.state, { timeout: 5000 }).toBe('done');
    expect(s.queue.get(r1.id)?.state).toBe('interrupted');
    expect(s.dispatcher.runningItems()).toEqual([]);
    expect(rec.order).toEqual(['r1', 'r2']);
  });

  it("a kind's admit check runs at dispatch time: a refused item ends cancelled and never executes", async () => {
    const rec = recorder();
    s = await bootTestServer({ executor: rec.executor });
    const a = seedAgent(s.db);
    const withdrawn = new Set<string>();
    s.queue.registerKind('test.gated', {
      priority: 50,
      blocksOnInterrupt: false,
      admit: (item) => {
        const label = (item.payload as { label: string }).label;
        if (label === 'boom') throw new Error('check failed');
        return withdrawn.has(label) ? 'withdrawn' : null;
      },
    });
    s.queue.pause(a);
    const enq = (label: string) =>
      s.queue.enqueue({ agentId: a, kind: 'test.gated', payload: { label }, source: owner }).item;
    const ok = enq('ok');
    const gone = enq('gone');
    const boom = enq('boom');
    // allowed at enqueue time, withdrawn while it waited
    withdrawn.add('gone');
    s.queue.resume(a);
    await s.dispatcher.idle();
    expect(rec.order).toEqual(['ok']);
    expect(s.queue.get(ok.id)?.state).toBe('done');
    expect(s.queue.get(gone.id)).toMatchObject({ state: 'cancelled', error: 'withdrawn' });
    expect(s.queue.get(boom.id)).toMatchObject({ state: 'cancelled', error: 'refused: check failed' });
  });
});
