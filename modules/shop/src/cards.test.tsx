// @vitest-environment happy-dom
/**
 * W30 cards in the web renderer: `javascript:`, `data:` HTML and off-store hosts render no link and no image (a plain
 * placeholder instead, never the raw value), page text stays text, the price is formatted in the store's own
 * currency with "as seen at" the capture time, and a compare block shows 2–4 columns (never 1 or 5).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CompareCard, countryNames, ORDER_POLL_MS, OrdersList, ProductCard } from '../web/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  productId: 'p1',
  name: 'Steel Kettle <b>bold</b>',
  price: '1299.00',
  currency: 'PHP',
  store: 'Fixture Mart',
  hosts: ['shop.fixture.test', '*.img.fixture.test'],
  image: 'https://cdn.img.fixture.test/k.png',
  url: 'https://shop.fixture.test/p/kettle',
  rating: 4.6,
  ratingCount: 312,
  capturedAt: Date.UTC(2026, 10, 14, 2, 30),
};

function render(node: React.ReactNode) {
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => root.render(node));
  const out = {
    html: el.innerHTML,
    text: el.textContent ?? '',
    img: el.querySelector('img')?.getAttribute('src') ?? null,
    links: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    count: el.querySelectorAll('[data-testid="shop-compare-item"]').length,
  };
  act(() => root.unmount());
  return out;
}
const card = (data: object) =>
  render(<ProductCard block={{ kind: 'shop.product', v: 1, data: { ...base, ...data } }} />);

describe('shop.product card', () => {
  it('shows the facts as text, the image and link on the store hosts, and "as seen at"', () => {
    const r = card({});
    expect(r.img).toBe(base.image);
    expect(r.links).toEqual([base.url]);
    expect(r.text).toContain('Steel Kettle <b>bold</b>');
    expect(r.html).not.toContain('<b>bold</b>');
    expect(r.text).toContain('1,299.00');
    expect(r.text).toContain('as seen at');
    expect(r.text).toContain('Rated 4.6 from 312 ratings');
  });
  it('javascript:, data: HTML and off-store hosts render no link or image', () => {
    for (const bad of [
      { image: 'javascript:alert(1)', url: 'javascript:alert(1)' },
      { image: 'data:text/html,<script>alert(1)</script>', url: 'data:text/html,<script>alert(1)</script>' },
      { image: 'https://evil.example/x.png', url: 'https://evil.example/p' },
      { image: 'https://shop.fixture.test.evil.example/x.png', url: 'https://user:pw@evil.example/' },
    ]) {
      const r = card(bad);
      expect(r.img, JSON.stringify(bad)).toBeNull();
      expect(r.links, JSON.stringify(bad)).toEqual([]);
      expect(r.text).toContain('No picture');
      expect(r.html).not.toContain('alert(1)');
    }
  });
});

describe('shop.product card on a "*.shopee.ph" store', () => {
  it('look-alike and suffix-stuffed hosts get no link or image; the store and its subdomains do', () => {
    const shopee = { hosts: ['*.shopee.ph', 'shopee.ph'] };
    for (const host of ['evilshopee.ph', 'shopee.ph.evil.com', 'xshopee.ph']) {
      const r = card({ ...shopee, image: `https://${host}/x.png`, url: `https://${host}/p/1` });
      expect(r.img, host).toBeNull();
      expect(r.links, host).toEqual([]);
    }
    const ok = card({ ...shopee, image: 'https://cf.shopee.ph/x.png', url: 'https://shopee.ph/p/1' });
    expect(ok.img).toBe('https://cf.shopee.ph/x.png');
    expect(ok.links).toEqual(['https://shopee.ph/p/1']);
  });
});

describe('shop.compare card', () => {
  it('renders 2 to 4 products, nothing for 1 or 5', () => {
    const items = (n: number) => Array.from({ length: n }, (_, k) => ({ ...base, productId: `p${k}` }));
    const at = (n: number) =>
      render(<CompareCard block={{ kind: 'shop.compare', v: 1, data: { items: items(n) } }} />);
    expect(at(1).count).toBe(0);
    expect(at(2).count).toBe(2);
    expect(at(4).count).toBe(4);
    expect(at(5).count).toBe(0);
  });

  it('after the ask, the Buy card follows its order: it leaves "Waiting for your approval" once approved', async () => {
    const states = ['pending', 'running', 'handed-over'];
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const body = url.endsWith('/buy')
        ? { orderId: 'o1', approvalId: 'a1' }
        : { order: { id: 'o1', state: states.shift() ?? 'handed-over' } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const el = document.createElement('div');
    const root = createRoot(el);
    try {
      act(() => root.render(<ProductCard block={{ kind: 'shop.product', data: base } as never} />));
      const click = (label: RegExp) =>
        act(() => {
          [...el.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''))!.click();
        });
      click(/^Buy$/);
      click(/Ask to buy/);
      for (let i = 0; i < 5; i++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      const status = () => el.querySelector('[data-testid="shop-buy-state"]')!;
      expect(status().textContent).toContain('Waiting for your approval');
      for (const want of ['pending', 'running', 'handed-over']) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ORDER_POLL_MS);
        });
        expect(status().getAttribute('data-state')).toBe(want);
      }
      expect(status().textContent).not.toContain('Waiting for your approval');
      expect(status().textContent).toContain('in your cart');
      expect(seen).toContain('GET /api/m/shop/orders/o1');
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      globalThis.fetch = realFetch;
    }
  });
});

describe('Shop orders list', () => {
  it('lists each order from GET /orders: state, store, item, quantity, price as seen and time', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/m/shop/orders');
      return new Response(
        JSON.stringify({
          orders: [
            {
              id: 'o2',
              state: 'handed-over',
              quantity: 2,
              item: 'Steel Kettle <b>bold</b>',
              store: 'Fixture Mart',
              price: '1299.00',
              currency: 'PHP',
              createdAt: Date.UTC(2026, 10, 14, 2, 30),
            },
            {
              id: 'o1',
              state: 'denied',
              quantity: 1,
              item: null,
              store: null,
              price: null,
              currency: null,
              createdAt: 0,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const el = document.createElement('div');
      const root = createRoot(el);
      await act(async () => root.render(<OrdersList />));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      const rows = [...el.querySelectorAll('[data-testid="shop-order"]')];
      expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['handed-over', 'denied']);
      const first = rows[0]!.textContent ?? '';
      expect(first).toContain('2 × Steel Kettle <b>bold</b>');
      expect(first).toContain('Fixture Mart');
      expect(first).toContain('1,299.00 each, as seen');
      expect(first).toContain('In your cart, yours to pay');
      expect(first).toContain('2026');
      expect(el.innerHTML).not.toContain('<b>bold</b>');
      expect(rows[1]!.textContent).toContain('1 × A product no longer saved');
      expect(rows[1]!.textContent).toContain('You said no');
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Settings → Shopping country names', () => {
  const list = [
    { code: 'PH', name: 'Philippines' },
    { code: 'DE', name: 'Germany' },
    { code: 'JP', name: 'Japan' },
  ];
  it('names every country in the app language (Intl.DisplayNames), never the server English', () => {
    const de = countryNames(list, 'de');
    expect(de.map((c) => c.name)).toEqual(['Deutschland', 'Japan', 'Philippinen']);
    const ja = countryNames(list, 'ja');
    expect(ja.find((c) => c.code === 'DE')?.name).toBe('ドイツ');
    const ar = countryNames(list, 'ar');
    expect(ar.find((c) => c.code === 'PH')?.name).toBe('الفلبين');
    // Filipino CLDR names most countries as English does, so fil is checked only for its own sort order
    expect(countryNames(list, 'fil').map((c) => c.code)).toEqual(['DE', 'JP', 'PH']);
  });
  it('keeps the code and falls back to the server name for a code the runtime cannot name', () => {
    expect(countryNames([{ code: 'XX', name: 'Fixture Land' }], 'de')).toEqual([
      { code: 'XX', name: 'Fixture Land' },
    ]);
  });
});
