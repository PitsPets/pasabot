/**
 * 7.1 "Always asks": money and outbound messages ask at every trust level (here `trusted`, an owner turn), approve
 * runs the call once, deny refuses and a repeat is refused without a new card, the card shows the call's own
 * arguments, and neither a module nor a channel can approve one.
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
import { callFingerprint } from './index.js';

const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('test:always-ask', () => {
  let s: TestServer;
  let token = '';
  let ownerId = '';
  const ran: string[] = [];
  const api = async (path: string, body?: unknown, method?: string) => {
    const r = await fetch(`${s.url}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  /** a live run of a `trusted` agent on an owner turn (the most permissive case) */
  const trustedRun = () => {
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
    // an older session of the owner: approving money needs a fresh re-auth like tier 3
    token = randomBytes(32).toString('base64url');
    s.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), ownerId, Date.now() - 3600_000, Date.now() + 3600_000);
    s.tools.add({
      name: 'shop_buy',
      title: 'Buy',
      description: 'buys a thing',
      input: z.object({
        items: z.array(z.string()),
        merchant: z.string(),
        amount: z.string(),
        currency: z.string(),
        card: z.string(),
      }),
      tier: 1, // the tool's own tier would run without asking; the class still asks
      actionClass: 'money',
      handler: async (i) => {
        ran.push(`buy:${i.items.join('+')}`);
        return { ordered: true };
      },
    });
    s.tools.add({
      name: 'wallet_send',
      title: 'Send money',
      description: 'sends money from a wallet or bank account',
      input: z.object({
        to: z.string(),
        payee: z.string().optional(),
        amount: z.union([z.string(), z.number()]),
        currency: z.string(),
        note: z.string().optional(),
      }),
      tier: 1,
      actionClass: 'money',
      handler: async () => ({ sent: true }),
    });
    s.tools.add({
      name: 'mail_send',
      title: 'Send email',
      description: 'sends an email',
      input: z.object({ to: z.string(), subject: z.string().optional(), body: z.string() }),
      tier: 2,
      actionClass: 'outbound-message',
      handler: async (i) => {
        ran.push(`mail:${i.to}`);
        return { sent: true };
      },
    });
  });
  afterAll(() => s.cleanup());

  it('at trust "trusted" a money tool asks; the card shows the real arguments (card number masked); approve runs once', async () => {
    const run = trustedRun();
    const args = {
      items: ['Blue kettle'],
      merchant: 'Shop One',
      amount: '49.00',
      currency: 'USD',
      card: '4242 4242 4242 4242',
    };
    const res = call(run.token, 'shop_buy', args);
    const a = await pendingFor(run.runId);
    expect(a.tier).toBe(3);
    expect(a.ask?.class).toBe('money');
    expect(a.ask?.fields.slice(0, 4)).toEqual([
      { key: 'items', value: 'Blue kettle' },
      { key: 'merchant', value: 'Shop One' },
      { key: 'total', value: '49.00 USD' },
      { key: 'paymentMethod', value: '•••• 4242' },
    ]);
    // every always-ask card also shows the tool and its full arguments (masked)
    expect(a.ask?.fields.slice(4).map((f) => f.key)).toEqual(['tool', 'arguments']);
    expect(a.ask?.fields[4]?.value).toBe('shop_buy');
    expect(a.ask?.fields[5]?.value).toContain('Blue kettle');
    expect(JSON.stringify(a.ask)).not.toContain('4242 4242');
    expect(JSON.stringify(a.action)).not.toContain('4242 4242');
    // a module (or a channel reply) cannot approve it
    expect(s.approvals.forModules().decide(a.id, 'approved', ownerId)).toBeNull();
    // approving money needs the re-auth, like tier 3
    expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).json.error).toBe(
      'reauth_required',
    );
    expect((await api('/api/v1/auth/reauth', { password: 'owner-password' })).status).toBe(200);
    expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).status).toBe(200);
    const out = await res;
    expect(out.isError).toBe(false);
    expect(ran.filter((r) => r === 'buy:Blue kettle')).toHaveLength(1);
  });

  it('an outbound message asks at "trusted"; unknown fields read as not stated; deny refuses and a repeat is refused without a new card', async () => {
    const run = trustedRun();
    const args = { to: 'ana@example.test', body: 'See you at 6.\nBring the keys.' };
    const res = call(run.token, 'mail_send', args);
    const a = await pendingFor(run.runId);
    expect(a.tier).toBe(2);
    expect(a.ask?.class).toBe('outbound-message');
    expect(a.ask?.fields.slice(0, 4)).toEqual([
      { key: 'recipients', value: 'ana@example.test' },
      { key: 'channel', value: null },
      { key: 'subject', value: null },
      { key: 'text', value: 'See you at 6.\nBring the keys.' },
    ]);
    expect(a.ask?.fields.slice(4).map((f) => f.key)).toEqual(['tool', 'arguments']);
    expect((await api(`/api/v1/approvals/${a.id}/deny`, {})).status).toBe(200);
    const out = await res;
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/did not approve this outbound-message action/);
    expect(ran).not.toContain('mail:ana@example.test');
    // the same call again: refused at once, no new approval
    const before = s.approvals.list().length;
    const again = await call(run.token, 'mail_send', args);
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already refused this exact action/);
    expect(s.approvals.list().length).toBe(before);
  });

  it('a money call stores and serves card numbers masked, whatever separates the digits', async () => {
    const run = trustedRun();
    const res = call(run.token, 'shop_buy', {
      items: ['Lamp'],
      merchant: 'Shop Two',
      amount: '10.00',
      currency: 'USD',
      card: 'Visa 4111.1111.1111.1111 or 4111/1111/1111/1111',
    });
    const a = await pendingFor(run.runId);
    const row = s.db.prepare('SELECT action, ask FROM approvals WHERE id = ?').get(a.id) as any;
    for (const stored of [row.action, row.ask, JSON.stringify(a)]) {
      expect(stored).not.toContain('4111.1111');
      expect(stored).not.toContain('4111/1111');
      expect(stored).not.toContain('411111111111');
    }
    expect(a.ask?.fields.find((f) => f.key === 'paymentMethod')?.value).toBe('Visa •••• 1111 or •••• 1111');
    s.approvals.decide(a.id, 'denied', ownerId);
    await res;
  });

  it('a money card shows a 12+ digit or smallest-unit total and the payee account in clear; only card numbers are masked', async () => {
    const cases: { args: Record<string, unknown>; total: string; seen: string[] }[] = [
      {
        // 2,500 BTC in sats, to an IBAN payee; a card number hidden in a free-text note is still masked
        args: {
          to: 'payee-wallet',
          payee: 'DE89370400440532013000',
          amount: '250000000000',
          currency: 'sats',
          note: 'from card 4111 1111 1111 1111',
        },
        total: '250000000000 sats',
        seen: ['"amount": "250000000000"', 'DE89370400440532013000'],
      },
      {
        args: { to: 'payee-bank', amount: '1000000000.00', currency: 'IDR' },
        total: '1000000000.00 IDR',
        seen: ['"amount": "1000000000.00"'],
      },
      {
        // 1 ETH in wei, as a JSON number
        args: { to: 'payee-eth', amount: 1000000000000000000, currency: 'wei' },
        total: '1000000000000000000 wei',
        seen: ['"amount": 1000000000000000000'],
      },
    ];
    for (const c of cases) {
      const run = trustedRun();
      const res = call(run.token, 'wallet_send', c.args);
      const a = await pendingFor(run.runId);
      const field = (k: string) => a.ask?.fields.find((f) => f.key === k)?.value;
      expect(field('total')).toBe(c.total);
      if (c.args.payee) expect(field('merchant')).toBe(c.args.payee);
      const row = s.db.prepare('SELECT action, ask FROM approvals WHERE id = ?').get(a.id) as any;
      for (const v of c.seen) expect(field('arguments')).toContain(v);
      expect(row.action).toContain(String(c.args.amount));
      for (const stored of [row.action, row.ask, JSON.stringify(a)]) {
        expect(stored).not.toContain('4111 1111');
        expect(stored).not.toContain('•••• 0000');
      }
      s.approvals.decide(a.id, 'denied', ownerId);
      await res;
    }
  });

  it('a money card masks a total that is no amount, and never masks who gets the money (by key)', async () => {
    const run = trustedRun();
    const res = call(run.token, 'wallet_send', {
      to: '0012345678901237', // a Luhn-valid account number: still the recipient the owner must see
      payee: '5300012345678909',
      amount: 'card 4111111111111111',
      currency: 'USD',
    });
    const a = await pendingFor(run.runId);
    const field = (k: string) => a.ask?.fields.find((f) => f.key === k)?.value;
    expect(field('total')).toBe('card •••• 1111 USD');
    expect(field('merchant')).toBe('5300012345678909');
    expect(field('arguments')).toContain('"to": "0012345678901237"');
    expect(field('arguments')).toContain('"payee": "5300012345678909"');
    const row = s.db.prepare('SELECT action, ask FROM approvals WHERE id = ?').get(a.id) as any;
    for (const stored of [row.action, row.ask, JSON.stringify(a)])
      expect(stored).not.toContain('4111111111111111');
    s.approvals.decide(a.id, 'denied', ownerId);
    await res;
  });

  it('after three refusals of a class in one turn, further calls of it are refused without asking', async () => {
    const run = trustedRun();
    for (let n = 0; n < 3; n++) {
      const res = call(run.token, 'mail_send', { to: `p${n}@example.test`, body: 'hi' });
      const a = await pendingFor(run.runId);
      s.approvals.decide(a.id, 'denied', ownerId);
      expect((await res).isError).toBe(true);
    }
    const fourth = await call(run.token, 'mail_send', { to: 'p9@example.test', body: 'hi' });
    expect(fourth.text).toMatch(/refused 3 outbound-message actions/);
    expect(s.approvals.list('pending').filter((a) => a.runId === run.runId)).toHaveLength(0);
  });

  it('the agent cannot change the class: arguments naming another class change nothing', async () => {
    const run = trustedRun();
    const res = call(run.token, 'mail_send', {
      to: 'bo@example.test',
      body: 'x',
      actionClass: 'none',
      class: 'none',
    } as never);
    const a = await pendingFor(run.runId);
    expect(a.ask?.class).toBe('outbound-message');
    s.approvals.decide(a.id, 'denied', ownerId);
    await res;
    expect(callFingerprint('a', { x: 1, y: 2 })).toBe(callFingerprint('a', { y: 2, x: 1 }));
  });

  it('the owner can add a class (never remove the fixed three) and a channel cannot approve one', async () => {
    const got = await api('/api/v1/settings/always-ask');
    expect(got.json).toMatchObject({ fixed: ['money', 'outbound-message', 'delete'], extra: [] });
    expect(got.json.available).toEqual(['publish']);
    // W38: `delete` is fixed now; an owner PUT without it (or with only `publish`) never removes it
    const put = await api('/api/v1/settings/always-ask', { extra: ['publish', 'money'] }, 'PUT');
    expect(put.json).toMatchObject({ fixed: ['money', 'outbound-message', 'delete'], extra: ['publish'] });
    s.tools.add({
      name: 'files_wipe',
      title: 'Delete a file',
      description: 'deletes',
      input: z.object({ path: z.string() }),
      tier: 1,
      actionClass: 'delete',
      handler: async () => 'gone',
    });
    s.tools.add({
      name: 'site_publish',
      title: 'Publish a site',
      description: 'publishes',
      input: z.object({ slug: z.string() }),
      tier: 1,
      actionClass: 'publish',
      handler: async () => 'live',
    });
    const run = trustedRun();
    const res = call(run.token, 'site_publish', { slug: 'notes' });
    const a = await pendingFor(run.runId);
    expect(a.ask?.class).toBe('publish');
    expect(a.ask?.fields[0]).toEqual({ key: 'target', value: 'notes' });
    expect(a.ask?.fields.map((f) => f.key)).toEqual(['target', 'tool', 'arguments']);
    expect(s.approvals.forModules().decide(a.id, 'approved', ownerId)).toBeNull();
    expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).status).toBe(200);
    expect((await res).isError).toBe(false);
    // removing the extra again: publish runs at its own tier (1) without asking; delete still asks
    const cleared = await api('/api/v1/settings/always-ask', { extra: [] }, 'PUT');
    expect(cleared.json.fixed).toContain('delete');
    const run2 = trustedRun();
    expect((await call(run2.token, 'site_publish', { slug: 'x' })).isError).toBe(false);
    const run3 = trustedRun();
    const wipe = call(run3.token, 'files_wipe', { path: '../other-agent/notes.md' });
    const d = await pendingFor(run3.runId);
    expect(d.ask?.class).toBe('delete');
    expect(d.ask?.fields.map((f) => f.key)).toEqual(['target', 'where', 'count', 'tool', 'arguments']);
    s.approvals.decide(d.id, 'denied', ownerId);
    expect((await wipe).isError).toBe(true);
    // members cannot read or change it
    const saved = token;
    token = 'not-a-session';
    expect((await api('/api/v1/settings/always-ask')).status).toBe(401);
    token = saved;
  });
});
