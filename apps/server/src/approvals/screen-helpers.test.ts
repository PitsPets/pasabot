/**
 * ARCHITECTURE 8 "Screen helpers" (security review 2026-11-15): a helper that drives the owner's own screen could
 * use one approved click to press Approve on another card in the owner's PasaBot window. So: a computer-use card
 * needs a fresh re-auth for that one card (the 5-minute window never counts), an agent has at most one pending,
 * while a screen action runs (and 2 s after) no approval goes through, while a helper is active sensitive cards
 * need a fresh re-auth too, and an approve carries the card's own nonce.
 */
import { randomBytes } from 'node:crypto';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bootTestServer,
  seedAgent,
  seedRunToken,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { hashToken } from '../core/services.js';
import { SCREEN_BUSY_TEXT, SCREEN_QUIET_MS } from './index.js';

const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('approvals vs screen helpers', () => {
  let s: TestServer;
  let token = '';
  let ownerId = '';
  /** the slow screen tool waits on this until the test lets it finish */
  let release: (() => void) | null = null;
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const run = () => {
    const agentId = seedAgent(s.db, { trust: 'trusted' });
    const r = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(
        JSON.stringify({ sender: { kind: 'owner', id: ownerId, name: 'Owner', trust: 'trusted' } }),
        r.runId,
      );
    return { ...r, agentId };
  };
  const call = (bearer: string, name: string, args: unknown) =>
    fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }).then(async (r) => {
      const j = (await r.json()) as any;
      return { isError: !!j.result?.isError, text: String(j.result?.content?.[0]?.text ?? j.error?.message) };
    });
  const pendingFor = (runId: string) =>
    waitFor(() => s.approvals.list('pending').find((a) => a.runId === runId));
  const approve = (a: { id: string; nonce?: string }, nonce: unknown = a.nonce) =>
    api(`/api/v1/approvals/${a.id}/approve`, nonce === undefined ? {} : { nonce });
  const quiet = async () => {
    while (s.approvals.screenBusy()) await sleep(50);
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()] });
    const setup = await fetch(`${s.url}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: s.auth.issueSetupToken(),
        displayName: 'Owner',
        password: 'owner-password',
      }),
    });
    ownerId = ((await setup.json()) as any).user.id;
    // an older session of the owner: nothing re-authed yet
    token = randomBytes(32).toString('base64url');
    s.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), ownerId, Date.now() - 3600_000, Date.now() + 3600_000);
    s.tools.add({
      name: 'screen_click',
      title: 'Click',
      description: 'clicks the screen',
      input: z.object({ x: z.number() }),
      tier: 3,
      noAlwaysAllow: true,
      screenControl: true,
      handler: async () => ({ ok: true }),
    });
    s.tools.add({
      name: 'screen_slow',
      title: 'Slow click',
      description: 'clicks the screen, slowly',
      input: z.object({}),
      tier: 3,
      noAlwaysAllow: true,
      screenControl: true,
      handler: () =>
        new Promise((r) => {
          release = () => r({ ok: true });
        }),
    });
    s.tools.add({
      name: 'note_write',
      title: 'Write a note',
      description: 'writes a note',
      input: z.object({ n: z.number() }),
      tier: 2,
      noAlwaysAllow: true,
      handler: async () => ({ ok: true }),
    });
    s.tools.add({
      name: 'shop_pay',
      title: 'Pay',
      description: 'pays',
      input: z.object({ amount: z.string(), merchant: z.string() }),
      tier: 1,
      actionClass: 'money',
      handler: async () => ({ paid: true }),
    });
  });
  afterAll(async () => {
    await s?.cleanup();
  });

  it('a computer-use card needs a fresh re-auth for that one card; the 5-minute window never counts', async () => {
    await quiet();
    const r = run();
    const res = call(r.token, 'screen_click', { x: 1 });
    const a = await pendingFor(r.runId);
    expect(a).toMatchObject({ screen: true, tier: 3 });
    expect(typeof a.nonce).toBe('string');
    // a re-auth a minute ago (the 5-minute window) is not enough
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password' })).status).toBe(200);
    expect(await approve(a)).toMatchObject({ status: 401, json: { error: 'reauth_required', fresh: true } });
    // nor a re-auth made for another card
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password', for: 'OTHERCARD' })).status).toBe(
      200,
    );
    expect((await approve(a)).status).toBe(401);
    // a wrong password for this card proves nothing
    expect((await api('/api/v1/auth/reauth', { password: 'nope-nope', for: a.id })).status).toBe(401);
    expect((await approve(a)).status).toBe(401);
    // the password typed just now for this card: approved
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password', for: a.id })).status).toBe(200);
    expect((await approve(a)).status).toBe(200);
    expect((await res).isError).toBe(false);
    // and that re-auth is used up: the next screen card asks again
    await quiet();
    const next = call(r.token, 'screen_click', { x: 2 });
    const b = await pendingFor(r.runId);
    expect((await approve(b)).status).toBe(401);
    // a module, channel or automation never approves a screen card
    expect(s.approvals.forModules().decide(b.id, 'approved', ownerId)).toBeNull();
    expect((await api(`/api/v1/approvals/${b.id}/deny`, {})).status).toBe(200);
    expect((await next).isError).toBe(true);
  });

  it('an agent has at most one computer-use card pending; a parallel second call is refused without a card', async () => {
    await quiet();
    const r = run();
    const first = call(r.token, 'screen_click', { x: 1 });
    const a = await pendingFor(r.runId);
    const second = await call(r.token, 'screen_click', { x: 2 });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/one screen step at a time/);
    expect(s.approvals.list('pending').filter((x) => x.agentId === r.agentId)).toHaveLength(1);
    // another agent may still ask for its own
    const other = run();
    const third = call(other.token, 'screen_click', { x: 3 });
    const c = await pendingFor(other.runId);
    expect(c.agentId).toBe(other.agentId);
    for (const x of [a, c]) expect((await api(`/api/v1/approvals/${x.id}/deny`, {})).status).toBe(200);
    expect((await first).isError).toBe(true);
    expect((await third).isError).toBe(true);
  });

  it('while a screen action runs, and 2 s after, no approval of any kind goes through (deny still does)', async () => {
    await quiet();
    const r = run();
    const slow = call(r.token, 'screen_slow', {});
    const a = await pendingFor(r.runId);
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password', for: a.id })).status).toBe(200);
    expect((await approve(a)).status).toBe(200);
    await waitFor(() => release);
    expect(s.approvals.screenBusy()).toBe(true);
    // a plain tier-2 card of another agent: the helper's click may be what pressed Approve
    const o = run();
    const note = call(o.token, 'note_write', { n: 1 });
    const p = await pendingFor(o.runId);
    expect(await approve(p)).toMatchObject({
      status: 409,
      json: { error: 'screen_busy', message: SCREEN_BUSY_TEXT },
    });
    // nor through a channel or module
    expect(s.approvals.forModules().decide(p.id, 'approved', ownerId)).toBeNull();
    expect(s.approvals.get(p.id)?.state).toBe('pending');
    // refusing is always safe
    const o2 = run();
    const note2 = call(o2.token, 'note_write', { n: 2 });
    const q = await pendingFor(o2.runId);
    expect((await api(`/api/v1/approvals/${q.id}/deny`, {})).status).toBe(200);
    expect((await note2).isError).toBe(true);
    // the action ends: still refused for the quiet window, then it goes through
    release!();
    release = null;
    expect((await slow).isError).toBe(false);
    expect((await approve(p)).json.error).toBe('screen_busy');
    await sleep(SCREEN_QUIET_MS + 100);
    expect((await approve(p)).status).toBe(200);
    expect((await note).isError).toBe(false);
  });

  it('while a helper is active, money and other sensitive cards need a fresh re-auth for that one card', async () => {
    await quiet();
    const r = run();
    // no helper: the 5-minute window is enough for money, as before
    const paid = call(r.token, 'shop_pay', { amount: '5.00 PHP', merchant: 'Tindahan' });
    const m = await pendingFor(r.runId);
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password' })).status).toBe(200);
    expect((await approve(m)).status).toBe(200);
    expect((await paid).isError).toBe(false);
    // a helper was just handed control of the screen (the computer module calls this per grant)
    s.approvals.forModules().noteScreenGrant!();
    expect(s.approvals.screenActive()).toBe(true);
    const paid2 = call(r.token, 'shop_pay', { amount: '9.00 PHP', merchant: 'Tindahan' });
    const m2 = await pendingFor(r.runId);
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password' })).status).toBe(200);
    expect(await approve(m2)).toMatchObject({ status: 401, json: { error: 'reauth_required', fresh: true } });
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password', for: m2.id })).status).toBe(200);
    expect((await approve(m2)).status).toBe(200);
    expect((await paid2).isError).toBe(false);
    // a plain tier-2 card is not sensitive: no re-auth even while a helper is active
    const n = call(r.token, 'note_write', { n: 3 });
    const c = await pendingFor(r.runId);
    expect((await approve(c)).status).toBe(200);
    expect((await n).isError).toBe(false);
  });

  it("an approve carries the card's own nonce: none, another card's, or a replay is refused", async () => {
    await quiet();
    const r1 = run();
    const r2 = run();
    const n1 = call(r1.token, 'note_write', { n: 1 });
    const n2 = call(r2.token, 'note_write', { n: 2 });
    const a = await pendingFor(r1.runId);
    const b = await pendingFor(r2.runId);
    expect(a.nonce).not.toBe(b.nonce);
    expect(await approve(a, null)).toMatchObject({ status: 403, json: { error: 'wrong_card' } });
    expect(await approve(a, b.nonce)).toMatchObject({ status: 403, json: { error: 'wrong_card' } });
    expect(await approve(a, `${a.nonce}x`)).toMatchObject({ status: 403 });
    expect(s.approvals.get(a.id)?.state).toBe('pending');
    expect((await approve(a)).status).toBe(200);
    // replaying the same answer: already decided
    expect((await approve(a)).status).toBe(409);
    expect((await approve(b)).status).toBe(200);
    expect((await n1).isError).toBe(false);
    expect((await n2).isError).toBe(false);
    // the nonce reaches the owner's app (the list, the chat card) but never what modules read
    expect((await api('/api/v1/approvals')).json.approvals.find((x: any) => x.id === a.id).nonce).toBe(
      a.nonce,
    );
    expect(s.approvals.forModules().get(a.id)?.nonce).toBeUndefined();
  });
});
