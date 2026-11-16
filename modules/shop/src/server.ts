/**
 * W30 Shopping: product cards, compare and a Buy that stops at the cart.
 *
 * - Store packs (`@pasabot/store-packs`, data only) give each country's stores; the owner picks the country (default
 *   from the locale/region, never a network call), turns stores on or off and adds custom stores. Only the owner
 *   session changes these; there is no tool for it.
 * - Product facts are captured by the server from the page the managed browser read (`ModuleHost.browser`),
 *   structured data first, and stored with their capture time; tools and cards name a captured product id, never an
 *   agent-typed price or link. Page data is untrusted: plain text, handed to the agent inside a labelled untrusted
 *   block, links and images only on the store's `allowedHosts`.
 * - Buy (`shop_buy`, and the card's Buy button) is a money action: tier 3, always asks, no "always allow", its card
 *   built from the captured product. After approval the server (not the agent) opens the approved product page,
 *   re-reads it (a changed item or price stops), sets the approved quantity, adds it to the cart, opens the
 *   cart/checkout page and hands the live view to the owner, who pays. It never presses pay / place order, never
 *   types card, bank, password or one-time-code fields, never solves a captcha (it hands over), never opens a
 *   sign-up page. The global stop ends a Buy in progress.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ApprovalTier,
  type AuthedCtx,
  asSystem,
  type BrowserPageData,
  type BrowserPortActor,
  defineModule,
  HttpError,
  type ModuleHost,
  type PasaBotModule,
  renderUntrustedBlock,
  type ToolCtx,
  ulid,
} from '@pasabot/core';
import { intlLocale } from '@pasabot/i18n';
import type { ApprovalAsk, ApprovalDTO } from '@pasabot/protocol';
import {
  fillSearch,
  loadPacks,
  packFor,
  SHIPPED_PACKS_DIR,
  type Store,
  type StorePack,
  storeSchema,
  urlAllowed,
} from '@pasabot/store-packs';
import { z } from 'zod';
import { isSignUpUrl, type ProductFacts, parseProduct, plainText } from './capture.js';

const here = dirname(fileURLToPath(import.meta.url));

declare module '@pasabot/protocol' {
  interface EventMap {
    /** a Buy changed state (topic `owner`) */
    'shop.order': { orderId: string; state: string };
  }
}

/** generic web search for a country without a pack (cards only where a page gives structured product data) */
const WEB_SEARCH = 'https://duckduckgo.com/?q={query}';
const WEB_SEARCH_HOSTS = ['duckduckgo.com', '*.duckduckgo.com'];

export interface ShopOptions {
  /** where store packs are discovered (default: the shipped packs) */
  packDirs?: string[];
}

interface ProductRow {
  id: string;
  store_key: string;
  store_name: string;
  hosts: string;
  name: string;
  price: string;
  currency: string;
  image: string | null;
  url: string;
  rating: number | null;
  rating_count: number | null;
  captured_at: number;
  agent_id: string | null;
  run_id: string | null;
  chat_id: string | null;
}
interface OrderRow {
  id: string;
  product_id: string;
  quantity: number;
  state: string;
  message: string | null;
  approval_id: string | null;
  via: string;
  run_id: string | null;
  chat_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * an order as the owner's page sees it (never the run's internals), with the product as it was captured: its
 * name, store and the price as seen (null when the product is no longer saved)
 */
