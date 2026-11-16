/**
 * W9: build a 3-step workflow on the canvas page (transform → approval → output), run it, and approve it on a
 * phone-sized viewport; the run finishes and the page has no horizontal overflow or text under 12px at 390 px.
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

async function noOverflow(page: Page) {
  const o = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    vw: window.innerWidth,
    tiny: [...document.querySelectorAll('[data-testid="workflows-page"] *')].filter((el) => {
      const s = getComputedStyle(el);
      return (
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
        Number.parseFloat(s.fontSize) < 12
      );
    }).length,
  }));
  expect(o.doc, 'horizontal overflow').toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
}

test('workflows: build a 3-step flow with an approval, run it, approve on a phone', async ({
  page,
  server,
}) => {
  test.setTimeout(120_000);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  await page.goto(`${server.url}/#/workflows`);
  const pageEl = page.getByTestId('workflows-page');
  await expect(pageEl.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  await expect(pageEl.getByText('No workflows yet.')).toBeVisible();

  // build: each new step joins after the selected one
  await page.getByTestId('workflow-new').click();
  await page.getByLabel('Workflow name').fill('Pen order');
  await page.getByTestId('add-transform').click();
  const form = page.getByTestId('workflow-node-form');
  await form.getByLabel(/^Text/).fill('Order 12 pens');
  await page.getByTestId('add-approval').click();
  await form.getByLabel('What you are asked').fill('Send the order?');
  await page.getByTestId('add-output').click();
  await form.getByLabel('Title').fill('Order sent');
  await form.getByLabel(/^Text/).fill('{{input}} — done');
  // the canvas shows three steps joined by two links
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await noOverflow(page);
  await page.getByTestId('workflow-save').click();

  // run it
  const item = page.getByTestId('workflow-item');
  await expect(item).toContainText('Pen order');
  await expect(item).toContainText('3 steps');
  await item.getByRole('button', { name: 'Run' }).click();

  // approve on a phone-sized screen
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pageEl.getByRole('heading', { name: 'Waiting for you' })).toBeVisible({ timeout: 15_000 });
  const approval = page.getByTestId('workflow-approval');
  await expect(approval).toContainText('Send the order?');
  const approve = approval.getByRole('button', { name: 'Approve' });
  const box = (await approve.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await noOverflow(page);
  await approve.click();

  const done = page.locator('[data-testid="workflow-run"][data-state="done"]');
  await expect(done).toBeVisible({ timeout: 15_000 });
  await done.getByRole('button', { name: 'Show steps' }).click();
  await expect(done).toContainText('Order 12 pens — done');
  await noOverflow(page);
});
