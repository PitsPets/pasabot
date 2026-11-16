import { describe, expect, it } from 'vitest';
import { matchesSafe, parseGraph, unsafePattern } from './graph.js';

/**
 * Review finding: "`matches` runs agent/user-supplied RegExp on the main thread (ReDoS)". Not the case: a pattern is
 * refused at save time (`parseGraph` → `unsafePattern`) and every test runs in a worker with a hard timeout and a
 * capped input. These tests prove the main thread stays free while a catastrophic pattern runs.
 */
describe('matches never blocks the server', () => {
  it('the event loop keeps ticking while a catastrophic pattern is cut off by the timeout', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    // passes the save-time shape check (8 plain repeats) yet backtracks polynomially (n^8) on 2,000 characters
    const slow = 'a*a*a*a*a*a*a*a*c';
    expect(unsafePattern(slow)).toBeNull();
    const res = await Promise.all([
      matchesSafe(slow, 'a'.repeat(5_000), 200),
      matchesSafe(slow, `${'a'.repeat(1_999)}b`, 200),
    ]);
    clearInterval(timer);
    expect(res).toEqual([false, false]);
    expect(Date.now() - t0).toBeLessThan(3_000);
    // a blocked main thread would show ~0 ticks over the ~200 ms the workers ran
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it('save time refuses the catastrophic shapes, so a graph holding one is never stored', () => {
    for (const p of ['^(\\w+\\s?)*$', '(a+)+$', '(a|a)*b', '(.*a){12}'])
      expect(unsafePattern(p), p).not.toBeNull();
    const graph = (value: string) => ({
      nodes: [
        { id: 'c', type: 'condition', position: { x: 0, y: 0 }, data: { op: 'matches', value } },
        { id: 't', type: 'transform', position: { x: 0, y: 0 }, data: { template: 'T' } },
        { id: 'f', type: 'transform', position: { x: 0, y: 0 }, data: { template: 'F' } },
      ],
      edges: [
        { id: 'ct', source: 'c', target: 't', branch: 'true' },
        { id: 'cf', source: 'c', target: 'f', branch: 'false' },
      ],
    });
    expect(() => parseGraph(graph('(a+)+$'))).toThrow(/repeated group/);
    expect(parseGraph(graph('^order #\\d{3,6}$')).nodes).toHaveLength(3);
  });
});
