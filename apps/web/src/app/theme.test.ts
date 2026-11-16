/** The look a person sees: Dark until they pick another one (Light, or Auto that follows the device). */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, readLook } from './theme.js';

const g = globalThis as { localStorage?: unknown; sessionStorage?: unknown };
afterEach(() => {
  delete g.localStorage;
  delete g.sessionStorage;
});
/** a Storage over a Map, so a test can see what readLook kept */
const fake = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
};
const device = (local: Record<string, string> = {}, session: Record<string, string> = {}) => {
  const l = fake(local);
  g.localStorage = l;
  g.sessionStorage = fake(session);
  return l.m;
};

describe('look', () => {
  it('is Dark for a truly fresh device (nothing stored, or storage unavailable), and stays Dark after use', () => {
    expect(DEFAULT_LOOK).toBe('dark');
    const m = device();
    expect(readLook()).toBe('dark');
    expect(m.has('pasabot.look')).toBe(false);
    // the app is used afterwards (a language, a remembered account): the device was settled, it is not migrated
    m.set('pasabot.lang', 'fil');
    expect(readLook()).toBe('dark');
    delete g.localStorage;
    expect(readLook()).toBe('dark');
  });
  it('keeps what the person picked: Light, Dark or Auto (follow the device)', () => {
    for (const v of ['light', 'dark', 'auto'] as const) {
      device({ 'pasabot.look': v, 'pasabot.lang': 'en' });
      expect(readLook()).toBe(v);
    }
  });
  it('an existing device with no stored look (old Auto removed the key) keeps Auto, once and for good', () => {
    for (const [local, session] of [
      [{ 'pasabot.lang': 'fil' }, {}],
      [{ 'pasabot.account': '{"id":"u1","name":"Ana"}' }, {}],
      [{ 'pasabot.details:u1': '1' }, {}],
      [{}, { 'pasabot.lastSeq': '42' }],
    ] as const) {
      const m = device(local, session);
      expect(readLook()).toBe('auto');
      expect(m.get('pasabot.look')).toBe('auto');
      expect(readLook()).toBe('auto');
    }
    // other sites' keys are not this app's prefs
    device({ 'other.app': 'x' });
    expect(readLook()).toBe('dark');
  });
  it('storage that throws reads as the default', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readLook()).toBe('dark');
  });
});
