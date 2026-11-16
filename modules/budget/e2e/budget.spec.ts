/**
 * W32 in the browser (1440 + 390 px): the owner sees an unpriced model as "price not set", edits the price table,
 * sets an agent's daily cap on the Budget page; the next message waits behind the cap and a raise/keep card shows
 * in the chat and in the one pinned decision bar on every screen (W39); raising it from the bar's Review list lets the
 * waiting message run. The spending panel follows a saved price without a reload (W39). Then the agent is exported as an encrypted
 * file and imported back as a new agent. No side scroll, no text under 12 px, 44 px tap targets on the phone.
 */
import type { Locator, Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, fits, send, test } from './fixtures.js';

async function tall(l: Locator) {
  const box = await l.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
/** Settings › Spending › Budget (nothing is pinned to the sidebar by default) */
async function openBudget(page: Page, url: string) {
  await page.goto(`${url}/#/settings/spending`);
  await page.getByTestId('feature-budget').getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Budget', level: 1 })).toBeVisible();
}

test('price table, a cap card in the chat, raise from the card, and an encrypted agent file', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();
  await send(page, 'hello');
  await expect(page.getByTestId('msg-agent').first()).toContainText('echo: hello', { timeout: 15_000 });

  // the model the agent used is listed without a price, never guessed
  await openBudget(page, server.url);
  const spend = page.getByTestId('budget-spend');
  await expect(spend.getByTestId('budget-model').first()).toContainText('price not set');
  const price = page.getByTestId('budget-prices').getByTestId('budget-price').first();
  await expect(price).toContainText('price not set');
  // R7 review: a total of nothing still says its currency, never a bare 0
  await expect(page.getByTestId('budget-total')).toHaveText(/: \$0\.00$/);
  // "Add a version" is a live button: pressed with no brain named, it says so next to that field and adds nothing
  const prices = page.getByTestId('budget-prices');
  const before = await prices.getByTestId('budget-price').count();
  await prices.getByRole('button', { name: 'Add a version' }).click();
  await expect(prices.getByText("Write the brain's name first", { exact: true })).toBeVisible();
  await expect(prices.getByTestId('budget-price')).toHaveCount(before);
  await price.getByLabel('Input').fill('100000');
  await price.getByLabel('Output').fill('100000');
  await price.getByLabel('Cached').fill('0');
  const save = price.getByRole('button', { name: /^Save price/ });
  if (phone) await tall(save);
  await save.click();
  await expect(price).toContainText('Price saved.');
  await expect(price).not.toContainText('price not set');
  await fits(page, '[data-slot="route"]');

  // W39: the spending panel follows the saved price at once, no reload
  await expect(page.getByTestId('budget-total')).toContainText('$0.70');
  await expect(spend.getByTestId('budget-model').first()).not.toContainText('price not set');
  // a daily cap for Tala below what it already spent (5 + 2 tokens at 0.1 USD each = 0.7 USD)
  const caps = page.getByTestId('budget-caps');
  const talaCap = caps.getByTestId('budget-cap').filter({ hasText: 'Tala' });
  await talaCap.getByLabel(/^Per day/).fill('0.5');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect(caps).toContainText('Caps saved.');
  await expect(caps.getByTestId('budget-cap').filter({ hasText: 'Tala' })).toContainText('0.7 of 0.5 USD');

  // the next message waits behind the cap; the card asks to raise or keep
  await page.goto(chatUrl);
  await send(page, 'again');
  const card = page.getByTestId('budget-cap-card').last();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('Tala reached the daily budget: 0.7 of 0.5 USD.');
  await expect(card).toContainText('New work waits');
  const raise = card.getByRole('button', { name: 'Raise cap' });
  const keep = card.getByRole('button', { name: 'Keep cap' });
  if (phone) {
    await tall(raise);
    await tall(keep);
  }
  await fits(page, '[data-testid="budget-cap-card"]');
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'echo: again' })).toHaveCount(0);

  // W39: the same decision is pinned in the one decision bar, on every screen, and answered from its Review list
  const bar = page.getByTestId('detached-decisions');
  await expect(bar.getByTestId('decision-bar')).toContainText('1 decision waiting');
  await expect(page.getByTestId('decision-bar')).toHaveCount(1);
  await openBudget(page, server.url);
  await expect(bar.getByTestId('decision-bar')).toContainText('1 decision waiting');
  if (!phone) await expect(bar).toContainText('Tala reached the daily budget');
  const review = bar.getByRole('button', { name: 'Review' });
  if (phone) await tall(review);
  await review.click();
  const sheet = page.getByRole('dialog', { name: 'Review' });
  const sheetCard = sheet.getByTestId('budget-cap-card');
  await expect(sheetCard).toContainText('Tala reached the daily budget: 0.7 of 0.5 USD.');
  await page.screenshot({
    path: info.outputPath(`decision-review-${info.project.name}.png`),
    fullPage: true,
  });
  await fits(page, '[data-testid="decision-review"]');
  await sheetCard.getByLabel(/^New cap/).fill('5');
  await sheetCard.getByRole('button', { name: 'Raise cap' }).click();
  await expect(bar).toHaveCount(0);
  await page.goto(chatUrl);
  await expect(card).toHaveAttribute('data-state', 'raised');
  await expect(card).toContainText('Cap raised to 5 USD.');
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'echo: again' })).toBeVisible({
    timeout: 15_000,
  });

  // move the agent: an encrypted file, imported back as a new agent
  await openBudget(page, server.url);
  const bundle = page.getByTestId('budget-bundle');
  await bundle.getByLabel('Passphrase').first().fill('lihim na passphrase');
  const dl = page.waitForEvent('download');
  await bundle.getByRole('button', { name: 'Download encrypted file' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.pasabot-agent$/);
  await expect(bundle.getByTestId('bundle-export-status')).toContainText('File downloaded.');
  await bundle.getByLabel('Helper file').setInputFiles((await file.path())!);
  await bundle.getByLabel('Passphrase').last().fill('wrong passphrase!');
  await bundle.getByRole('button', { name: 'Bring in as a new helper' }).click();
  await expect(bundle.getByTestId('bundle-import-status')).toContainText('Wrong passphrase');
  await bundle.getByLabel('Passphrase').last().fill('lihim na passphrase');
  await bundle.getByRole('button', { name: 'Bring in as a new helper' }).click();
  await expect(bundle.getByTestId('bundle-import-status')).toContainText('Imported as Tala (2).');
  await fits(page, '[data-slot="route"]');
  await bundle.getByRole('link', { name: 'Open its chat' }).click();
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'echo: hello' }).first()).toBeVisible();
});
