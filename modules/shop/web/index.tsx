/**
 * Shopping (W30): product cards and compare in chat (server-captured facts only, rendered as text; images and
 * links through `safeImageSrc` / `safeHref` and only on the store's hosts), the card's Buy button (raises the money
 * approval card; the owner approves it in the app), and Settings → Shopping / the onboarding step (country, store
 * toggles, custom stores).
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { type MessageBlock, urlAllowed } from '@pasabot/protocol';
import { Badge, BrandTile, Button, Card, Field, safeHref, safeImageSrc } from '@pasabot/ui';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

type T = (k: string, o?: Record<string, unknown>) => string;
// also rendered on the server (the SDK slot test): no `document` / `navigator` there
const translations = moduleTranslator(
  'shop',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT(): [T, string] {
  const { t, lang } = useModuleT(translations);
  return [t, lang];
}
/** the locale used to format prices and times: the app language (with the device's region for English) */
const formatLocale = (lng: string) => displayLocale(lng);
/** the device's own locale, only to guess the owner's country for the store list (never to format text) */
const deviceLocale = () => (typeof navigator !== 'undefined' && navigator.language) || 'en';

const API = '/api/m/shop';
async function call<R>(path: string, init: RequestInit = {}): Promise<R> {
  const r = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as R & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

// ---------- cards ----------
interface Product {
  productId: string;
  name: string;
  price: string;
  currency: string;
  store: string;
  hosts: string[];
  image: string | null;
  url: string;
  rating: number | null;
  ratingCount: number | null;
  capturedAt: number;
}

/** only an http(s) URL on one of the store's hosts (exact, or a `*.` suffix): the shared `urlAllowed` matcher */
const onHosts = (raw: unknown, hosts: unknown): boolean =>
  Array.isArray(hosts) &&
  urlAllowed(
    raw,
    hosts.filter((h): h is string => typeof h === 'string'),
  );
const linkOf = (p: Product) => (onHosts(p.url, p.hosts) ? safeHref(p.url) : undefined);
const imageOf = (p: Product) => (onHosts(p.image, p.hosts) ? safeImageSrc(p.image) : undefined);

function asProduct(d: unknown): Product | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.productId !== 'string' || typeof o.name !== 'string' || typeof o.price !== 'string')
    return null;
  return {
    productId: o.productId,
    name: o.name,
    price: o.price,
    currency: typeof o.currency === 'string' ? o.currency : '',
    store: typeof o.store === 'string' ? o.store : '',
    hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === 'string') : [],
    image: typeof o.image === 'string' ? o.image : null,
    url: typeof o.url === 'string' ? o.url : '',
    rating: typeof o.rating === 'number' ? o.rating : null,
    ratingCount: typeof o.ratingCount === 'number' ? o.ratingCount : null,
    capturedAt: typeof o.capturedAt === 'number' ? o.capturedAt : 0,
  };
}

