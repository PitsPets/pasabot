/**
 * Setup codes for the desktop window (ARCHITECTURE 4.1, 4.3): one live code at a time, none once an owner exists,
 * a fresh link only over the parent channel (`pasabot:setup-link`), and a reload loop cannot churn the table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootTestServer, type TestServer } from '../../../../packages/testkit/src/index.js';
import { attachParentChannel } from '../host/parent-channel.js';
import { SETUP_REMINT_MS } from './index.js';

const tokenOf = (link: string) => link.split('token=')[1]!;
const claim = (s: TestServer, token: string) =>
  fetch(`${s.url}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, displayName: 'Diwa', password: 'correct horse' }),
  });
const unused = (s: TestServer) =>
  (s.db.prepare('SELECT COUNT(*) AS n FROM setup_tokens WHERE used_at IS NULL').get() as { n: number }).n;

/** a stand-in for `process` as the desktop launcher's child sees it */
function fakeParent() {
  const sent: Record<string, unknown>[] = [];
  let listener: ((m: unknown) => void) | null = null;
  return {
    sent,
    ch: {
      connected: () => true,
      send: (m: Record<string, unknown>) => sent.push(m),
      onMessage: (l: (m: unknown) => void) => {
        listener = l;
      },
    },
    ask(m: unknown) {
      listener?.(m);
      return sent.at(-1);
    },
  };
}

let servers: TestServer[] = [];
const boot = async () => {
  const s = await bootTestServer();
  servers.push(s);
  return s;
};
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.map((s) => s.cleanup()));
  servers = [];
});

describe('setup codes: one live code at a time', () => {
  it('minting a new code invalidates every older unused one', async () => {
    const s = await boot();
    const boot1 = tokenOf(s.setupLink!);
    const second = s.auth.issueSetupToken();
    const third = s.auth.issueSetupToken();
    expect(unused(s)).toBe(1);
    expect((await claim(s, boot1)).status).toBe(403);
    expect((await claim(s, second)).status).toBe(403);
    expect((await claim(s, third)).status).toBe(200);
  });

  it('minting is refused once an owner exists, and no fresh link is handed out', async () => {
    const s = await boot();
    expect((await claim(s, tokenOf(s.setupLink!))).status).toBe(200);
    expect(() => s.auth.issueSetupToken()).toThrow(/owner_exists/);
    expect(s.auth.freshSetupLink()).toBeNull();
    expect(unused(s)).toBe(0);
  });

  it('debounce: asks within the window get the same unused link and write nothing; later asks mint anew', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await boot();
    const first = s.auth.freshSetupLink()!;
    // the boot link is still young: the parent gets it back, nothing is minted
    expect(first).toBe(s.setupLink);
    const rows = () => (s.db.prepare('SELECT COUNT(*) AS n FROM setup_tokens').get() as { n: number }).n;
    const before = rows();
    for (let i = 0; i < 100; i++) expect(s.auth.freshSetupLink()).toBe(first);
    expect(rows()).toBe(before);
    vi.setSystemTime(Date.now() + SETUP_REMINT_MS + 1);
    const later = s.auth.freshSetupLink()!;
    expect(later).not.toBe(first);
    expect(unused(s)).toBe(1);
    expect((await claim(s, tokenOf(first))).status).toBe(403);
    expect((await claim(s, tokenOf(later))).status).toBe(200);
  });

  it('within the window, a link that no longer works is replaced, not handed out again', async () => {
    const s = await boot();
    // a code minted elsewhere (`pasabot setup-link`) killed the boot one
    s.auth.issueSetupToken();
    const viaAsk = s.auth.freshSetupLink()!;
    expect(viaAsk).not.toBe(s.setupLink);
    expect((await claim(s, tokenOf(viaAsk))).status).toBe(200);
  });

  it('an expired code is refused (30 min)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await boot();
    vi.setSystemTime(Date.now() + 30 * 60_000 + 1);
    expect((await claim(s, tokenOf(s.setupLink!))).status).toBe(403);
    // the desktop window asks again: a new code, which works
    const fresh = s.auth.freshSetupLink()!;
    expect((await claim(s, tokenOf(fresh))).status).toBe(200);
  });
});

describe('parent channel: pasabot:setup-link', () => {
  it('ready carries the boot link; an ask gets a working link; after the claim the answer is null', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await boot();
    const p = fakeParent();
    attachParentChannel(s, p.ch);
    expect(p.sent[0]).toMatchObject({ type: 'pasabot:ready', url: s.url, setupLink: s.setupLink });
    // hours later (the window sat open): the boot code has expired, the ask mints a fresh one
    vi.setSystemTime(Date.now() + 4 * 3600_000);
    const reply = p.ask({ type: 'pasabot:setup-link' }) as { type: string; setupLink: string };
    expect(reply.type).toBe('pasabot:setup-link');
    expect(reply.setupLink).toMatch(/\/#\/setup\?token=[\w-]{40,}$/);
    expect(reply.setupLink).not.toBe(s.setupLink);
    // a reload loop right after: the same link, no new row
    expect((p.ask({ type: 'pasabot:setup-link' }) as { setupLink: string }).setupLink).toBe(reply.setupLink);
    expect((await claim(s, tokenOf(reply.setupLink))).status).toBe(200);
    expect(p.ask({ type: 'pasabot:setup-link' })).toEqual({ type: 'pasabot:setup-link', setupLink: null });
  });

  it('unknown or malformed messages get no answer', async () => {
    const s = await boot();
    const p = fakeParent();
    attachParentChannel(s, p.ch);
    const n = p.sent.length;
    for (const m of [
      null,
      'pasabot:setup-link',
      { type: 'pasabot:setup-links' },
      { kind: 'pasabot:setup-link' },
    ])
      p.ask(m);
    expect(p.sent.length).toBe(n);
  });

  it('no HTTP route hands out or mints a setup link', async () => {
    const s = await boot();
    const before = unused(s);
    for (const path of [
      '/api/v1/setup',
      '/api/v1/setup-link',
      '/api/v1/setup/link',
      '/api/v1/setup?link=1',
    ]) {
      const r = await fetch(`${s.url}${path}`);
      expect(await r.text()).not.toContain('token=');
    }
    expect(unused(s)).toBe(before);
  });
});
