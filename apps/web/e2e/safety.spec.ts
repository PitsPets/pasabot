/**
 * W31 at 1440 and 390 px: the top-bar stop on chat, settings and a module page (44 px target), the report sheet,
 * resume with the owner's password, and the receipt timeline scrubber. No horizontal scroll, no text under 12 px.
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, PASSWORD, send, test } from './fixtures.js';

const stopButton = (page: Page, phone: boolean) =>
  page.locator(phone ? '.ptop' : '.top').getByTestId('stop-all');

async function layoutChecks(page: Page, root: string, phone: boolean) {
  const o = await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...el.querySelectorAll('*')].filter((x) => {
        const s = getComputedStyle(x);
        return x.childNodes.length > 0 && x.textContent?.trim() && Number.parseFloat(s.fontSize) < 12;
      }).length,
      small: [...el.querySelectorAll('button, input, a.bk-btn')]
        .map((x) => x.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height < 44).length,
    };
  }, root);
  expect(o.doc, 'horizontal overflow').toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
  if (phone) expect(o.small, 'tap targets under 44px').toBe(0);
}

test('top-bar stop on every screen, the report, and resume with the password', async ({
  page,
  server,
}, info) => {
  test.setTimeout(90_000);
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();

  for (const hash of ['', '#/settings', '#/safety']) {
    if (hash) await page.goto(chatUrl.replace(/#.*$/, hash));
    // a phone chat's header gives the helper's name the room: Stop all shows there only while a helper works (W26)
    if (phone && !hash) {
      await expect(page.locator('.ptop--chat .ptop-name')).toBeVisible();
      await expect(stopButton(page, phone)).toHaveCount(0);
      continue;
    }
    const b = stopButton(page, phone);
    await expect(b).toBeVisible();
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }

  await stopButton(page, phone).click();
  const report = page.locator('dialog[open]').getByTestId('stop-report');
  await expect(report).toBeVisible();
  await expect(report).toContainText('Nothing will run until you press Start again.');
  await expect(report).toContainText('Stopped by you');
  await layoutChecks(page, 'dialog[open]', phone);
  await report.getByRole('button', { name: 'OK' }).click();
  await expect(report).toBeHidden();

  // paused: a "Paused" chip that is not a button plus one Start again (phone: one 44 px play button); the chat says
  // so above the box and Send waits, even after a reload
  const bar = page.locator(phone ? '.ptop' : '.top');
  if (!phone) {
    await expect(bar.getByTestId('stopped-pill')).toHaveText('Paused');
    expect(await bar.getByTestId('stopped-pill').evaluate((e) => e.tagName)).toBe('SPAN');
    await expect(bar.getByRole('button', { name: 'Start again' })).toHaveCount(1);
  } else await expect(bar.getByRole('button', { name: /Start again/ })).toHaveCount(1);
  await page.goto(chatUrl);
  await page.reload();
  const banner = page.getByTestId('paused-banner');
  await expect(banner).toContainText('Everything is paused');
  await expect(banner).toContainText('Start again to send.');
  // the empty chat's starter ideas would send a message: they wait too
  await expect(page.getByTestId('starter-can')).toBeDisabled();
  await page.getByTestId('composer').fill('hello?');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await banner.getByRole('button', { name: 'Start again' }).click();

  const form = page.locator('dialog[open]').getByTestId('resume-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Password').fill('not-the-password');
  await form.getByRole('button', { name: 'Start again' }).click();
  await expect(form).toContainText('That password is not right.');
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Start again' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('starter-can')).toBeEnabled();
  if (phone) await expect(stopButton(page, phone)).toHaveCount(0);
  else await expect(stopButton(page, phone)).toBeVisible();
  await expect(page.locator(phone ? '.ptop' : '.top').getByTestId('stopped-pill')).toHaveCount(0);
});

test('a chat turn leaves a receipt; the timeline scrubber walks its steps', async ({
  page,
  server,
}, info) => {
  test.setTimeout(90_000);
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();
  // a price for the Fake brain, so the budget books a cost the receipt records (W32)
  const priced = await page.evaluate(async () => {
    const r = await fetch('/api/m/budget/prices', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: 'fake',
        model: '',
        inputPerM: 1000,
        outputPerM: 2000,
        cachedPerM: 0,
        currency: 'PHP',
      }),
    });
    return r.status;
  });
  expect(priced).toBe(200);
  await send(page, 'hello receipts');
  await expect(page.getByText('hello receipts').last()).toBeVisible();
  // wait for the reply to finish before reading the receipt
  await page.waitForTimeout(500);

  await page.goto(chatUrl.replace(/#.*$/, '#/safety'));
  const pageEl = page.getByTestId('safety-page');
  await expect(pageEl.getByRole('heading', { name: 'Safety', level: 1 })).toBeVisible();
  const first = pageEl.getByTestId('receipt-list').getByRole('button').first();
  await expect(first).toBeVisible();
  await first.click();
  const detail = page.getByTestId('receipt-detail');
  await expect(detail).toBeVisible();
  // the title names the queue kind in the app language, never the raw code
  await expect(detail.getByRole('heading', { level: 2 }).first()).toHaveText(/^Message · /);
  const scrub = detail.getByTestId('timeline-scrubber');
  await expect(scrub).toBeVisible();
  // the recorded cost and its currency, small, in the summary line
  await expect(detail.getByTestId('receipt-cost')).toHaveText(/^ · Cost [\d.,]+ PHP$/);
  const current = detail.getByTestId('timeline-current');
  await expect(current).toContainText('Finished');
  await scrub.fill('0');
  await expect(current).toContainText('Started');
  await expect(current).toContainText('Step 1 of');
  await layoutChecks(page, '[data-testid="safety-page"]', phone);

  await detail.getByRole('button', { name: 'Export' }).click();
  await expect(detail.getByRole('link', { name: 'Download JSON' })).toBeVisible();
  const html = await detail.getByRole('link', { name: 'Open readable copy' }).getAttribute('href');
  // the readable copy is on the separate sites origin, never the app's
  expect(new URL(html!).origin).not.toBe(new URL(server.url).origin);
});
