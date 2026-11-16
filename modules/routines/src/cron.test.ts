import { describe, expect, it } from 'vitest';
import { nextAfter, parseCron, slotsBetween, toIcs } from './cron.js';
import { evalLogic } from './jsonlogic.js';

const at = (s: string) => Date.parse(s);

describe('cron', () => {
  it('steps, ranges, lists and both day fields', () => {
    const c = parseCron('*/15 9-10 * * 1-5');
    expect(nextAfter(c, 'UTC', at('2026-11-13T09:07:00Z'))).toBe(at('2026-11-13T09:15:00Z'));
    expect(nextAfter(c, 'UTC', at('2026-11-13T10:45:00Z'))).toBe(at('2026-11-16T09:00:00Z')); // Fri -> Mon
    const either = parseCron('0 0 1 * 0'); // 1st of month OR a Sunday
    expect(nextAfter(either, 'UTC', at('2026-11-13T00:00:00Z'))).toBe(at('2026-11-15T00:00:00Z'));
    expect(parseCron('0 0 * * 7').dow.has(0)).toBe(true);
  });
  it('time zones, including a DST change', () => {
    const c = parseCron('30 7 * * *');
    expect(nextAfter(c, 'Asia/Manila', at('2026-11-13T00:00:00Z'))).toBe(at('2026-11-13T23:30:00Z'));
    // New York leaves DST on 1 Nov 2026: 07:30 local is 11:30Z before, 12:30Z after
    expect(nextAfter(c, 'America/New_York', at('2026-10-31T12:00:00Z'))).toBe(at('2026-11-01T12:30:00Z'));
  });
  it('rejects bad expressions', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '0 0 0 * *', '*/0 * * * *', 'a b c d e'])
      expect(() => parseCron(bad), bad).toThrow();
  });
  it('a rare cron is still fast to evaluate', () => {
    const t0 = performance.now();
    expect(nextAfter(parseCron('0 0 29 2 *'), 'UTC', at('2026-11-13T00:00:00Z'))).toBe(
      at('2028-02-29T00:00:00Z'),
    );
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it('30-day slots and iCalendar output', () => {
    const slots = slotsBetween(
      parseCron('0 9 * * *'),
      'UTC',
      at('2026-11-13T10:00:00Z'),
      at('2026-12-13T10:00:00Z'),
    );
    expect(slots).toHaveLength(30);
    const ics = toIcs([{ uid: 'a@b', at: slots[0]!, summary: 'x'.repeat(100) }], at('2026-11-13T10:00:00Z'));
    expect(ics).toContain('DTSTART:20261114T090000Z');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
});

describe('event filter', () => {
  it('evaluates the supported subset', () => {
    const d = { state: 'done', n: 3, tags: ['a'] };
    expect(evalLogic({ '==': [{ var: 'state' }, 'done'] }, d)).toBe(true);
    expect(evalLogic({ and: [{ '>': [{ var: 'n' }, 2] }, { in: ['a', { var: 'tags' }] }] }, d)).toBe(true);
    expect(evalLogic({ '!': { var: 'missing.deep' } }, d)).toBe(true);
    expect(evalLogic({ var: '__proto__.polluted' }, d)).toBe(null);
  });
});
