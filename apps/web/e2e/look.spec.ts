/**
 * Polish direction B (ws/look), at 1200 px and 390 px: brains show their icon tile, never letters; the chat
 * header's model picker opens in one tap (a popover under the pill, a bottom sheet on a phone), lists Automatic
 * first with the brain's models and a tick, saves a pick on the agent and closes; the keyboard works (arrows,
 * Enter, Escape back to the pill); Settings lists every group in three sections. Screenshots go to
 * `.qa/w17-look-*.png`.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, expectAllSettingsGroups, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
const shot = async (page: Page, name: string, w: string) => {
  mkdirSync(QA, { recursive: true });
  await page.screenshot({ path: `${QA}w17-look-${name}-${w}.png` });
};
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeEach(async ({ page }, info) => {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1200, height: 800 });
});

test('model picker in the chat header: one tap, Automatic first, a tick, saved on the agent', async ({
  page,
  server,
}, info) => {
  const w = info.project.name === 'phone' ? '390' : '1200';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const pill = page.locator('[data-testid="model-pill"]:visible');
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveAccessibleName(/Tala thinks with .*Automatic\. Change/);
  // its brain's icon tile, never a letter monogram
  await expect(pill.locator('.bk-brand-tile')).toHaveAttribute('aria-hidden', 'true');
  await shot(page, 'chat', w);

  await pill.click();
  const pop = page.getByTestId('model-popover');
  await expect(pop).toBeVisible();
  await expect(pop.getByRole('heading', { name: 'How should Tala think?' })).toBeVisible();
  const list = pop.getByRole('listbox');
  await expect(list).toBeFocused();
  const rows = list.getByRole('option');
  await expect(rows.first()).toContainText('Automatic');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await expect(list.getByTestId('model-row-fake-deep')).toContainText('Deep (test)');
  await expect(list.getByTestId('model-row-fake-deep')).toContainText('Smartest, for hard work');
  if (w === '390') {
    // a bottom sheet over a scrim, its rows at least 44 px tall
    const box = (await pop.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(843);
    for (const h of await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height)))
      expect(h).toBeGreaterThanOrEqual(44);
  }
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'model-picker', w);

  // Escape closes and gives focus back to the pill
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(pill).toBeFocused();

  // keyboard: Enter opens, arrows move, Enter picks, saves and closes
  await page.keyboard.press('Enter');
  await expect(list).toBeFocused();
  await expect(list.getByTestId('model-row-fake-deep')).toBeVisible();
  const deepAt = await rows.evaluateAll((els) =>
    els.findIndex((e) => e.textContent?.includes('Deep (test)')),
  );
  for (let i = 0; i < deepAt; i++) await page.keyboard.press('ArrowDown');
  await expect(list).toHaveAttribute('aria-activedescendant', /.+/);
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/v1/agents/') && r.request().method() === 'PATCH',
  );
  await page.keyboard.press('Enter');
  expect((await saved).ok()).toBe(true);
  await expect(pop).toHaveCount(0);
  await expect(pill).toHaveAccessibleName(/Deep \(test\)\. Change/);
  // the choice is on the agent: it survives a reload, and the tick moved
  await page.reload();
  await page.locator('[data-testid="model-pill"]:visible').click();
  await expect(page.getByTestId('model-row-fake-deep')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('model-row-auto')).toHaveAttribute('aria-selected', 'false');
  // one tap on a row picks it (no Done button)
  await page.getByTestId('model-row-auto').click();
  await expect(page.getByTestId('model-popover')).toHaveCount(0);
  await expect(page.locator('[data-testid="model-pill"]:visible')).toHaveAccessibleName(/Automatic\. Change/);
});

test("model picker: when the brain's list fails, the saved model stays ticked and nothing clears it", async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const pill = page.locator('[data-testid="model-pill"]:visible');
  await pill.click();
  await page.getByTestId('model-row-fake-deep').click();
  await expect(pill).toHaveAccessibleName(/Deep \(test\)\. Change/);
  // the brain's model list now fails
  const models = '**/api/v1/providers/fake/models*';
  await page.route(models, (r) => r.fulfill({ status: 500, body: '{}' }));
  await page.reload();
  await page.locator('[data-testid="model-pill"]:visible').click();
  const pop = page.getByTestId('model-popover');
  await expect(pop.getByTestId('model-list-error')).toContainText("Couldn't load the list of models.");
  await expect(pop.getByTestId('model-row-fake-deep')).toHaveAttribute('aria-selected', 'true');
  // no "Automatic" to tap by mistake: it would clear the saved model without the list to show what it replaces
  await expect(pop.getByTestId('model-row-auto')).toHaveCount(0);
  // Try again asks once more; with the list back, every row is offered again and the tick stays
  await page.unroute(models);
  await pop.getByTestId('model-list-retry').click();
  await expect(pop.getByTestId('model-row-auto')).toBeVisible();
  await expect(pop.getByTestId('model-list-error')).toHaveCount(0);
  await expect(pop.getByTestId('model-row-fake-deep')).toHaveAttribute('aria-selected', 'true');
  expect(await noSideScroll(page)).toBe(true);
});

test('brains, settings and details in direction B (screenshots)', async ({ page, server }, info) => {
  const w = info.project.name === 'phone' ? '390' : '1200';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');

  // the agent's details: one card
  await page.locator('.ch-who:visible, .ptop-who:visible').first().click();
  await expect(page.getByTestId('details-panel')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'details', w);

  // the Brains page: the brain in use first, every brain with its icon tile (no letters)
  await page.goto(`${server.url}/#/settings/agents/brains`);
  const hero = page.locator('[data-testid="brain-tile"][data-hero="true"]');
  await expect(hero).toHaveAttribute('data-brain', 'fake');
  await expect(hero).toContainText('In use: Fake');
  await expect(
    page.locator('[data-testid="brain-tile"][data-brain="claude"] .bk-brand-tile'),
  ).toHaveAttribute('data-mark', 'claude');
  await expect(
    page.locator('[data-testid="brain-tile"][data-brain="gemini"] .bk-brand-tile'),
  ).toHaveAttribute('data-mark', 'gemini');
  await expect(page.locator('[data-testid="brain-tile"][data-brain="claude"]')).toContainText(
    'Not on this computer',
  );
  // no version numbers unless Technical words is on
  await expect(page.getByTestId('brains-page')).not.toContainText(/\bv\d+\.\d+/);
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'brains', w);

  // Settings: three sections, all groups, Technical words with a visible Off
  await page.goto(`${server.url}/#/settings`);
  const home = page.getByTestId('settings-home-groups');
  await expect(home.locator('.set-sec')).toHaveCount(3);
  await expectAllSettingsGroups(home);
  await expect(page.getByTestId('settings-advanced')).toContainText('Off');
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'settings', w);
});
