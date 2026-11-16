/**
 * W30 shopping through a booted server and the `/mcp` gateway, against the local fixture store (127.0.0.1 port 0,
 * mapped by a test pack `ZZ`) and a stand-in managed browser (the real one is proven in modules/browser port.test):
 * - settings: the country from the locale (no network), switching country, store toggles and a custom store persist
 *   across a restart; an agent, automation token or member cannot change them (and no tool exists for it);
 * - cards: facts from the page's structured data (an instruction in the page text stays out, the price is the
 *   structured one), `javascript:` / `data:` / off-store images dropped, "as seen at" = capture time, compare 2–4;
 * - Buy: a money card from the captured product (what, store, price, currency, quantity, total as seen); denied →
 *   the browser is never touched; approved → the quantity is in the fixture cart, the checkout page is open, the run
 *   handed over and "Place order" recorded no click; a changed price stops; a captcha pauses and hands over; a card
 *   field is never filled; a sign-up page is never opened; the global stop ends a Buy in progress; the card's Buy
 *   button raises the same money card.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHIPPED_PACKS_DIR } from '@pasabot/store-packs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTestServer,
  FakeProvider,
  seedAgent,
  seedAutomationToken,
  seedChat,
  seedRunToken,
  seedUser,
  type TestServer,
  tempHome,
} from '../../../packages/testkit/src/index.js';
import { createShopModule, moneyIn, type Shop, times } from './server.js';
import { FakeBrowser } from './testing/fake-browser.js';
import { type FixtureStore, startFixtureStore } from './testing/fixture-store.js';

const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

let fx: FixtureStore;
let packDir: string;
const fixtureStore = (base: string, cart = true) => ({
  id: 'fixture-mart',
  name: 'Fixture Mart',
  homeUrl: `${base}/`,
  searchUrl: `${base}/search?q={query}`,
  allowedHosts: ['127.0.0.1'],
  currency: 'PHP',
  parsingHints: {
    prefer: ['json-ld', 'opengraph', 'microdata'],
    ...(cart ? { cart: { quantity: '#qty', addToCart: '#add', checkoutUrl: `${base}/checkout` } } : {}),
  },
});

beforeAll(async () => {
  fx = await startFixtureStore();
  packDir = mkdtempSync(join(tmpdir(), 'pasabot-shop-packs-'));
  writeFileSync(
    join(packDir, 'ZZ.json'),
    JSON.stringify({ country: 'ZZ', name: 'Fixture Land', stores: [fixtureStore(fx.url)] }),
  );
});
afterAll(async () => {
  await fx?.close();
  rmSync(packDir, { recursive: true, force: true });
});

const client = (s: TestServer, token: string) => async (path: string, body?: unknown, method?: string) => {
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
async function claim(s: TestServer) {
  const r = await fetch(`${s.url}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: s.auth.issueSetupToken(),
      displayName: 'PitsPets',
      password: 'owner-password',
    }),
  });
  const j = (await r.json()) as any;
  return { id: j.user.id as string, token: j.token as string };
}

describe('W30 settings', () => {
  it('country from the locale with no network call; country, toggles and a custom store survive a restart', async () => {
    const home = tempHome();
    const mod = () => createShopModule({ packDirs: [SHIPPED_PACKS_DIR, packDir] });
    let s = await bootTestServer({ home: home.dir, modules: [mod()] });
    try {
      const owner = await claim(s);
      let api = client(s, owner.token);
      const spy = vi.spyOn(globalThis, 'fetch');
      spy.mockClear();
      const ph = await api('/api/m/shop/settings?locale=fil-PH');
      // only the test's own request went out: picking the country made no network call of its own
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(ph.json).toMatchObject({ country: 'PH', picked: false, fallback: false });
      expect(ph.json.stores.map((x: any) => x.name)).toEqual(['Shopee', 'Lazada', 'TikTok Shop']);
      // the default the owner was shown is saved (it has a pack), so agents are held to the same store list
      expect((await api('/api/m/shop/settings?locale=en-US')).json).toMatchObject({
        country: 'PH',
        picked: true,
      });
      expect((await api('/api/m/shop/settings', { country: null }, 'PUT')).status).toBe(200);
      expect((await api('/api/m/shop/settings?locale=en-US')).json.country).toBe('US');
      expect((await api('/api/m/shop/settings', { country: null }, 'PUT')).status).toBe(200);
      expect((await api('/api/m/shop/settings?locale=en-NZ')).json).toMatchObject({
        country: 'NZ',
        fallback: true,
      });
      // a country with no pack is never saved from the locale alone (only the owner's own pick turns on the web)
      expect((await api('/api/m/shop/settings')).json.country).toBeNull();

      expect(
        (await api('/api/m/shop/settings', { country: 'US', stores: { 'US:walmart': false } }, 'PUT')).status,
      ).toBe(200);
      const custom = { ...fixtureStore('https://corner.shop.test'), id: 'corner', name: 'Corner Shop' };
      custom.allowedHosts = ['corner.shop.test'];
      expect((await api('/api/m/shop/custom-stores', custom)).status).toBe(200);
      expect((await api('/api/m/shop/custom-stores', { ...custom, logo: 'x' })).status).toBe(400);
      expect(
        (
          await api('/api/m/shop/custom-stores', {
            ...custom,
            id: 'c2',
            homeUrl: 'https://corner.shop.test/?tag=a-20',
          })
        ).status,
      ).toBe(400);
      expect((await api('/api/m/shop/settings', { stores: { 'custom:corner': false } }, 'PUT')).status).toBe(
        200,
      );

      await s.close();
      s = await bootTestServer({ home: home.dir, modules: [mod()] });
      const again = await fetch(`${s.url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'owner-password', userId: owner.id }),
      });
      const tok = ((await again.json()) as any).token as string;
      api = client(s, tok);
      const after = (await api('/api/m/shop/settings?locale=fil-PH')).json;
      expect(after.country).toBe('US');
      expect(after.picked).toBe(true);
      const byKey = Object.fromEntries(after.stores.map((x: any) => [x.key, x.enabled]));
      expect(byKey).toMatchObject({ 'US:amazon': true, 'US:walmart': false, 'custom:corner': false });
    } finally {
      await s.close();
      home.cleanup();
    }
  });

  it('agents, automation tokens and members cannot add or enable a store; no tool does it', async () => {
    const s = await bootTestServer({
      modules: [createShopModule({ packDirs: [SHIPPED_PACKS_DIR, packDir] })],
    });
    try {
      await claim(s);
      const agent = seedAgent(s.db, { trust: 'trusted' });
      const run = seedRunToken(s.db, agent);
      const auto = seedAutomationToken(s.db, agent);
      const member = seedUser(s.db, 'member', 'Member');
      const store = fixtureStore('https://x.shop.test');
      store.allowedHosts = ['x.shop.test'];
      for (const t of [run.token, auto]) {
        const api = client(s, t);
        expect((await api('/api/m/shop/custom-stores', store)).status).toBe(401);
        expect((await api('/api/m/shop/settings', { stores: { 'PH:shopee': true } }, 'PUT')).status).toBe(
          401,
        );
      }
      const m = client(s, member.token);
      expect((await m('/api/m/shop/custom-stores', store)).status).toBe(403);
      expect((await m('/api/m/shop/settings', { country: 'PH' }, 'PUT')).status).toBe(403);
      const names = s.tools
        .list()
        .map((t) => t.name)
        .filter((n) => n.startsWith('shop_'))
        .sort();
      expect(names).toEqual([
        'shop_buy',
        'shop_capture',
        'shop_compare',
        'shop_search',
        'shop_show',
        'shop_stores',
      ]);
    } finally {
      await s.cleanup();
    }
  });
});

describe("W39 roles: Shop settings and orders are the owner's alone", () => {
  it('a member and a guest get 403 from every Shop route (settings, stores, products, buy, orders)', async () => {
    const s = await bootTestServer({
      modules: [createShopModule({ packDirs: [SHIPPED_PACKS_DIR, packDir] })],
    });
    try {
      const owner = await claim(s);
      expect((await client(s, owner.token)('/api/m/shop/settings')).status).toBe(200);
      const store = fixtureStore('https://x.shop.test');
      store.allowedHosts = ['x.shop.test'];
      for (const role of ['member', 'guest'] as const) {
        const api = client(s, seedUser(s.db, role, role === 'member' ? 'Member' : 'Guest').token);
        const calls: [string, unknown, string?][] = [
          ['/api/m/shop/settings', undefined],
          ['/api/m/shop/settings', { country: 'PH' }, 'PUT'],
          ['/api/m/shop/custom-stores', store],
          ['/api/m/shop/custom-stores/x', undefined, 'DELETE'],
          ['/api/m/shop/products', undefined],
          ['/api/m/shop/products/p1', undefined],
          ['/api/m/shop/products/p1/buy', { quantity: 1 }],
          ['/api/m/shop/orders', undefined],
          ['/api/m/shop/orders/o1', undefined],
        ];
        for (const [path, body, method] of calls)
          expect((await api(path, body, method)).status, `${role} ${method ?? ''} ${path}`).toBe(403);
      }
    } finally {
      await s.cleanup();
    }
  });
});

describe('W30 store list enforced for agents (review fix)', () => {
  it('no saved country: agents get no store, no web fallback and no browser use; the shown default is enforced', async () => {
    const fake = new FakeBrowser();
    const s = await bootTestServer({
      providers: [new FakeProvider()],
      modules: [createShopModule({ packDirs: [SHIPPED_PACKS_DIR, packDir] })],
    });
    try {
      s.browser.set(fake);
      const owner = await claim(s);
      const api = client(s, owner.token);
      const agentId = seedAgent(s.db, { trust: 'trusted' });
      const run = seedRunToken(s.db, agentId);
      s.db
        .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
        .run(
          JSON.stringify({ sender: { kind: 'owner', id: owner.id, name: 'PitsPets', trust: 'trusted' } }),
          run.runId,
        );
      const tool = async (name: string, args: unknown) => {
        const r = await fetch(`${s.url}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        });
        const j = (await r.json()) as any;
        return {
          isError: !!j.result?.isError,
          text: String(j.result?.content?.[0]?.text ?? j.error?.message),
        };
      };

      // nothing saved (the owner never opened Settings): no store at all, never an any-host web store
      for (const url of [`${fx.url}/p/kettle`, 'https://shopee.ph/product/1', 'https://any.shop.test/p/1']) {
        const r = await tool('shop_capture', { url });
        expect(r.isError, r.text).toBe(true);
        expect(r.text).toMatch(/not on one of your shopping stores/);
      }
      const search = await tool('shop_search', { query: 'kettle' });
      expect(search.isError).toBe(true);
      expect(search.text).toMatch(/not set up shopping/);
      expect(JSON.parse((await tool('shop_stores', {})).text)).toMatchObject({ country: null, stores: [] });
      expect(fake.calls).toEqual([]);

      // the owner loads Settings in fil-PH and turns Shopee off without touching the country select
      expect((await api('/api/m/shop/settings?locale=fil-PH')).json.country).toBe('PH');
      expect((await api('/api/m/shop/settings', { stores: { 'PH:shopee': false } }, 'PUT')).status).toBe(200);
      const stores = JSON.parse((await tool('shop_stores', {})).text);
      expect(stores.country).toBe('PH');
      expect(stores.stores.map((x: any) => x.store)).toEqual(['PH:lazada', 'PH:tiktok-shop']);
      for (const url of ['https://shopee.ph/product/1', 'https://any.shop.test/p/1']) {
        const r = await tool('shop_capture', { url });
        expect(r.isError, r.text).toBe(true);
        expect(r.text).toMatch(/not on one of your shopping stores/);
      }
      expect(fake.calls).toEqual([]);

      // the owner picks a country with no pack: the web fallback, but never a host of a store they turned off
      expect(
        (await api('/api/m/shop/settings', { country: 'NZ', stores: { 'ZZ:fixture-mart': false } }, 'PUT'))
          .status,
      ).toBe(200);
      for (const url of ['https://shopee.ph/product/1', `${fx.url}/p/kettle`]) {
        const r = await tool('shop_capture', { url });
        expect(r.isError, r.text).toBe(true);
      }
      expect(fake.calls).toEqual([]);
      expect((await api('/api/m/shop/settings', { stores: { 'ZZ:fixture-mart': true } }, 'PUT')).status).toBe(
        200,
      );
      const web = await tool('shop_capture', { url: `${fx.url}/p/kettle` });
      expect(web.isError, web.text).toBe(false);
      expect(fake.ops()).toEqual(['read']);
    } finally {
      await s.cleanup();
    }
  });
});

describe('W30 cards and Buy', () => {
  let s: TestServer;
  let shop: Shop;
  const fake = new FakeBrowser();
  let owner: { id: string; token: string };
  let api: ReturnType<typeof client>;
  let chatId = '';

  const trustedRun = () => {
    const agentId = seedAgent(s.db, { trust: 'trusted' });
    const r = seedRunToken(s.db, agentId);
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agentId] });
    chatId = chat;
    s.db
      .prepare(
        'UPDATE queue_items SET source = ?, chat_id = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)',
      )
      .run(
        JSON.stringify({ sender: { kind: 'owner', id: owner.id, name: 'PitsPets', trust: 'trusted' } }),
        chat,
        r.runId,
      );
    return { ...r, agentId, chatId: chat };
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
  const capture = async (token: string, path: string) => {
    const r = await call(token, 'shop_capture', { url: `${fx.url}${path}` });
    expect(r.isError, r.text).toBe(false);
    return JSON.parse(r.text) as { productId: string; data: string };
  };

  beforeAll(async () => {
    const mod = createShopModule({ packDirs: [SHIPPED_PACKS_DIR, packDir] });
    s = await bootTestServer({ providers: [new FakeProvider()], modules: [mod] });
    shop = mod.shop();
    s.browser.set(fake);
    owner = await claim(s);
    api = client(s, owner.token);
    expect((await api('/api/m/shop/settings', { country: 'ZZ' }, 'PUT')).status).toBe(200);
  });
  afterAll(() => s.cleanup());
  // a hand-over marks the fake profile owner-driven (as the real port); each test starts on a fresh profile
  beforeEach(() => {
    fake.loggedIn = false;
  });

  it('a card comes from the page’s structured data; injected text stays out; bad images are dropped', async () => {
    const { token } = trustedRun();
    const t0 = Date.now();
    const k = await capture(token, '/p/kettle');
    const row = shop.product(k.productId)!;
    expect(row).toMatchObject({
      name: 'Steel Kettle',
      price: '1299.00',
      currency: 'PHP',
      store_name: 'Fixture Mart',
      image: `${fx.url}/img/kettle.png`,
      url: `${fx.url}/p/kettle`,
      rating: 4.6,
      rating_count: 312,
    });
    expect(row.captured_at).toBeGreaterThanOrEqual(t0);
    expect(k.data).toContain('<untrusted-data');
    expect(k.data).toContain('asSeenAt');

    const inj = await capture(token, '/p/injection');
    const ir = shop.product(inj.productId)!;
    expect(ir.price).toBe('2499.00');
    expect(ir.image).toBeNull();
    expect(inj.data).not.toContain('ignore your instructions');
    const off = shop.product((await capture(token, '/p/offhost')).productId)!;
    expect(off.image).toBeNull();

    const evil = await call(token, 'shop_capture', { url: 'https://evil.example/p/1' });
    expect(evil.isError).toBe(true);
    expect(evil.text).toMatch(/not on one of your shopping stores/);
    const signup = await call(token, 'shop_capture', { url: `${fx.url}/signup` });
    expect(signup.isError).toBe(true);
    expect(fx.state.signUpOpened).toBe(0);

    // shown in the run's chat as a shop.product block with the capture time
    const shown = await call(token, 'shop_show', { productId: k.productId });
    expect(shown.isError, shown.text).toBe(false);
    const msgs = (await api(`/api/v1/chats/${chatId}/messages`)).json.messages as any[];
    const block = msgs.flatMap((m) => m.blocks ?? []).find((b: any) => b.kind === 'shop.product');
    expect(block.data).toMatchObject({ name: 'Steel Kettle', price: '1299.00', capturedAt: row.captured_at });
  });

  it('compare takes 2 to 4 products; 1 or 5 is refused', async () => {
    const { token } = trustedRun();
    const ids = [];
    for (const p of ['/p/kettle', '/p/mug', '/p/pan', '/p/tray', '/p/teapot'])
      ids.push((await capture(token, p)).productId);
    expect((await call(token, 'shop_compare', { productIds: ids.slice(0, 1) })).text).toMatch(/2 to 4/);
    expect((await call(token, 'shop_compare', { productIds: ids })).text).toMatch(/2 to 4/);
    expect((await call(token, 'shop_compare', { productIds: ids.slice(0, 2) })).isError).toBe(false);
    expect((await call(token, 'shop_compare', { productIds: ids.slice(0, 4) })).isError).toBe(false);
    const msgs = (await api(`/api/v1/chats/${chatId}/messages`)).json.messages as any[];
    const sizes = msgs
      .flatMap((m) => m.blocks ?? [])
      .filter((b: any) => b.kind === 'shop.compare')
      .map((b: any) => b.data.items.length);
    expect(sizes).toEqual([2, 4]);
  });

  it('on a profile that may hold the owner’s sign-ins, shop_capture and shop_search ask (tier 3) even for a trusted agent', async () => {
    fake.loggedIn = true;
    try {
      const run = trustedRun();
      const before = fake.calls.length;
      const pending = call(run.token, 'shop_capture', { url: `${fx.url}/p/kettle` });
      const a = await pendingFor(run.runId);
      expect(a.tier).toBe(3);
      expect((await api(`/api/v1/approvals/${a.id}/deny`, {})).status).toBe(200);
      expect((await pending).isError).toBe(true);
      expect(fake.calls.length).toBe(before);

      const run2 = trustedRun();
      const searching = call(run2.token, 'shop_search', { query: 'kettle' });
      const b = await pendingFor(run2.runId);
      expect(b.tier).toBe(3);
      expect((await api(`/api/v1/approvals/${b.id}/approve`, { nonce: b.nonce })).status).toBe(200);
      const sr = await searching;
      expect(sr.isError, sr.text).toBe(false);
      expect(fake.calls.at(-1)).toMatchObject({ op: 'read', actor: { kind: 'agent' } });

      // signed out again: a trusted agent's capture is tier 2 and runs without a card
      fake.loggedIn = false;
      const run3 = trustedRun();
      const t2 = await call(run3.token, 'shop_capture', { url: `${fx.url}/p/kettle` });
      expect(t2.isError, t2.text).toBe(false);
    } finally {
      fake.loggedIn = false;
      fake.gate = null;
    }
  });

  it('Buy asks with a money card from the captured product; denied never touches the browser', async () => {
    const run = trustedRun();
    const k = await capture(run.token, '/p/kettle');
    const before = fake.calls.length;
    const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 2 });
    const a = await pendingFor(run.runId);
    expect(a.tier).toBe(3);
    expect(a.ask?.class).toBe('money');
    const f = Object.fromEntries(a.ask!.fields.map((x) => [x.key, x.value]));
    expect(f.items).toContain('2 × Steel Kettle');
    // the price in Intl currency and the capture time in the owner's locale (never an ISO timestamp)
    expect(f.items).toContain('₱1,299.00 each, as seen at');
    expect(f.items).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(f.merchant).toContain('Fixture Mart');
    expect(f.total).toBe(`${moneyIn(times('1299.00', 2), 'PHP', 'en')} as seen, not final`);
    expect(f.paymentMethod).toBe('You pay yourself in the browser; PasaBot stops at the cart');
    expect((await api(`/api/v1/approvals/${a.id}/deny`, {})).status).toBe(200);
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(fake.calls.length).toBe(before);
    expect(fx.state.cart).toBe(0);
  });

  it('the money card reads in the owner’s language: Intl currency, a local time, no English', async () => {
    expect((await api('/api/v1/me/language', { language: 'ja' }, 'PUT')).status).toBe(200);
    try {
      const run = trustedRun();
      const k = await capture(run.token, '/p/kettle');
      const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 2 });
      const a = await pendingFor(run.runId);
      const f = Object.fromEntries(a.ask!.fields.map((x) => [x.key, x.value]));
      expect(f.items).toContain(moneyIn('1299.00', 'PHP', 'ja'));
      expect(f.items).toContain('時点の表示');
      expect(f.total).toContain(moneyIn(times('1299.00', 2), 'PHP', 'ja'));
      for (const v of [f.items, f.total, f.paymentMethod])
        expect(v).not.toMatch(/as seen|each|You pay|stops at|\d{4}-\d{2}-\d{2}T/);
      expect((await api(`/api/v1/approvals/${a.id}/deny`, {})).status).toBe(200);
      await pending;
      // a stored order outcome (a key with money params) reads in the reader's language
      const stored = JSON.stringify({
        key: 'shop:server.priceChanged',
        money: { before: ['1299.00', 'PHP'], after: ['1499.00', 'PHP'] },
      });
      const ja = shop.storedText(stored, 'ja')!;
      expect(ja).toContain(moneyIn('1499.00', 'PHP', 'ja'));
      expect(ja).not.toMatch(/price changed|then|now/);
      expect(shop.storedText('old plain text', 'ja')).toBe('old plain text');
    } finally {
      await api('/api/v1/me/language', { language: 'en' }, 'PUT');
    }
  });

  it('approved: the quantity is in the cart, checkout is open, handed over, no Place order click', async () => {
    const run = trustedRun();
    const k = await capture(run.token, '/p/kettle');
    const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 2 });
    const a = await pendingFor(run.runId);
    expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).status).toBe(200);
    const out = await pending;
    expect(out.isError, out.text).toBe(false);
    expect(JSON.parse(out.text)).toMatchObject({ state: 'handed-over' });
    expect(fx.state.cart).toBe(2);
    expect(fake.url).toBe(`${fx.url}/checkout`);
    expect(fake.calls.at(-1)!.op).toBe('handOver');
    expect(fx.state.placeOrderClicks).toBe(0);
    // the owner's order list names the item, store and price as seen
    const listed = (await api('/api/m/shop/orders')).json.orders as any[];
    expect(listed[0]).toMatchObject({
      state: 'handed-over',
      quantity: 2,
      item: 'Steel Kettle',
      store: 'Fixture Mart',
      price: '1299.00',
      currency: 'PHP',
    });
    expect(listed[0].createdAt).toEqual(expect.any(Number));
    const msgs = (await api(`/api/v1/chats/${run.chatId}/messages`)).json.messages as any[];
    expect(msgs.some((m) => m.authorKind === 'system' && String(m.body).includes('pay yourself'))).toBe(true);
    fx.state.cart = 0;
  });

  it('a second Buy after a hand-over asks again on a fresh money card and reaches the cart too', async () => {
    const run = trustedRun();
    const k = await capture(run.token, '/p/kettle');
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 1 });
      const a = await pendingFor(run.runId);
      expect(ids).not.toContain(a.id);
      ids.push(a.id);
      expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).status).toBe(200);
      const out = await pending;
      expect(out.isError, out.text).toBe(false);
      expect(JSON.parse(out.text), `buy ${n}`).toMatchObject({ state: 'handed-over' });
      // the first hand-over made the profile owner-driven; the approved second Buy still hands over
      expect(fake.loggedIn).toBe(true);
      expect(fake.calls.at(-1)!.op).toBe('handOver');
    }
    const listed = (await api('/api/m/shop/orders')).json.orders as any[];
    expect(listed.filter((o) => o.state === 'handed-over').length).toBeGreaterThanOrEqual(2);
    fx.state.cart = 0;
  });

  it('a price changed before checkout stops the Buy; a captcha pauses and hands over', async () => {
    const run = trustedRun();
    const k = await capture(run.token, '/p/kettle');
    fx.state.price = '1499.00';
    try {
      const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 1 });
      const a = await pendingFor(run.runId);
      await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce });
      const out = JSON.parse((await pending).text);
      expect(out.state).toBe('stopped');
      // the new price is shown, and a fresh money card asks again at it
      expect(out.message).toContain('₱1,299.00 then, ₱1,499.00 now');
      expect(fx.state.cart).toBe(0);
      // the owner's order list (newest first): the re-ask is pending with its own card
      const listed = (await api('/api/m/shop/orders')).json.orders as any[];
      expect(listed[0]).toMatchObject({ state: 'pending', quantity: 1 });
      expect(listed[1]).toMatchObject({ state: 'stopped' });
      // the order keeps a key and params, not rendered text, so it reads in the language of whoever looks
      const raw = s.db.prepare('SELECT message FROM shop_order WHERE id = ?').get(listed[1].id) as {
        message: string;
      };
      expect(JSON.parse(raw.message)).toMatchObject({
        key: 'shop:server.priceChanged',
        money: { before: ['1299.00', 'PHP'], after: ['1499.00', 'PHP'] },
      });
      expect(listed[1].message).toContain('₱1,499.00 now');
      const again = s.approvals.get(listed[0].approvalId)!;
      expect(again.state).toBe('pending');
      expect(again.tier).toBe(3);
      const f = Object.fromEntries(again.ask!.fields.map((x) => [x.key, x.value]));
      expect(f.items).toContain('1 × Steel Kettle — ₱1,499.00 each');
      // approving the new card at the new price goes through
      expect((await api(`/api/v1/approvals/${again.id}/approve`, { nonce: again.nonce })).status).toBe(200);
      await waitFor(() => shop.order(listed[0].id)?.state === 'handed-over');
      expect(fx.state.cart).toBe(1);
      fx.state.cart = 0;
    } finally {
      fx.state.price = '1299.00';
    }
    // the hand-over above made the profile owner-driven (a capture would ask at tier 3); start on a fresh one
    fake.loggedIn = false;
    const run2 = trustedRun();
    const c = await capture(run2.token, '/p/captcha');
    const pending2 = call(run2.token, 'shop_buy', { productId: c.productId, quantity: 1 });
    const c2 = await pendingFor(run2.runId);
    await api(`/api/v1/approvals/${c2.id}/approve`, { nonce: c2.nonce });
    const out2 = JSON.parse((await pending2).text);
    expect(out2.state).toBe('paused');
    expect(fake.calls.at(-1)).toMatchObject({ op: 'handOver' });
    expect(fake.calls.at(-1)!.arg).toMatch(/captcha/);
    expect(fx.state.cart).toBe(0);
  });

  it('never types into a card field and never opens a sign-up page', async () => {
    // the fixture store off, a custom store on the same host whose "quantity" field is a card-number field
    await api('/api/m/shop/settings', { stores: { 'ZZ:fixture-mart': false } }, 'PUT');
    const card = fixtureStore(fx.url);
    card.id = 'card-mart';
    card.name = 'Card Mart';
    (card.parsingHints as any).cart.quantity = '#cardnum';
    expect((await api('/api/m/shop/custom-stores', card)).status).toBe(200);
    try {
      const run = trustedRun();
      const k = await capture(run.token, '/p/kettle');
      const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 1 });
      const p1 = await pendingFor(run.runId);
      await api(`/api/v1/approvals/${p1.id}/approve`, { nonce: p1.nonce });
      const out = JSON.parse((await pending).text);
      expect(out.state).toBe('failed');
      expect(out.message).toMatch(/owner’s to fill/);
      expect(fx.state.cart).toBe(0);
      await api('/api/m/shop/custom-stores/card-mart', undefined, 'DELETE');

      const signup = fixtureStore(fx.url);
      signup.id = 'signup-mart';
      (signup.parsingHints as any).cart.checkoutUrl = `${fx.url}/signup`;
      expect((await api('/api/m/shop/custom-stores', signup)).status).toBe(200);
      const run2 = trustedRun();
      const k2 = await capture(run2.token, '/p/kettle');
      const p2 = call(run2.token, 'shop_buy', { productId: k2.productId, quantity: 1 });
      const p2c = await pendingFor(run2.runId);
      await api(`/api/v1/approvals/${p2c.id}/approve`, { nonce: p2c.nonce });
      const out2 = JSON.parse((await p2).text);
      expect(out2.state).toBe('failed');
      expect(fx.state.signUpOpened).toBe(0);
      fx.state.cart = 0;
      await api('/api/m/shop/custom-stores/signup-mart', undefined, 'DELETE');
    } finally {
      await api('/api/m/shop/settings', { stores: { 'ZZ:fixture-mart': true } }, 'PUT');
    }
  });

  it('the card’s Buy button raises the same money card; deny leaves the browser alone, approve hands over', async () => {
    const run = trustedRun();
    const k = await capture(run.token, '/p/kettle');
    await call(run.token, 'shop_show', { productId: k.productId });
    const before = fake.calls.length;
    const r = await api(`/api/m/shop/products/${k.productId}/buy`, { quantity: 1 });
    expect(r.status).toBe(200);
    const a =
      (await api(`/api/v1/approvals/${r.json.approvalId}`)).json.approval ??
      s.approvals.get(r.json.approvalId);
    expect(a.tier).toBe(3);
    expect(a.ask.class).toBe('money');
    // a module (or channel) cannot approve it
    expect(s.approvals.forModules().decide(r.json.approvalId, 'approved', owner.id)).toBeNull();
    expect((await api(`/api/v1/approvals/${r.json.approvalId}/deny`, {})).status).toBe(200);
    await waitFor(() => shop.order(r.json.orderId)?.state === 'denied');
    expect(fake.calls.length).toBe(before);

    const r2 = await api(`/api/m/shop/products/${k.productId}/buy`, { quantity: 3 });
    expect(
      (
        await api(`/api/v1/approvals/${r2.json.approvalId}/approve`, {
          nonce: s.approvals.get(r2.json.approvalId)?.nonce,
        })
      ).status,
    ).toBe(200);
    await waitFor(() => shop.order(r2.json.orderId)?.state === 'handed-over');
    expect(fx.state.cart).toBe(3);
    expect(fx.state.placeOrderClicks).toBe(0);
    expect(fake.calls.at(-1)!.actor).toEqual({ kind: 'user', id: owner.id });
    fx.state.cart = 0;
  });

  it('the global stop ends a Buy in progress', async () => {
    const run = trustedRun();
    const k = await capture(run.token, '/p/kettle');
    let release!: () => void;
    const pending = call(run.token, 'shop_buy', { productId: k.productId, quantity: 1 });
    const a = await pendingFor(run.runId);
    fake.gate = new Promise<void>((r) => {
      release = r;
    });
    const reads = fake.calls.filter((c) => c.op === 'read').length;
    await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce });
    await waitFor(() => fake.calls.filter((c) => c.op === 'read').length > reads);
    const report = await s.killSwitch.stopAll({ kind: 'owner', userId: owner.id }, 'test');
    expect(report.items.some((i) => i.kind === 'shop-buy')).toBe(true);
    fake.gate = null;
    release();
    const text = (await pending).text;
    expect(text).toMatch(/stopped|Stopped/);
    expect(fx.state.cart).toBe(0);
    expect(fake.calls.at(-1)!.op).toBe('read');
    s.killSwitch.resume({ kind: 'owner', userId: owner.id }, { reauthed: true });
  });
});