function moneyText(price: string, currency: string, loc: string) {
  const n = Number(price);
  try {
    // formatted for the owner's locale, in the store's own currency: never converted
    return new Intl.NumberFormat(loc, { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${price}`;
  }
}
const priceText = (p: Product, loc: string) => moneyText(p.price, p.currency, loc);
const timeText = (at: number, loc: string) =>
  new Date(at).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
const seenText = (p: Product, loc: string) => timeText(p.capturedAt, loc);

const sx: Record<string, CSSProperties> = {
  card: { display: 'grid', gap: 8, maxWidth: 420, minWidth: 0 },
  imgBox: {
    width: '100%',
    aspectRatio: '4 / 3',
    borderRadius: 10,
    background: 'var(--pb-surface-2, rgba(127,127,127,0.12))',
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
  },
  img: { width: '100%', height: '100%', objectFit: 'contain' },
  name: { margin: 0, fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' },
  price: { margin: 0, fontSize: 18, fontWeight: 700 },
  small: { margin: 0, fontSize: 13, opacity: 0.8, overflowWrap: 'anywhere' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  tap: { minHeight: 44, minWidth: 44 },
};

function Facts({ p, t, loc }: { p: Product; t: T; loc: string }) {
  const img = imageOf(p);
  const link = linkOf(p);
  return (
    <>
      <div style={sx.imgBox}>
        {img ? (
          <img src={img} alt="" style={sx.img} referrerPolicy="no-referrer" loading="lazy" />
        ) : (
          <span style={sx.small} data-testid="shop-no-image">
            {t('card.noImage')}
          </span>
        )}
      </div>
      <p style={sx.name}>{p.name}</p>
      <p style={sx.price} data-testid="shop-price">
        {priceText(p, loc)}
      </p>
      <p style={sx.small} data-testid="shop-seen">
        {t('card.seenAt', { time: seenText(p, loc) })}
      </p>
      <p style={sx.small}>{p.store}</p>
      {p.rating !== null && (
        <p style={sx.small}>
          {p.ratingCount !== null
            ? t('card.ratingCount', { rating: p.rating, count: p.ratingCount })
            : t('card.rating', { rating: p.rating })}
        </p>
      )}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer nofollow"
          style={{ ...sx.small, ...sx.tap, display: 'inline-flex', alignItems: 'center' }}
        >
          {t('card.open', { store: p.store })}
        </a>
      )}
    </>
  );
}

/** how often the card asks how its Buy is going while it is still pending or running */
export const ORDER_POLL_MS = 2_000;
const LIVE_ORDER = new Set(['pending', 'running']);
const ORDER_TEXT: Record<string, string> = {
  pending: 'buy.asked',
  running: 'buy.state.running',
  'handed-over': 'buy.state.handedOver',
  denied: 'buy.state.denied',
  paused: 'buy.state.paused',
  stopped: 'buy.state.stopped',
  failed: 'buy.state.stopped',
};

function BuyButton({ p, t }: { p: Product; t: T }) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(1);
  const [state, setState] = useState<'idle' | 'busy' | 'asked' | 'error'>('idle');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderState, setOrderState] = useState<string>('pending');
  const [tick, setTick] = useState(0);
  const ask = async () => {
    setState('busy');
    try {
      const r = await call<{ orderId?: string }>(`/products/${encodeURIComponent(p.productId)}/buy`, {
        method: 'POST',
        body: JSON.stringify({ quantity: qty }),
      });
      setOrderId(typeof r.orderId === 'string' ? r.orderId : null);
      setOrderState('pending');
      setState('asked');
    } catch {
      setState('error');
    }
  };
  // after the ask: follow the order until it leaves "pending" and "running" (approved, denied, handed over, …)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-arms the next poll while the state is unchanged
  useEffect(() => {
    if (state !== 'asked' || !orderId || !LIVE_ORDER.has(orderState)) return;
    let gone = false;
    const timer = setTimeout(async () => {
      try {
        const r = await call<{ order?: { state?: unknown } }>(`/orders/${encodeURIComponent(orderId)}`);
        if (gone) return;
        if (typeof r.order?.state === 'string' && r.order.state !== orderState) setOrderState(r.order.state);
        else setTick((n) => n + 1);
      } catch {
        if (!gone) setTick((n) => n + 1); // try again on the next tick
      }
    }, ORDER_POLL_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [state, orderId, orderState, tick]);
  if (state === 'asked')
    return (
      <p style={sx.small} role="status" data-testid="shop-buy-state" data-state={orderState}>
        {t(ORDER_TEXT[orderState] ?? 'buy.state.ended')}
      </p>
    );
  if (!open)
    return (
      <Button variant="primary" style={sx.tap} onClick={() => setOpen(true)}>
        {t('buy.button')}
      </Button>
    );
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={sx.row}>
        <Button
          aria-label={t('buy.less')}
          style={sx.tap}
          disabled={qty <= 1}
          onClick={() => setQty((q) => q - 1)}
        >
          −
        </Button>
        <span aria-live="polite" style={{ minWidth: 60, textAlign: 'center', fontSize: 15 }}>
          {t('buy.qty', { count: qty })}
        </span>
        <Button
          aria-label={t('buy.more')}
          style={sx.tap}
          disabled={qty >= 99}
          onClick={() => setQty((q) => q + 1)}
        >
          +
        </Button>
      </div>
      <p style={sx.small}>{t('buy.note')}</p>
      <div style={sx.row}>
        <Button variant="primary" style={sx.tap} disabled={state === 'busy'} onClick={ask}>
          {t('buy.ask')}
        </Button>
        <Button variant="ghost" style={sx.tap} onClick={() => setOpen(false)}>
          {t('buy.cancel')}
        </Button>
      </div>
      {state === 'error' && (
        <p style={sx.small} role="alert">
          {t('buy.error')}
        </p>
      )}
    </div>
  );
}

export function ProductCard({ block }: { block: MessageBlock }) {
  const [t, lng] = useT();
  const p = asProduct(block.data);
  if (!p) return null;
  return (
    <Card>
      <div style={sx.card} data-testid="shop-card">
        <Facts p={p} t={t} loc={formatLocale(lng)} />
        <BuyButton p={p} t={t} />
      </div>
    </Card>
  );
}

export function CompareCard({ block }: { block: MessageBlock }) {
  const [t, lng] = useT();
  const items = (
    Array.isArray((block.data as { items?: unknown })?.items)
      ? (block.data as { items: unknown[] }).items
      : []
  )
    .map(asProduct)
    .filter((x): x is Product => !!x);
  // compare is 2 to 4 products (the server refuses anything else); a block outside that shows nothing
  if (items.length < 2 || items.length > 4) return null;
  return (
    <Card>
      <p style={{ ...sx.name, marginBottom: 8 }}>{t('compare.title', { count: items.length })}</p>
      <div
        data-testid="shop-compare"
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
          minWidth: 0,
        }}
      >
        {items.map((p) => (
          <div
            key={p.productId}
            style={{ ...sx.card, alignContent: 'start' }}
            data-testid="shop-compare-item"
          >
            <Facts p={p} t={t} loc={formatLocale(lng)} />
            <BuyButton p={p} t={t} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- settings ----------
interface Settings {
  country: string | null;
  picked: boolean;
  fallback: boolean;
  countries: { code: string; name: string }[];
  stores: {
    key: string;
    id: string;
    name: string;
    homeUrl: string;
    currency: string;
    custom: boolean;
    enabled: boolean;
  }[];
}

function useSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    try {
      setS(await call<Settings>(`/settings?locale=${encodeURIComponent(deviceLocale())}`));
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { s, err, load };
}

/**
 * A country's name in the app language (Intl.DisplayNames), sorted the way that language sorts; the server's
 * English name only when the runtime has no name for the code.
 */
export function countryNames(
  countries: readonly { code: string; name: string }[],
  lng: string,
): { code: string; name: string }[] {
  const loc = formatLocale(lng);
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([loc], { type: 'region', fallback: 'none' });
  } catch {
    names = null;
  }
  const out = countries.map((c) => {
    let name: string | undefined;
    try {
      name = names?.of(c.code.toUpperCase());
    } catch {
      name = undefined;
    }
    return { code: c.code, name: name || c.name };
  });
  const coll = new Intl.Collator(loc);
  return out.sort((a, b) => coll.compare(a.name, b.name));
}

function CountryPicker({ s, t, lng, onSaved }: { s: Settings; t: T; lng: string; onSaved(): void }) {
  const [busy, setBusy] = useState(false);
  const countries = useMemo(() => countryNames(s.countries, lng), [s.countries, lng]);
  const change = async (country: string) => {
    setBusy(true);
    try {
      await call('/settings', { method: 'PUT', body: JSON.stringify({ country: country || null }) });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <label style={{ display: 'grid', gap: 6, fontSize: 14 }}>
      <span>{t('settings.country')}</span>
      <select
        value={s.country ?? ''}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        style={{ minHeight: 44, fontSize: 15, maxWidth: '100%' }}
      >
        {!s.country || !s.countries.some((c) => c.code === s.country) ? (
          <option value={s.country ?? ''}>{t('settings.webOnly')}</option>
        ) : null}
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function StoreToggles({ s, t, onSaved }: { s: Settings; t: T; onSaved(): void }) {
  // shown at once; put back when the server refuses
  const [over, setOver] = useState<Record<string, boolean>>({});
  const toggle = async (key: string, on: boolean) => {
    setOver((o) => ({ ...o, [key]: on }));
    try {
      await call('/settings', { method: 'PUT', body: JSON.stringify({ stores: { [key]: on } }) });
      onSaved();
    } catch {
      setOver((o) => ({ ...o, [key]: !on }));
    }
  };
  const remove = async (id: string) => {
    await call(`/custom-stores/${encodeURIComponent(id)}`, { method: 'DELETE' });
    onSaved();
  };
  if (!s.stores.length) return <p style={sx.small}>{t('settings.fallback')}</p>;
  // the stores as tiles with their own marks to tap (each still a checkbox: on = helpers may use it)
  return (
    <ul
      data-testid="shop-stores"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))',
        gap: 8,
      }}
    >
      {s.stores.map((st) => {
        const on = over[st.key] ?? st.enabled;
        return (
          <li key={st.key} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <label
              className="bk-choice-tile"
              data-on={on || undefined}
              data-testid={`shop-store-tile-${st.key}`}
              style={{
                ...sx.row,
                ...sx.tap,
                flexWrap: 'nowrap',
                minWidth: 0,
                minBlockSize: 56,
                padding: '8px 12px',
                borderRadius: 14,
                cursor: 'pointer',
                fontSize: 15,
                background: on
                  ? 'color-mix(in srgb, var(--bk-primary) 12%, var(--bk-panel))'
                  : 'var(--bk-panel)',
                boxShadow: on ? 'inset 0 0 0 2px var(--bk-primary)' : 'inset 0 0 0 1px var(--bk-line)',
              }}
            >
              {/* a pack store's key is `<country>:<id>`; the mark is the store id's, a custom store gets the store glyph */}
              <BrandTile
                id={st.custom ? 'store' : st.key.slice(st.key.indexOf(':') + 1)}
                size={36}
                fallback="bag"
              />
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontWeight: 600 }}>
                {st.name}
              </span>
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => void toggle(st.key, e.target.checked)}
                style={{ width: 22, height: 22, flex: '0 0 auto' }}
                data-testid={`shop-store-${st.key}`}
              />
            </label>
            {st.custom && (
              <span style={{ ...sx.row, justifyContent: 'space-between', gap: 6 }}>
                <Badge>{t('settings.custom')}</Badge>
                <Button variant="ghost" style={sx.tap} onClick={() => void remove(st.id)}>
                  {t('settings.remove')}
                </Button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CustomStoreForm({ t, onSaved }: { t: T; onSaved(): void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', id: '', homeUrl: '', searchUrl: '', hosts: '', currency: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setError(null);
    try {
      await call('/custom-stores', {
        method: 'POST',
        body: JSON.stringify({
          id: f.id.trim(),
          name: f.name.trim(),
          homeUrl: f.homeUrl.trim(),
          searchUrl: f.searchUrl.trim(),
          allowedHosts: f.hosts
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean),
          currency: f.currency.trim().toUpperCase(),
          parsingHints: { prefer: ['json-ld', 'opengraph', 'microdata'] },
        }),
      });
      setF({ name: '', id: '', homeUrl: '', searchUrl: '', hosts: '', currency: '' });
      setOpen(false);
      onSaved();
    } catch {
      setError(t('custom.error'));
    }
  };
  if (!open)
    return (
      <Button style={sx.tap} onClick={() => setOpen(true)}>
        {t('custom.add')}
      </Button>
    );
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label={t('custom.name')} value={f.name} onChange={set('name')} />
      <Field label={t('custom.id')} hint={t('custom.idHint')} value={f.id} onChange={set('id')} />
      <Field label={t('custom.home')} value={f.homeUrl} onChange={set('homeUrl')} inputMode="url" />
      <Field
        label={t('custom.search')}
        hint={t('custom.searchHint')}
        value={f.searchUrl}
        onChange={set('searchUrl')}
        inputMode="url"
      />
      <Field label={t('custom.hosts')} hint={t('custom.hostsHint')} value={f.hosts} onChange={set('hosts')} />
      <Field
        label={t('custom.currency')}
        hint={t('custom.currencyHint')}
        value={f.currency}
        onChange={set('currency')}
        maxLength={3}
      />
      {error && (
        <p role="alert" style={sx.small}>
          {error}
        </p>
      )}
      <div style={sx.row}>
        <Button variant="primary" style={sx.tap} onClick={() => void save()}>
          {t('custom.save')}
        </Button>
        <Button variant="ghost" style={sx.tap} onClick={() => setOpen(false)}>
          {t('buy.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ---------- orders ----------
interface OrderItem {
  id: string;
  state: string;
  quantity: number;
  item: string | null;
  store: string | null;
  price: string | null;
  currency: string | null;
  createdAt: number;
}
const ORDER_STATES = new Set(['pending', 'denied', 'running', 'handed-over', 'paused', 'stopped', 'failed']);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
function asOrder(v: unknown): OrderItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.state !== 'string') return null;
  return {
    id: o.id,
    state: o.state,
    quantity: typeof o.quantity === 'number' ? o.quantity : 0,
    item: str(o.item),
    store: str(o.store),
    price: str(o.price),
    currency: str(o.currency),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
}
/** the owner's Buy orders, newest first (GET /orders): state, store, item, quantity, price as seen, time */
export function OrdersList() {
  const [t, lng] = useT();
  const loc = formatLocale(lng);
  const [orders, setOrders] = useState<OrderItem[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let gone = false;
    call<{ orders?: unknown }>('/orders')
      .then((r) => {
        if (gone) return;
        const list = Array.isArray(r.orders) ? r.orders.map(asOrder) : [];
        setOrders(list.filter((o): o is OrderItem => !!o));
      })
      .catch(() => !gone && setErr(true));
    return () => {
      gone = true;
    };
  }, []);
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 0 }} data-testid="shop-orders">
      <p style={{ ...sx.name, fontSize: 14 }}>{t('orders.title')}</p>
      {err ? (
        <p style={sx.small}>{t('orders.error')}</p>
      ) : !orders ? (
        <p style={sx.small}>{t('settings.loading')}</p>
      ) : orders.length === 0 ? (
        <p style={sx.small}>{t('orders.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10, minWidth: 0 }}>
          {orders.map((o) => (
            <li
              key={o.id}
              data-testid="shop-order"
              data-state={o.state}
              style={{ display: 'grid', gap: 2, minWidth: 0 }}
            >
              <p style={sx.name}>
                {t('orders.line', { qty: o.quantity, item: o.item ?? t('orders.unknownItem') })}
              </p>
              <p style={sx.small}>
                {[
                  o.store,
                  o.price && o.currency
                    ? t('orders.each', { price: moneyText(o.price, o.currency, loc) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p style={sx.small}>
                <strong>{t(`orders.state.${ORDER_STATES.has(o.state) ? o.state : 'other'}`)}</strong>
                {o.createdAt ? ` · ${timeText(o.createdAt, loc)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShoppingSettings() {
  const [t, lng] = useT();
  const { s, err, load } = useSettings();
  if (err) return <p style={sx.small}>{t('settings.error')}</p>;
  if (!s) return <p style={sx.small}>{t('settings.loading')}</p>;
  return (
    <section style={{ display: 'grid', gap: 16, minWidth: 0 }} data-testid="shop-settings">
      <h2 style={{ margin: 0, fontSize: 18 }}>{t('settings.title')}</h2>
      <p style={sx.small}>{t('settings.intro')}</p>
      <CountryPicker s={s} t={t} lng={lng} onSaved={load} />
      <div style={{ display: 'grid', gap: 6 }}>
        <p style={{ ...sx.name, fontSize: 14 }}>{t('settings.stores')}</p>
        <StoreToggles s={s} t={t} onSaved={load} />
      </div>
      <CustomStoreForm t={t} onSaved={load} />
      <p style={sx.small}>{t('settings.rules')}</p>
      <OrdersList />
    </section>
  );
}

function OnboardingShop() {
  const [t, lng] = useT();
  const { s, load } = useSettings();
  if (!s) return null;
  return (
    <Card>
      <div style={{ display: 'grid', gap: 10 }} data-testid="shop-onboarding">
        <p style={sx.name}>{t('onboarding.title')}</p>
        <p style={sx.small}>{t('onboarding.body')}</p>
        <CountryPicker s={s} t={t} lng={lng} onSaved={load} />
      </div>
    </Card>
  );
}

const mod: WebModule = {
  id: 'shop',
  settingsSections: [
    {
      id: 'shop',
      labelKey: 'shop:settings.title',
      hintKey: 'shop:find.settingsHint',
      keywordsKey: 'shop:find.settingsKeywords',
      component: ShoppingSettings,
      order: 600,
      icon: 'bag',
      group: 'shopping',
    },
  ],
  onboardingSteps: [{ id: 'shop-country', order: 300, component: OnboardingShop }],
  messageBlockRenderers: { 'shop.product': ProductCard, 'shop.compare': CompareCard },
};
export default mod;
