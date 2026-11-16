/**
 * W30 in the browser (1440 + 390 px) on the shared e2e server, whose real browser module (headless Chromium) reads
 * a local fixture store on 127.0.0.1 port 0: Settings → Shopping (country, store toggles, a custom store), product
 * cards captured by the Fake brain's tool calls, compare with 2 and 4 products, and the card's Buy button raising
 * the money card (what, store, price as seen, quantity). No side scroll, no text under 12 px, 44 px Buy and toggles.
 */
import type { Locator, Page } from '@playwright/test';
import { type FixtureStore, startFixtureStore } from '../src/testing/fixture-store.js';
import { claimServer, createFakeAgent, expect, fits, send, test } from './fixtures.js';

async function tall(l: Locator) {
  const box = await l.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
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

let fx: FixtureStore;
test.beforeEach(async () => {
  fx = await startFixtureStore();
});
test.afterEach(async () => {
  await fx.close();
});

test('shopping settings, product cards, compare 2 and 4, and the Buy card', async ({
  page,
  server,
}, info) => {
  test.setTimeout(150_000);
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();
  // the browser module may open the loopback fixture store (owner setting)
  expect((await owner(page, 'PUT', '/api/m/browser/settings', { allowHosts: ['127.0.0.1'] })).status).toBe(
    200,
  );

  // Settings → Shopping: pick a country, turn a store off, add a custom store
  await page.goto(`${server.url}/#/settings/shopping/shop`);
  const settings = page.getByTestId('shop-settings');
  await expect(settings.getByRole('heading', { name: 'Shopping' })).toBeVisible();
  await settings.getByLabel('Country').selectOption({ label: 'Philippines' });
  await expect(settings.getByText('TikTok Shop')).toBeVisible();
  const lazada = settings.getByTestId('shop-store-PH:lazada');
  await lazada.uncheck();
  await expect(lazada).not.toBeChecked();
  if (phone) await tall(lazada.locator('xpath=..'));
  await settings.getByRole('button', { name: 'Add a store' }).click();
  await settings.getByLabel('Store name').fill('Fixture Mart');
  await settings.getByLabel('Short id').fill('fixture-mart');
  await settings.getByLabel('Home page').fill(`${fx.url}/`);
  await settings.getByLabel('Search address').fill(`${fx.url}/search?q={query}`);
  await settings.getByLabel('Allowed addresses').fill('127.0.0.1');
  await settings.getByLabel('Currency').fill('PHP');
  await settings.getByRole('button', { name: 'Save store' }).click();
  await expect(settings.getByText('Your store')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('shop-store-PH:lazada')).not.toBeChecked();
  await expect(page.getByTestId('shop-store-custom:fixture-mart')).toBeChecked();
  await fits(page, '[data-testid="shop-settings"]');

  // the Fake brain captures four products through the real managed browser
  await page.goto(chatUrl);
  for (const p of ['kettle', 'mug', 'pan', 'tray'])
    await probe(page, 'shop_capture', { url: `${fx.url}/p/${p}` });
  const products = await expect
    .poll(async () => ((await owner(page, 'GET', '/api/m/shop/products')).json.products ?? []).length, {
      timeout: 60_000,
    })
    .toBe(4)
    .then(
      async () =>
        (await owner(page, 'GET', '/api/m/shop/products')).json.products as {
          productId: string;
          name: string;
        }[],
    );
  const id = (name: string) => products.find((p) => p.name === name)!.productId;

  await probe(page, 'shop_show', { productId: id('Steel Kettle') });
  const card = page.getByTestId('shop-card').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Steel Kettle');
  await expect(card.getByTestId('shop-price')).toContainText('1,299.00');
  await expect(card.getByTestId('shop-seen')).toContainText('as seen at');
  await expect(card).toContainText('Fixture Mart');
  await expect(card).toContainText('Rated 4.6 from 312 ratings');

  await probe(page, 'shop_compare', { productIds: [id('Steel Kettle'), id('Enamel Mug')] });
  await expect(page.getByTestId('shop-compare')).toHaveCount(1, { timeout: 20_000 });
  await probe(page, 'shop_compare', {
    productIds: [id('Steel Kettle'), id('Enamel Mug'), id('Cast Iron Pan'), id('Bamboo Tray')],
  });
  await expect(page.getByTestId('shop-compare')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('shop-compare').nth(0).getByTestId('shop-compare-item')).toHaveCount(2);
  await expect(page.getByTestId('shop-compare').nth(1).getByTestId('shop-compare-item')).toHaveCount(4);
  await fits(page, 'body');

  // Buy from the card: the money card, built by the server from the captured product
  const buy = card.getByRole('button', { name: 'Buy' });
  if (phone) await tall(buy);
  await buy.click();
  await card.getByRole('button', { name: 'One more' }).click();
  const ask = card.getByRole('button', { name: 'Ask to buy' });
  if (phone) await tall(ask);
  await ask.click();
  await expect(card.getByRole('status')).toContainText('Waiting for your approval');
  const bar = page.getByTestId('detached-decisions');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await bar.getByRole('button', { name: /Review/ }).click();
  const facts = page.getByTestId('approval-facts');
  await expect(facts).toContainText('2 × Steel Kettle');
  await expect(facts).toContainText('₱1,299.00 each, as seen at');
  await expect(facts).toContainText('Fixture Mart');
  await expect(facts).toContainText('₱2,598.00 as seen, not final');
  await fits(page, 'body');
  expect(fx.state.placeOrderClicks).toBe(0);
  expect(fx.state.cart).toBe(0);
});
