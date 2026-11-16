/**
 * W23 in a real browser (1440 and 390 px): Settings → Notifications turns push on for this device and saves its
 * choices (the browser's push service is replaced by a stub subscription, so no network is used: real delivery is
 * proven in Vitest against a mock push service); the app is installable (Chrome's own installability check over
 * CDP, the check behind the install prompt) and its offline shell opens without a network.
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

/** A stub PushManager: subscribe() returns a subscription on a known push service host with well-formed keys. */
async function stubPush(page: Page) {
  await page.addInitScript(() => {
    const b64u = (a: Uint8Array) =>
      btoa(String.fromCharCode(...a))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const p256dh = new Uint8Array(65);
    p256dh[0] = 4;
    crypto.getRandomValues(p256dh.subarray(1));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    let current: unknown = null;
    const sub = {
      endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${b64u(crypto.getRandomValues(new Uint8Array(8)))}`,
      toJSON() {
        return { endpoint: this.endpoint, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
      },
      async unsubscribe() {
        current = null;
        return true;
      },
    };
    Object.defineProperty(window.Notification, 'permission', { get: () => 'default', configurable: true });
    window.Notification.requestPermission = async () => 'granted';
    const pm = (window as unknown as { PushManager: { prototype: Record<string, unknown> } }).PushManager
      .prototype;
    pm.subscribe = async () => {
      current = sub;
      return sub;
    };
    pm.getSubscription = async () => current;
  });
}

test('turn on notifications for this device and choose what it gets', async ({ page, server }) => {
  await stubPush(page);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  await page.goto(`${server.url}/#/settings/people/push`);
  const card = page.getByTestId('push-settings');
  await expect(card).toBeVisible();
  await expect(card.getByText('Off', { exact: true })).toBeVisible();
  const on = card.getByRole('button', { name: 'Turn on notifications' });
  expect((await on.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await on.click();
  await expect(card.getByText('On', { exact: true })).toBeVisible();
  // defaults: approvals, errors, replies on; progress off
  await expect(card.getByLabel('An agent needs my OK')).toBeChecked();
  await expect(card.getByLabel('A long task is still running')).not.toBeChecked();
  await card.getByLabel('A long task is still running').click();
  await expect(card.getByLabel('A long task is still running')).toBeChecked();
  // the server has this device with that choice (and never sends its endpoint back)
  const subs = await page.evaluate(async () => (await fetch('/api/m/push/subscriptions')).json());
  expect(subs.subscriptions).toHaveLength(1);
  expect(subs.subscriptions[0].prefs.progress).toBe(true);
  expect(JSON.stringify(subs)).not.toContain('fcm.googleapis.com');
  // in Filipino too
  // the language lives in the account menu (on a phone, on the chats home); then back to this page
  const pickLang = async (code: string) => {
    const here = page.url();
    if (!(await page.locator('[data-testid="account-menu"]:visible').count()))
      await page.goto(here.replace(/#.*$/, '#/'));
    await page.locator('[data-testid="account-menu"]:visible').first().click();
    await page.locator('[data-testid="account-language"]:visible').first().click();
    await page.locator(`[role="menuitemradio"][lang="${code}"]:visible`).click();
    if (page.url() !== here) await page.goto(here);
  };
  await pickLang('fil');
  await expect(page.getByTestId('push-settings').getByText('Notifications sa device na ito')).toBeVisible();
  await pickLang('en');
  // turn off again
  await card.getByRole('button', { name: 'Turn off on this device' }).click();
  await expect(card.getByText('Off', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('the app is installable and its offline shell opens without a network', async ({
  page,
  server,
  context,
}) => {
  await claimServer(page, server);
  // the service worker takes control, then a reload caches the shell's files
  await page.goto(`${server.url}/#/`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.reload();
  await page.waitForLoadState('networkidle');

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string }[];
  };
  expect(installabilityErrors).toEqual([]);
  const manifest = (await cdp.send('Page.getAppManifest')) as { errors: unknown[]; url: string };
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toContain('/manifest.webmanifest');

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByTestId('offline-shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: "Can't reach PasaBot" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  } finally {
    await context.setOffline(false);
  }
  // back online: Try again returns to the app
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('offline-shell')).toHaveCount(0, { timeout: 15_000 });
});
