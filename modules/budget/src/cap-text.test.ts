/**
 * A cap card's plain text (message body, notification) comes from the budget:server.* keys: English by default, the
 * owner's language when the server passes its `t`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CapCard, capText } from './server.js';

const card: CapCard = {
  alertId: 'a1',
  agentId: 'ag1',
  agentName: 'Tala',
  scope: 'agent',
  period: 'day',
  cap: 5,
  spent: 5.2,
  currency: 'USD',
  reason: 'stopped',
  state: 'open',
};
const load = (lng: string) =>
  JSON.parse(readFileSync(new URL(`../locales/${lng}.json`, import.meta.url), 'utf8')).server as Record<
    string,
    string
  >;
const tFor = (lng: string) => {
  const s = load(lng);
  return (k: string, p: Record<string, string | number> = {}) =>
    (s[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(p[n] ?? ''));
};

describe('cap card text', () => {
  it('is the English sentence by default, the same keys as en.json', () => {
    expect(capText(card)).toBe(
      'Tala reached the daily budget (5.2 of 5 USD). Tala stopped; what it wrote so far is kept.',
    );
    expect(capText(card)).toBe(capText(card, tFor('en')));
    expect(capText({ ...card, scope: 'global', period: 'month', reason: 'reached' })).toBe(
      'All agents reached the monthly budget (5.2 of 5 USD).',
    );
  });
  it('reads in the owner’s language, with no English words', () => {
    for (const lng of ['ja', 'ar', 'hi', 'de']) {
      const out = capText({ ...card, reason: 'held' }, tFor(lng));
      expect(out, lng).toContain('5.2');
      expect(out, lng).not.toMatch(/\b(reached|budget|waits)\b/);
    }
  });
});
