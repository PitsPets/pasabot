import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, seedAgent, type TestServer } from '../../../../packages/testkit/src/index.js';
import { GATE_FAILED_REASON, type QueueRow, SqliteQueue } from './queue.js';

const owner = { sender: { kind: 'owner' as const, id: 'o', name: 'Owner', trust: 'trusted' as const } };
const LEAK = 'ENOENT /home/nena/.pasabot/vault.key sk-live-123';

describe('queue gates', () => {
  let s: TestServer;
  afterEach(() => s.cleanup());

  it('a crashing gate holds the item with a generic reason; the exception reaches the log only', async () => {
    s = await bootTestServer({ executor: async () => ({ state: 'done' }) });
    const a = seedAgent(s.db);
    s.queue.pause(a);
    s.queue.addGate(() => {
      throw new Error(LEAK);
    });
    const { id } = s.queue.enqueue({ agentId: a, kind: 'task', payload: {}, source: owner }).item;
    s.queue.resume(a);
    await s.dispatcher.idle();
    const row = s.queue.getRow(id)!;
    expect(row.state).toBe('held');
    expect(row.error).toBe(GATE_FAILED_REASON);

    // the same verdict on a queue with a log: the details go there
    const logged: { msg: string; data?: Record<string, unknown> }[] = [];
    const rec = (msg: string, data?: Record<string, unknown>) =>
      void logged.push({ msg, ...(data ? { data } : {}) });
    const log = { debug: rec, info: rec, warn: rec, error: rec, child: () => log };
    const q = new SqliteQueue(s.db, null, { log });
    q.addGate(() => {
      throw new Error(LEAK);
    });
    const v = q.gateVerdict(row as QueueRow);
    expect(v && 'hold' in v ? v.hold.reason : null).toBe(GATE_FAILED_REASON);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.data?.error).toBe(LEAK);
  });
});
