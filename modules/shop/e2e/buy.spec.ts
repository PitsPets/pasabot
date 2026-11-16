/**
 * W30 Buy in real Chromium on the shared e2e server: a custom store on the local fixture store WITH cart hints. The
 * fixture's product pages carry a hidden card-number input in the add-to-cart form; that must not block "Add to
 * cart". After the owner approves 2, the quantity is in the fixture cart, the checkout page is handed over, and
 * "Place order" was clicked 0 times.
 */
import type { Page } from '@playwright/test';
import { type FixtureStore, startFixtureStore } from '../src/testing/fixture-store.js';
import { claimServer, createFakeAgent, expect, PASSWORD, send, test } from './fixtures.js';

const owner = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, {
        method,
        credentials: 'same-origin',
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    },
    { method, path, body },
  );
const probe = (page: Page, name: string, args: unknown) =>
  send(page, JSON.stringify({ probe: { name, args } }));

/** Owner, a Fake agent, the Cart Mart custom store (with cart hints) on the fixture store, and its kettle captured. */
async function cartMartKettle(page: Page, server: Parameters<typeof claimServer>[1]) {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  expect((await owner(page, 'PUT', '/api/m/browser/settings', { allowHosts: ['127.0.0.1'] })).status).toBe(
    200,
  );
  const added = await owner(page, 'POST', '/api/m/shop/custom-stores', {
    id: 'cart-mart',
    name: 'Cart Mart',
    homeUrl: `${fx.url}/`,
    searchUrl: `${fx.url}/search?q={query}`,
    allowedHosts: ['127.0.0.1'],
    currency: 'PHP',
    parsingHints: {
      prefer: ['json-ld', 'opengraph', 'microdata'],
      cart: { quantity: '#qty', addToCart: '#add', checkoutUrl: `${fx.url}/checkout` },
    },
  });
  expect(added.status, JSON.stringify(added.json)).toBe(200);

  await probe(page, 'shop_capture', { url: `${fx.url}/p/kettle` });
  const productId = await expect
    .poll(async () => ((await owner(page, 'GET', '/api/m/shop/products')).json.products ?? []).length, {
      timeout: 60_000,
    })
    .toBe(1)
    .then(
      async () => (await owner(page, 'GET', '/api/m/shop/products')).json.products[0].productId as string,
    );
  return productId;
}

let fx: FixtureStore;
test.beforeEach(async () => {
  fx = await startFixtureStore();
});
test.afterEach(async () => {
  await fx.close();
});

test('Buy 2 adds to the cart past a hidden card input and hands over; place order is never clicked', async ({
  page,
  server,
}, info) => {
  test.skip(info.project.name === 'phone', 'the cart flow is the same at every width');
  test.setTimeout(150_000);
  const productId = await cartMartKettle(page, server);

  await probe(page, 'shop_buy', { productId, quantity: 2 });
  const card = page.getByTestId('approval-card').last();
  await expect(card).toContainText('2 × Steel Kettle', { timeout: 20_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
  const reauth = page.getByRole('dialog', { name: "Confirm it's you" });
  if (await reauth.isVisible({ timeout: 3000 }).catch(() => false)) {
    await reauth.getByLabel('Password').fill(PASSWORD);
    await reauth.getByRole('button', { name: 'Confirm and approve' }).click();
  }
  await expect
    .poll(async () => ((await owner(page, 'GET', '/api/m/shop/orders')).json.orders ?? [])[0]?.state, {
      timeout: 60_000,
    })
    .toBe('handed-over');
  const order = (await owner(page, 'GET', '/api/m/shop/orders')).json.orders[0];
  expect(order).toMatchObject({ quantity: 2 });
  expect(fx.state.cart).toBe(2);
  expect(fx.state.placeOrderClicks).toBe(0);
  await expect(page.getByText('is in your cart at Cart Mart').first()).toBeVisible({ timeout: 20_000 });

  // Settings → Shopping lists the order: state, store, item, quantity, price as seen, time
  await page.goto(`${server.url}/#/settings/shopping/shop`);
  const row = page.getByTestId('shop-orders').getByTestId('shop-order').first();
  await expect(row).toHaveAttribute('data-state', 'handed-over');
  await expect(row).toContainText('2 × Steel Kettle');
  await expect(row).toContainText('Cart Mart');
  await expect(row).toContainText('1,299.00 each, as seen');
  await expect(row).toContainText('In your cart, yours to pay');
});

// QA W9: in one session, after a first approved Buy and a language change, a second Buy of the same product must
// raise its own fresh money card (never reuse the first approval) and reach the cart too. Before the fix the first
// hand-over marked the profile owner-driven and the second Buy failed after approval with English port text.
test('a second Buy in the same session, after a language switch, asks on a fresh card and reaches the cart', async ({
  page,
  server,
}, info) => {
  test.skip(info.project.name === 'phone', 'the cart flow is the same at every width');
  test.setTimeout(180_000);
  const productId = await cartMartKettle(page, server);
  const chat = page.url();
  const approve = async () => {
    const reauth = page.locator('dialog[open]');
    if (await reauth.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reauth.locator('input[type=password]').fill(PASSWORD);
      await reauth.locator('input[type=password]').press('Enter');
    }
  };
  const handedOver = async () =>
    ((await owner(page, 'GET', '/api/m/shop/orders')).json.orders ?? []).filter(
      (o: { state: string }) => o.state === 'handed-over',
    ).length;
  const cards = page.getByTestId('approval-card');

  await probe(page, 'shop_buy', { productId, quantity: 1 });
  await expect(cards.last()).toContainText('1 × Steel Kettle', { timeout: 20_000 });
  await cards.last().getByRole('button', { name: 'Approve' }).click();
  await approve();
  await expect.poll(handedOver, { timeout: 60_000 }).toBe(1);

  // switch the app to Japanese in Settings, come back to the same chat
  await page.goto(`${server.url}/#/settings/look/language`);
  await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption('ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.goto(chat);
  await expect(page.getByTestId('composer')).toBeVisible();
  const before = await cards.count();

  await probe(page, 'shop_buy', { productId, quantity: 1 });
  // a new card of its own: the first one stays decided above it
  await expect(cards).toHaveCount(before + 1, { timeout: 20_000 });
  const second = cards.last();
  await expect(second).toContainText('1 × Steel Kettle');
  await expect(second).toContainText('承認');
  await second.locator('.bk-ask__btns button').first().click();
  await approve();
  await expect.poll(handedOver, { timeout: 60_000 }).toBe(2);
  expect(fx.state.cart).toBe(2);
  expect(fx.state.placeOrderClicks).toBe(0);
  const orders = (await owner(page, 'GET', '/api/m/shop/orders')).json.orders as { state: string }[];
  expect(orders.filter((o) => o.state === 'failed')).toEqual([]);
});
