/**
 * The collab module defers its bus work a tick (setImmediate). An event published while the server shuts down can
 * leave that work to run after the database closed; it must then be dropped quietly, never thrown from a bare
 * setImmediate (where nothing can catch it: CI saw "The database connection is not open" as an unhandled error).
 */
import { bootTestServer } from '@pasabot/testkit';
import { describe, expect, it, vi } from 'vitest';
import collab from './server.js';

describe('collab bus work after the server closed', () => {
  it('is dropped, not thrown, once the database is closed', async () => {
    const s = await bootTestServer({ modules: [collab] });
    const deferred: (() => void)[] = [];
    // hold the module's deferred callbacks instead of running them, so they run only after close()
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: () => void) => {
      deferred.push(fn);
      return { ref() {}, unref() {}, hasRef: () => false } as unknown as NodeJS.Immediate;
    }) as typeof setImmediate);
    try {
      s.bus.publish('server' as never, 'run.started', { id: 'run-1', queueItemId: 'item-1' } as never);
      s.bus.publish('server' as never, 'approval.requested', { runId: 'run-1', state: 'pending' } as never);
      s.bus.publish('server' as never, 'queue.changed', {
        items: [{ id: 'item-1', chatId: null, state: 'cancelled' }],
      } as never);
    } finally {
      spy.mockRestore();
    }
    // one deferred callback per event, all from the collab listener (nothing else defers on these publishes)
    expect(deferred.length).toBe(3);
    await s.cleanup();
    expect(s.db.open).toBe(false);
    for (const fn of deferred) expect(fn).not.toThrow();
  });
});