const orderView = (r: OrderRow, p: ProductRow | undefined, message: string | null) => ({
  id: r.id,
  productId: r.product_id,
  state: r.state,
  message,
  quantity: r.quantity,
  approvalId: r.approval_id,
  via: r.via,
  item: p?.name ?? null,
  store: p?.store_name ?? null,
  price: p?.price ?? null,
  currency: p?.currency ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** what a product card / compare column carries: server-captured facts only */
export const productBlockSchema = z.object({
  productId: z.string(),
  name: z.string(),
  price: z.string(),
  currency: z.string(),
  store: z.string(),
  hosts: z.array(z.string()),
  image: z.string().nullable(),
  url: z.string(),
  rating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  capturedAt: z.number(),
});
export type ProductBlock = z.infer<typeof productBlockSchema>;

export interface StoreEntry {
  key: string;
  store: Store;
  custom: boolean;
  enabled: boolean;
}

function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return p.userId;
}

export const quantitySchema = z.number().int().min(1).max(99);
const settingsBody = z
  .object({
    country: z
      .string()
      .length(2)
      .refine((c) => [...c].every((x) => x >= 'A' && x <= 'Z'))
      .nullable()
      .optional(),
    stores: z.record(z.string().max(80), z.boolean()).optional(),
  })
  .strict();

/** a fixed-format money string (logs and the English approval summary; never converted) */
const money = (amount: string, currency: string) => `${currency} ${amount}`;
/** an amount in `lng` with `Intl` currency formatting (exact decimal string, never converted); fixed format fallback */
export const moneyIn = (amount: string, currency: string, lng: string) => {
  try {
    return new Intl.NumberFormat(intlLocale(lng), { style: 'currency', currency }).format(
      amount as unknown as number,
    );
  } catch {
    return money(amount, currency);
  }
};
/** a capture time in `lng` (the same style as the product card) */
const timeIn = (at: number, lng: string) =>
  new Date(at).toLocaleString(intlLocale(lng), { dateStyle: 'medium', timeStyle: 'short' });
/**
 * An order's outcome as stored: a locale key and its params (never rendered text), so it reads in the language of
 * whoever looks. `money` params are `[amount, currency]`, formatted with `Intl` in that language.
 */
export interface OrderMsg {
  key: string;
  params?: Record<string, string | number>;
  money?: Record<string, [string, string]>;
}
/** the Buy tool's English title (its locale key is `shop:tools.shop_buy`) */
const BUY_TITLE = 'Bring a product to the cart';
/** price × quantity in exact decimal (no floating point) */
export const times = (price: string, q: number) => {
  const [w = '0', f = ''] = price.split('.');
  const units = BigInt(`${w}${f}`) * BigInt(q);
  if (!f.length) return units.toString();
  const s = units.toString().padStart(f.length + 1, '0');
  return `${s.slice(0, -f.length)}.${s.slice(-f.length)}`;
};

export class Shop {
  readonly packs: Map<string, StorePack>;
  readonly packErrors: { file: string; error: string }[];
  /** Buy flows in progress, so the global stop can end them */
  private readonly running = new Map<string, AbortController>();

  constructor(
    readonly app: ModuleHost,
    o: ShopOptions,
  ) {
    const loaded = loadPacks(o.packDirs ?? [SHIPPED_PACKS_DIR]);
    this.packs = loaded.packs;
    this.packErrors = loaded.errors;
    for (const e of loaded.errors) app.log.warn('store pack skipped', e);
  }

  // ---------- settings ----------
  private settingsRow() {
    return this.app.raw.prepare('SELECT country, disabled FROM shop_settings WHERE id = 1').get() as
      | { country: string | null; disabled: string }
      | undefined;
  }
  /**
   * The owner's country: the stored one, else from the owner session's locale/region (only an owner request carries
   * one; agent tools pass none, so for them an unsaved country is null and nothing is allowed).
   */
  country(locale?: string | null): { country: string | null; picked: boolean } {
    const row = this.settingsRow();
    if (row?.country) return { country: row.country, picked: true };
    return { country: packFor(this.packs, { locale: locale ?? null }).country, picked: false };
  }
  /**
   * The owner's settings load (Settings → Shopping, the onboarding card): with no stored country, the default the
   * owner is shown from their locale is saved when it has a pack, so the store list and toggles the owner sees are
   * the ones agents are held to. A country with no pack is only stored when the owner picks it.
   */
  adoptDefault(locale: string | null) {
    if (this.settingsRow()?.country) return;
    const c = packFor(this.packs, { locale }).country;
    if (!c || !this.packs.has(c)) return;
    this.app.raw
      .prepare(
        "INSERT INTO shop_settings (id, country, disabled, updated_at) VALUES (1, ?, '[]', ?) ON CONFLICT(id) DO UPDATE SET country = excluded.country, updated_at = excluded.updated_at WHERE shop_settings.country IS NULL",
      )
      .run(c, Date.now());
  }
  /** the any-host web fallback: only when the owner stored a country that has no store pack */
  webFallback(): boolean {
    const c = this.settingsRow()?.country;
    return !!c && !this.packs.has(c);
  }
  /** hosts of every store the owner turned off (pack stores of any country, and custom stores) */
  private disabledHosts(): string[] {
    const out: string[] = [];
    for (const key of this.disabled()) {
      const [cc, id] = key.split(':');
      const s = cc ? this.packs.get(cc)?.stores.find((x) => x.id === id) : undefined;
      if (s) out.push(...s.allowedHosts);
    }
    for (const c of this.customStores()) if (!c.enabled) out.push(...c.store.allowedHosts);
    return out;
  }
  private disabled(): Set<string> {
    try {
      return new Set(JSON.parse(this.settingsRow()?.disabled ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }
  customStores(): { store: Store; enabled: boolean }[] {
    const rows = this.app.raw
      .prepare('SELECT data, enabled FROM shop_custom_store ORDER BY created_at')
      .all() as {
      data: string;
      enabled: number;
    }[];
    const out: { store: Store; enabled: boolean }[] = [];
    for (const r of rows) {
      const p = storeSchema.safeParse(JSON.parse(r.data));
      if (p.success) out.push({ store: p.data, enabled: r.enabled === 1 });
    }
    return out;
  }
  /** the stores of the owner's country plus the custom stores, with their on/off state */
  stores(locale?: string | null): StoreEntry[] {
    const { country } = this.country(locale);
    const off = this.disabled();
    const pack = country ? this.packs.get(country) : undefined;
    const fromPack = (pack?.stores ?? []).map((s) => {
      const key = `${pack!.country}:${s.id}`;
      return { key, store: s, custom: false, enabled: !off.has(key) };
    });
    const custom = this.customStores().map((c) => ({
      key: `custom:${c.store.id}`,
      store: c.store,
      custom: true,
      enabled: c.enabled,
    }));
    return [...fromPack, ...custom];
  }
  saveSettings(b: z.infer<typeof settingsBody>) {
    const now = Date.now();
    const row = this.settingsRow();
    const off = this.disabled();
    let country = row?.country ?? null;
    if (b.country !== undefined) country = b.country;
    for (const [key, on] of Object.entries(b.stores ?? {})) {
      if (key.startsWith('custom:')) {
        const r = this.app.raw
          .prepare('UPDATE shop_custom_store SET enabled = ? WHERE id = ?')
          .run(on ? 1 : 0, key.slice('custom:'.length));
        if (r.changes === 0) throw new HttpError(404, 'no such store', 'not_found');
        continue;
      }
      const [cc, id] = key.split(':');
      if (!cc || !id || !this.packs.get(cc)?.stores.some((s) => s.id === id))
        throw new HttpError(404, 'no such store', 'not_found');
      if (on) off.delete(key);
      else off.add(key);
    }
    this.app.raw
      .prepare(
        'INSERT INTO shop_settings (id, country, disabled, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET country = excluded.country, disabled = excluded.disabled, updated_at = excluded.updated_at',
      )
      .run(country, JSON.stringify([...off].sort()), now);
  }
  addCustomStore(s: Store) {
    try {
      this.app.raw
        .prepare('INSERT INTO shop_custom_store (id, data, enabled, created_at) VALUES (?, ?, 1, ?)')
        .run(s.id, JSON.stringify(s), Date.now());
    } catch {
      throw new HttpError(409, 'a custom store with this id exists', 'id_taken');
    }
  }
  removeCustomStore(id: string) {
    const r = this.app.raw.prepare('DELETE FROM shop_custom_store WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, 'no such store', 'not_found');
  }

  /**
   * The enabled store whose hosts allow `url`; else, only when the owner stored a country with no pack, a one-host
   * web store; else null. A host of a store the owner turned off is never a web store.
   */
  storeForUrl(url: string, locale?: string | null): StoreEntry | null {
    const all = this.stores(locale);
    const hit = all.find((e) => e.enabled && urlAllowed(url, e.store.allowedHosts));
    if (hit) return hit;
    if (!this.webFallback()) return null;
    const off = this.disabledHosts();
    if (off.length && urlAllowed(url, off)) return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    return {
      key: `web:${host}`,
      custom: false,
      enabled: true,
      store: {
        id: 'web',
        name: host,
        homeUrl: `${u.protocol}//${u.host}/`,
        searchUrl: `${u.protocol}//${u.host}/?q={query}`,
        allowedHosts: [host],
        currency: 'USD',
        parsingHints: { prefer: ['json-ld', 'opengraph', 'microdata'] },
      },
    };
  }
  storeByKey(key: string): StoreEntry | null {
    if (key.startsWith('web:')) {
      const host = key.slice(4);
      return this.storeForUrl(`https://${host}/`) ?? null;
    }
    if (key.startsWith('custom:')) {
      const c = this.customStores().find((x) => x.store.id === key.slice(7));
      return c ? { key, store: c.store, custom: true, enabled: c.enabled } : null;
    }
    const [cc, id] = key.split(':');
    const s = cc ? this.packs.get(cc)?.stores.find((x) => x.id === id) : undefined;
    return s ? { key, store: s, custom: false, enabled: !this.disabled().has(key) } : null;
  }

  // ---------- products ----------
  product(id: string): ProductRow | undefined {
    return this.app.raw.prepare('SELECT * FROM shop_product WHERE id = ?').get(id) as ProductRow | undefined;
  }
  block(r: ProductRow): ProductBlock {
    return {
      productId: r.id,
      name: r.name,
      price: r.price,
      currency: r.currency,
      store: r.store_name,
      hosts: JSON.parse(r.hosts) as string[],
      image: r.image,
      url: r.url,
      rating: r.rating,
      ratingCount: r.rating_count,
      capturedAt: r.captured_at,
    };
  }
  saveProduct(
    entry: StoreEntry,
    f: ProductFacts,
    by: { agentId?: string; runId?: string; chatId?: string | null },
  ): ProductRow {
    const id = ulid();
    this.app.raw
      .prepare(
        'INSERT INTO shop_product (id, store_key, store_name, hosts, name, price, currency, image, url, rating, rating_count, captured_at, agent_id, run_id, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        entry.key,
        entry.store.name,
        JSON.stringify(entry.store.allowedHosts),
        f.name,
        f.price,
        f.currency,
        f.image,
        f.url,
        f.rating,
        f.ratingCount,
        Date.now(),
        by.agentId ?? null,
        by.runId ?? null,
        by.chatId ?? null,
      );
    return this.product(id)!;
  }
  /** read a product page through the managed browser and store what it says */
  async capture(
    actor: BrowserPortActor,
    url: string | undefined,
    by: Parameters<Shop['saveProduct']>[2],
    approvedTier?: ApprovalTier,
  ) {
    const port = this.app.browser.get();
    if (!port) throw new Error('the browser module is not available');
    if (this.app.killSwitch.isStopped()) throw new Error('the owner stopped all agents');
    let target = url;
    if (target === undefined) {
      // the page the browser shows now, read only when it is on one of the owner's enabled stores
      const hosts = this.stores()
        .filter((e) => e.enabled)
        .flatMap((e) => e.store.allowedHosts);
      if (!hosts.length) throw new Error('give the product page address (url)');
      const now = await port.read(actor, { allowedHosts: hosts, ...tierOpt(approvedTier) }).catch((e) => {
        // a signed-in profile the agent was not cleared for is said as such, not as "not on a store"
        if (e instanceof Error && e.message.includes('sign-ins')) throw e;
        return null;
      });
      if (!now) throw new Error('the browser is not on one of the owner’s shopping stores');
      target = now.url;
    }
    if (isSignUpUrl(target)) throw new Error('sign-up pages are only the owner’s to open');
    const entry = target ? this.storeForUrl(target) : null;
    if (!entry) throw new Error('that address is not on one of your shopping stores');
    const d = await port.read(actor, {
      ...(url !== undefined ? { url: target } : {}),
      allowedHosts: entry.store.allowedHosts,
      selectors: selectorsOf(entry.store),
      ...tierOpt(approvedTier),
    });
    const f = parseProduct(d, entry.store);
    if (!f) throw new Error('this page gives no product with a price');
    return { row: this.saveProduct(entry, f, by), page: d };
  }

  // ---------- Buy ----------
  order(id: string): OrderRow | undefined {
    return this.app.raw.prepare('SELECT * FROM shop_order WHERE id = ?').get(id) as OrderRow | undefined;
  }
  orders(limit: number): OrderRow[] {
    return this.app.raw
      .prepare('SELECT * FROM shop_order ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as OrderRow[];
  }
  newOrder(o: {
    productId: string;
    quantity: number;
    via: 'tool' | 'button';
    runId?: string;
    chatId?: string | null;
  }) {
    const id = ulid();
    const now = Date.now();
    this.app.raw
      .prepare(
        'INSERT INTO shop_order (id, product_id, quantity, state, via, run_id, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, o.productId, o.quantity, 'pending', o.via, o.runId ?? null, o.chatId ?? null, now, now);
    return id;
  }
  setOrder(id: string, state: string, message: OrderMsg | null, approvalId?: string) {
    this.app.raw
      .prepare(
        'UPDATE shop_order SET state = ?, message = ?, approval_id = COALESCE(?, approval_id), updated_at = ? WHERE id = ?',
      )
      .run(state, message ? JSON.stringify(message) : null, approvalId ?? null, Date.now(), id);
    this.app.bus.publish('owner', 'shop.order', { orderId: id, state });
  }
  /** an order message in `lng` (default: the owner's language) */
  text(m: OrderMsg, lng: string = this.app.i18n.language()): string {
    const params: Record<string, string | number> = { ...m.params };
    for (const [k, [amount, currency]] of Object.entries(m.money ?? {}))
      params[k] = moneyIn(amount, currency, lng);
    return this.app.i18n.t(m.key, params, lng);
  }
  /** a stored order message (a key with params; plain text from before keys were stored) in `lng` */
  storedText(raw: string | null, lng?: string): string | null {
    if (!raw?.startsWith('{')) return raw;
    try {
      const m = JSON.parse(raw) as OrderMsg;
      return typeof m?.key === 'string' ? this.text(m, lng) : raw;
    } catch {
      return raw;
    }
  }
  /**
   * The money card of a Buy, from the captured product (never the agent's words), in the owner's language: the
   * price formatted with `Intl` currency and the capture time in that locale.
   */
  ask(p: ProductRow, quantity: number): ApprovalAsk {
    const lng = this.app.i18n.language();
    const t = (key: string, params?: Record<string, string | number>) => this.app.i18n.t(key, params, lng);
    return {
      class: 'money',
      fields: [
        {
          key: 'items',
          value: t('shop:server.askItems', {
            quantity,
            name: p.name,
            price: moneyIn(p.price, p.currency, lng),
            time: timeIn(p.captured_at, lng),
          }),
        },
        { key: 'merchant', value: `${p.store_name} (${hostOf(p.url)})` },
        {
          key: 'total',
          value: t('shop:server.askTotal', { total: moneyIn(times(p.price, quantity), p.currency, lng) }),
        },
        { key: 'paymentMethod', value: t('shop:server.askPayment') },
      ],
    };
  }

  stopAllBuys() {
    for (const c of this.running.values()) c.abort();
  }

  /**
   * After approval: open the approved product page, re-read it, set the quantity, add to cart, open the cart or
   * checkout page and hand over. Ends in `handed-over`, `paused` (captcha / sign-in), `stopped` or `failed`.
   */
  async buy(
    orderId: string,
    actor: BrowserPortActor,
  ): Promise<{ state: string; message: string; reAsk?: Record<string, string> }> {
    const m = (key: string, params?: OrderMsg['params'], money?: OrderMsg['money']): OrderMsg => ({
      key: `shop:server.${key}`,
      ...(params ? { params } : {}),
      ...(money ? { money } : {}),
    });
    const o = this.order(orderId);
    const p = o ? this.product(o.product_id) : undefined;
    if (!o || !p) throw new Error('no such order');
    const ac = new AbortController();
    this.running.set(orderId, ac);
    const end = (state: string, msg: OrderMsg) => {
      this.setOrder(orderId, state, msg);
      const message = this.text(msg);
      this.notice(o, message);
      return { state, message };
    };
    const halted = () => ac.signal.aborted || this.app.killSwitch.isStopped();
    try {
      this.setOrder(orderId, 'running', null);
      const port = this.app.browser.get();
      if (!port) return end('failed', m('noBrowser'));
      const entry = this.storeByKey(p.store_key);
      if (!entry?.enabled) return end('failed', m('storeOff'));
      const hosts = entry.store.allowedHosts;
      if (!urlAllowed(p.url, hosts) || isSignUpUrl(p.url)) return end('failed', m('badAddress'));
      if (halted()) return end('stopped', m('stoppedBefore'));
      // a Buy only ever runs after the owner approved its money card (tier 3), from the tool or the card's button
      const cleared = { approvedTier: 3 as const };
      const page = await port.read(actor, {
        url: p.url,
        allowedHosts: hosts,
        selectors: selectorsOf(entry.store),
        ...cleared,
      });
      if (halted()) return end('stopped', m('stoppedNothing'));
      if (page.signals.captcha) return this.pause(o, port, actor, 'captcha', end);
      const now = parseProduct(page, entry.store);
      // the same item at another price: say the new price and ask again with a fresh money card at that price
      if (now && now.name === p.name && (now.price !== p.price || now.currency !== p.currency)) {
        const fresh = this.saveProduct(entry, now, { chatId: p.chat_id });
        const reOrder = this.newOrder({
          productId: fresh.id,
          quantity: o.quantity,
          via: 'button',
          chatId: p.chat_id,
        });
        const approvalId = this.app.approvals.open({
          subject: `shop:buy:${reOrder}`,
          tier: 3,
          action: {
            tool: 'shop_buy',
            title: BUY_TITLE,
            titleKey: 'shop:tools.shop_buy',
            productId: fresh.id,
            quantity: o.quantity,
          },
          summary: `Buy ${o.quantity} × ${fresh.name} at ${fresh.store_name}`,
          msg: {
            key: 'shop:server.buySummary',
            params: { quantity: o.quantity, name: fresh.name, store: fresh.store_name },
          },
          ask: this.ask(fresh, o.quantity),
          ...(p.chat_id ? { href: `#/chats/${p.chat_id}` } : {}),
        });
        this.setOrder(reOrder, 'pending', null, approvalId);
        return {
          ...end(
            'stopped',
            m('priceChanged', undefined, {
              before: [p.price, p.currency],
              after: [now.price, now.currency],
            }),
          ),
          reAsk: {
            orderId: reOrder,
            approvalId,
            productId: fresh.id,
            price: now.price,
            currency: now.currency,
          },
        };
      }
      if (!now || now.name !== p.name || now.price !== p.price || now.currency !== p.currency)
        return end('stopped', m('pageDiffers', undefined, { price: [p.price, p.currency] }));
      const cart = entry.store.parsingHints.cart;
      if (!cart?.addToCart) {
        await port.handOver(actor, {
          ...cleared,
          reason: this.app.i18n.t('shop:server.openNoCartHandOver', {
            name: p.name,
            store: p.store_name,
            quantity: o.quantity,
          }),
        });
        return end(
          'handed-over',
          m('openNoCart', { name: p.name, store: p.store_name, quantity: o.quantity }),
        );
      }
      if (cart.quantity)
        await port.fill(actor, {
          selector: cart.quantity,
          value: String(o.quantity),
          allowedHosts: hosts,
          ...cleared,
        });
      if (halted()) return end('stopped', m('stoppedNothing'));
      await port.click(actor, { selector: cart.addToCart, allowedHosts: hosts, ...cleared });
      if (halted()) return end('stopped', m('stoppedAfterAdd'));
      let last: BrowserPageData;
      if (cart.checkoutUrl) {
        if (isSignUpUrl(cart.checkoutUrl)) return end('failed', m('checkoutSignUp'));
        last = await port.read(actor, { url: cart.checkoutUrl, allowedHosts: hosts, ...cleared });
      } else last = await port.read(actor, { allowedHosts: hosts, ...cleared });
      if (halted()) return end('stopped', m('stoppedInCart'));
      if (last.signals.captcha) return this.pause(o, port, actor, 'captcha', end);
      if (isSignUpUrl(last.url) || (last.signals.signIn && !last.signals.cardField))
        return this.pause(o, port, actor, 'sign-in', end);
      await port.handOver(actor, {
        ...cleared,
        reason: this.app.i18n.t('shop:server.inCartHandOver', {
          quantity: o.quantity,
          name: p.name,
          store: p.store_name,
        }),
      });
      return end('handed-over', m('inCart', { quantity: o.quantity, name: p.name, store: p.store_name }));
    } catch (e) {
      if (halted()) return end('stopped', m('stoppedCheck'));
      const msg = e instanceof Error ? e.message : String(e);
      return end('failed', m('buyFailed', { error: this.app.redact(msg) }));
    } finally {
      this.running.delete(orderId);
    }
  }
  private async pause(
    o: OrderRow,
    port: NonNullable<ReturnType<ModuleHost['browser']['get']>>,
    actor: BrowserPortActor,
    why: 'captcha' | 'sign-in',
    end: (s: string, m: OrderMsg) => { state: string; message: string },
  ) {
    const msg: OrderMsg = { key: why === 'captcha' ? 'shop:server.captcha' : 'shop:server.signIn' };
    // only reached from a Buy the owner approved on its money card (tier 3)
    await port.handOver(actor, { reason: this.text(msg), approvedTier: 3 }).catch(() => {});
    void o;
    return end('paused', msg);
  }
  /** the plain hand-over message in the chat the card came from */
  private notice(o: OrderRow, message: string) {
    const chatId = o.chat_id;
    if (!chatId) return;
    try {
      this.app.chats.post(asSystem('shop: Buy outcome'), {
        chatId,
        authorKind: 'system',
        authorId: null,
        body: message,
        blocks: [],
        ...(o.run_id ? { runId: o.run_id } : {}),
      });
    } catch (e) {
      this.app.log.warn('shop: could not post the Buy outcome', { error: String(e) });
    }
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
const selectorsOf = (s: Store): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.parsingHints.selectors ?? {})) if (v) out[k] = v;
  return out;
};

const tierOpt = (t: ApprovalTier | undefined) => (t === undefined ? {} : { approvedTier: t });
const agentActor = (ctx: ToolCtx): BrowserPortActor => ({
  kind: 'agent',
  id: ctx.agent.id,
  runId: ctx.run.id,
});
const untrustedProduct = (p: ProductRow) =>
  renderUntrustedBlock({
    source: 'shop',
    label: 'Product as read from a store page',
    items: [
      {
        text: p.name,
        meta: {
          productId: p.id,
          price: p.price,
          currency: p.currency,
          store: p.store_name,
          asSeenAt: new Date(p.captured_at).toISOString(),
          ...(p.rating !== null ? { rating: String(p.rating) } : {}),
          ...(p.rating_count !== null ? { ratingCount: String(p.rating_count) } : {}),
        },
      },
    ],
  });

export function createShopModule(o: ShopOptions = {}): PasaBotModule & { shop(): Shop } {
  let inst: Shop | null = null;
  return {
    id: 'shop',
    migrations: join(here, '..', 'migrations'),
    shop() {
      if (!inst) throw new Error('shop module not registered yet');
      return inst;
    },
    register(app) {
      const shop = new Shop(app, o);
      inst = shop;
      app.blocks.register('shop.product', productBlockSchema);
      app.blocks.register('shop.compare', z.object({ items: z.array(productBlockSchema).min(2).max(4) }));
      // W31: the global stop ends every Buy in progress
      app.killSwitch.onStop(async () => {
        const live = app.raw.prepare("SELECT id FROM shop_order WHERE state = 'running'").all() as {
          id: string;
        }[];
        shop.stopAllBuys();
        const label = app.i18n.t('shop:server.buyLabel');
        return live.map((r) => ({ kind: 'shop-buy', id: r.id, label, outcome: 'cancelled' as const }));
      });
      // the Buy button's approval: approved → the cart flow as the owner who decided; anything else → denied
      app.bus.subscribe((ev) => {
        if (ev.live || ev.type !== 'approval.resolved') return;
        const a = ev.data as ApprovalDTO;
        if (!a?.subject?.startsWith('shop:buy:')) return;
        const orderId = a.subject.slice('shop:buy:'.length);
        const ord = shop.order(orderId);
        if (ord?.state !== 'pending') return;
        if (a.state === 'approved') {
          const by = a.decidedBy ?? 'owner';
          queueMicrotask(() => void shop.buy(orderId, { kind: 'user', id: by }));
        } else shop.setOrder(orderId, 'denied', { key: 'shop:server.denied' });
      });

      // ---------- owner REST ----------
      app.http.route({
        method: 'GET',
        url: '/settings',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const q = ctx.query as Record<string, string | undefined>;
          const locale = typeof q.locale === 'string' ? q.locale.slice(0, 35) : null;
          const c = shop.country(locale);
          // what the owner is shown is what agents are held to: save the locale's default (when it has a pack)
          shop.adoptDefault(locale);
          return {
            country: c.country,
            picked: c.picked,
            fallback: !(c.country && shop.packs.has(c.country)),
            countries: [...shop.packs.values()]
              .map((p) => ({ code: p.country, name: p.name }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            stores: shop.stores(locale).map((e) => ({
              key: e.key,
              id: e.store.id,
              name: e.store.name,
              homeUrl: e.store.homeUrl,
              currency: e.store.currency,
              custom: e.custom,
              enabled: e.enabled,
            })),
          };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/settings',
        auth: 'session',
        body: settingsBody,
        handler: (ctx) => {
          owner(ctx);
          shop.saveSettings(ctx.body);
          return { ok: true };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/custom-stores',
        auth: 'session',
        body: storeSchema,
        handler: (ctx) => {
          owner(ctx);
          shop.addCustomStore(ctx.body);
          return { ok: true, key: `custom:${ctx.body.id}` };
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/custom-stores/:id',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          shop.removeCustomStore(ctx.params.id!);
          return { ok: true };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/products',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const rows = app.raw
            .prepare('SELECT * FROM shop_product ORDER BY captured_at DESC, id DESC LIMIT 50')
            .all() as ProductRow[];
          return { products: rows.map((r) => shop.block(r)) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/products/:id',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const p = shop.product(ctx.params.id!);
          if (!p) throw new HttpError(404, 'no such product', 'not_found');
          return { product: shop.block(p) };
        },
      });
      // the card's Buy button: the owner asks; the same money card is raised (tier 3, approvable only in the app)
      app.http.route({
        method: 'POST',
        url: '/products/:id/buy',
        auth: 'session',
        body: z.object({ quantity: quantitySchema.default(1) }).strict(),
        handler: (ctx) => {
          owner(ctx);
          const p = shop.product(ctx.params.id!);
          if (!p) throw new HttpError(404, 'no such product', 'not_found');
          const orderId = shop.newOrder({
            productId: p.id,
            quantity: ctx.body.quantity,
            via: 'button',
            chatId: p.chat_id,
          });
          const approvalId = app.approvals.open({
            subject: `shop:buy:${orderId}`,
            tier: 3,
            action: {
              tool: 'shop_buy',
              title: BUY_TITLE,
              titleKey: 'shop:tools.shop_buy',
              productId: p.id,
              quantity: ctx.body.quantity,
            },
            summary: `Buy ${ctx.body.quantity} × ${p.name} at ${p.store_name}`,
            msg: {
              key: 'shop:server.buySummary',
              params: { quantity: ctx.body.quantity, name: p.name, store: p.store_name },
            },
            ask: shop.ask(p, ctx.body.quantity),
            ...(p.chat_id ? { href: `#/chats/${p.chat_id}` } : {}),
          });
          shop.setOrder(orderId, 'pending', null, approvalId);
          return { orderId, approvalId };
        },
      });
      // the owner's Buys, newest first (what the card's state and the README promise)
      app.http.route({
        method: 'GET',
        url: '/orders',
        auth: 'session',
        handler: (ctx) => {
          const lng = app.i18n.language(owner(ctx));
          return {
            orders: shop
              .orders(50)
              .map((r) => orderView(r, shop.product(r.product_id), shop.storedText(r.message, lng))),
          };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/orders/:id',
        auth: 'session',
        handler: (ctx) => {
          const lng = app.i18n.language(owner(ctx));
          const r = shop.order(ctx.params.id!);
          if (!r) throw new HttpError(404, 'no such order', 'not_found');
          return { order: orderView(r, shop.product(r.product_id), shop.storedText(r.message, lng)) };
        },
      });

      // ---------- agent tools ----------
      // shop_search / shop_capture drive the managed browser: tier 2 on a signed-out profile, tier 3 on one that may
      // hold the owner's sign-ins (as the browser module's own tools). The tier the call was cleared at goes to the
      // port, which re-checks the profile as it is when the page is touched.
      const cleared = new WeakMap<object, ApprovalTier>();
      const browserTier = (ctx: ToolCtx): ApprovalTier => {
        const t: ApprovalTier = app.browser.get()?.profileInfo()?.loggedIn ? 3 : 2;
        cleared.set(ctx, t);
        return t;
      };
      const clearedTier = (ctx: ToolCtx): ApprovalTier => cleared.get(ctx) ?? 2;
      app.tools.add({
        name: 'shop_stores',
        title: 'Shopping stores',
        description:
          'Lists the stores the owner shops at (their country and the stores they turned on). Use shop_search to look for a product at one of them.',
        input: z.object({}).strict(),
        tier: 0,
        handler: async () => {
          const c = shop.country();
          return {
            country: c.country,
            fallback: !(c.country && shop.packs.has(c.country)),
            stores: shop
              .stores()
              .filter((e) => e.enabled)
              .map((e) => ({ store: e.key, name: e.store.name })),
          };
        },
      });
      app.tools.add({
        name: 'shop_search',
        title: 'Search a store',
        description:
          'Opens a store search for a product in the owner’s browser and returns the search address. Read the results with browser_snapshot, then capture a product page with shop_capture.',
        input: z.object({ query: z.string().min(1).max(200), store: z.string().max(80).optional() }).strict(),
        tier: (_i, ctx) => browserTier(ctx),
        handler: async (i, ctx) => {
          if (app.killSwitch.isStopped()) throw new Error('the owner stopped all agents');
          const enabled = shop.stores().filter((e) => e.enabled);
          const entry = i.store
            ? enabled.find((e) => e.key === i.store || e.store.id === i.store)
            : enabled[0];
          if (i.store && !entry) throw new Error('that store is not one of the owner’s stores');
          // a generic web search only for a country the owner picked that has no store pack
          if (!entry && !shop.webFallback())
            throw new Error(
              shop.country().country
                ? 'the owner turned off every store; ask them to turn one on in Settings → Shopping'
                : 'the owner has not set up shopping yet; ask them to pick their country in Settings → Shopping',
            );
          const template = entry?.store.searchUrl ?? WEB_SEARCH;
          const hosts = entry?.store.allowedHosts ?? WEB_SEARCH_HOSTS;
          const url = fillSearch(template, i.query);
          const port = app.browser.get();
          if (port)
            await port.read(agentActor(ctx), { url, allowedHosts: hosts, approvedTier: clearedTier(ctx) });
          return { store: entry?.key ?? 'web', url, opened: !!port };
        },
      });
      app.tools.add({
        name: 'shop_capture',
        title: 'Capture a product',
        description:
          'Reads a product page in the owner’s browser (or the page it shows now) and saves the product the page itself describes (name, price, currency, store, rating, picture). Returns a productId for shop_show, shop_compare and shop_buy. The page data is untrusted.',
        input: z.object({ url: z.string().max(2000).optional() }).strict(),
        tier: (_i, ctx) => browserTier(ctx),
        handler: async (i, ctx) => {
          const { row } = await shop.capture(
            agentActor(ctx),
            i.url,
            {
              agentId: ctx.agent.id,
              runId: ctx.run.id,
              chatId: app.chats.runChat(ctx.run.id),
            },
            clearedTier(ctx),
          );
          return { productId: row.id, data: untrustedProduct(row) };
        },
      });
      const postBlocks = (
        ctx: ToolCtx,
        body: string,
        blocks: { kind: `${string}.${string}`; v: number; data: unknown }[],
      ) => {
        const chatId = app.chats.runChat(ctx.run.id);
        if (!chatId) throw new Error('this run has no chat to show it in');
        const m = app.chats.post(
          { kind: 'agent', id: ctx.agent.id },
          { chatId, authorKind: 'agent', authorId: ctx.agent.id, body, blocks, runId: ctx.run.id },
        );
        return m.id;
      };
      const known = (id: string) => {
        const p = shop.product(id);
        if (!p)
          throw new Error(`no captured product ${plainText(id, 40)}; capture it with shop_capture first`);
        return p;
      };
      app.tools.add({
        name: 'shop_show',
        title: 'Show a product card',
        description:
          'Shows a captured product to the owner as a card with its price as seen and a Buy button.',
        input: z.object({ productId: z.string().max(40) }).strict(),
        tier: 1,
        handler: async (i, ctx) => {
          const p = known(i.productId);
          const chatId = app.chats.runChat(ctx.run.id);
          if (chatId && !p.chat_id)
            app.raw.prepare('UPDATE shop_product SET chat_id = ? WHERE id = ?').run(chatId, p.id);
          const messageId = postBlocks(ctx, '', [{ kind: 'shop.product', v: 1, data: shop.block(p) }]);
          return { shown: true, messageId };
        },
      });
      app.tools.add({
        name: 'shop_compare',
        title: 'Compare products',
        description: 'Shows 2 to 4 captured products side by side.',
        input: z.object({ productIds: z.array(z.string().max(40)).max(10) }).strict(),
        tier: 1,
        handler: async (i, ctx) => {
          if (i.productIds.length < 2 || i.productIds.length > 4)
            throw new Error('compare takes 2 to 4 captured products');
          const rows = i.productIds.map(known);
          const chatId = app.chats.runChat(ctx.run.id);
          for (const p of rows)
            if (chatId && !p.chat_id)
              app.raw.prepare('UPDATE shop_product SET chat_id = ? WHERE id = ?').run(chatId, p.id);
          const messageId = postBlocks(ctx, '', [
            { kind: 'shop.compare', v: 1, data: { items: rows.map((r) => shop.block(r)) } },
          ]);
          return { shown: true, messageId };
        },
      });
      app.tools.add({
        name: 'shop_buy',
        title: BUY_TITLE,
        description:
          'Asks the owner to approve buying a captured product. After approval PasaBot opens the product in the owner’s browser, adds the quantity to the cart, opens the cart or checkout page and hands it to the owner, who pays. You never pay, place the order, type card details or handle codes.',
        input: z.object({ productId: z.string().max(40), quantity: quantitySchema.default(1) }).strict(),
        tier: 3,
        noAlwaysAllow: true,
        actionClass: 'money',
        actionDetails: (i) => shop.ask(known(i.productId), i.quantity),
        handler: async (i, ctx) => {
          const p = known(i.productId);
          const orderId = shop.newOrder({
            productId: p.id,
            quantity: i.quantity,
            via: 'tool',
            runId: ctx.run.id,
            chatId: app.chats.runChat(ctx.run.id),
          });
          const r = await shop.buy(orderId, agentActor(ctx));
          return {
            state: r.state,
            message: r.message,
            next: 'Stop here and tell the owner in one plain sentence; do not take any further browser action.',
          };
        },
      });
    },
  };
}

export default defineModule(createShopModule());
