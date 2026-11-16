/**
 * Pin writes: one at a time, newest wins (an older answer never lands over a newer toggle, a failure rolls back to
 * what the server last confirmed), and Move up/down works on the pins on screen, not on hidden or gone ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { body: string[]; resolve(v: unknown): void; reject(e: unknown): void }[] = [];
vi.mock('./api.js', () => ({
  api: (path: string, init?: { body?: { value: string[] } }) =>
    new Promise((resolve, reject) => {
      if (path === '/api/v1/me/prefs/ui.pins') calls.push({ body: init!.body!.value, resolve, reject });
      else resolve(null);
    }),
}));
const { getPrefs, movePin, resetPrefs, setPins, togglePin } = await import('./prefs.js');
const answer = (i: number) => calls[i]!.resolve({ prefs: { 'ui.pins': calls[i]!.body, 'ui.tidied': true } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pins', () => {
  beforeEach(() => {
    calls.length = 0;
    resetPrefs();
  });

  it('a toggle made while a write is in flight is not undone by that older answer', async () => {
    const a = togglePin('routines', true);
    await flush();
    expect(calls.map((c) => c.body)).toEqual([['routines']]);
    const b = togglePin('inbox', true);
    expect(getPrefs().pins).toEqual(['routines', 'inbox']);
    answer(0);
    await a;
    // the first write's answer is older than the screen: the screen keeps both
    expect(getPrefs().pins).toEqual(['routines', 'inbox']);
    await flush();
    expect(calls.map((c) => c.body)).toEqual([['routines'], ['routines', 'inbox']]);
    answer(1);
    await b;
    expect(getPrefs().pins).toEqual(['routines', 'inbox']);
  });

  it('toggles that a newer one replaced before they were sent are never sent', async () => {
    togglePin('routines', true);
    togglePin('inbox', true);
    const c = togglePin('routines', false);
    await flush();
    expect(calls.map((x) => x.body)).toEqual([['inbox']]);
    answer(0);
    await c;
    expect(getPrefs().pins).toEqual(['inbox']);
  });

  it('a failed write rolls back to the last list the server confirmed', async () => {
    const a = setPins(['routines']);
    await flush();
    answer(0);
    await a;
    const b = setPins(['routines', 'inbox']);
    await flush();
    calls[1]!.reject(new Error('offline'));
    await b;
    expect(getPrefs().pins).toEqual(['routines']);
    expect(getPrefs().error).toBe(true);
  });

  it('Move up swaps with the pin above on screen and leaves a pin that is not drawn in its place', async () => {
    const a = setPins(['routines', 'gone-plugin', 'inbox']);
    await flush();
    answer(0);
    await a;
    const m = movePin('inbox', -1, ['routines', 'inbox']);
    expect(getPrefs().pins).toEqual(['inbox', 'gone-plugin', 'routines']);
    await flush();
    answer(1);
    await m;
    // the top pin on screen cannot move up
    expect(movePin('inbox', -1, ['inbox', 'routines'])).toBeUndefined();
  });
});
