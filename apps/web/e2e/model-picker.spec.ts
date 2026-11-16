/**
 * Simplify: the model picker. Brain is a set of radio cards; under the chosen brain the Model list shows what that
 * brain really offers now (the Fake brain lists two test models), each with a plain hint, a tick on the chosen one,
 * and "Automatic" (the brain's own default) ticked for a first-timer. The details panel's Brain card changes it in
 * place. Runs at 1200 px and 390 px, in English, Filipino and Arabic.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { openMoreOptions, pickModel } from '../../../packages/testkit/src/e2e.js';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

type Agents = {
  modelAuto: string;
  modelHints: Record<string, string>;
  modelsRefresh: string;
};
const bundle = (lng: string) =>
  JSON.parse(readFileSync(new URL(`../locales/${lng}.json`, import.meta.url), 'utf8')) as {
    agents: Agents;
    plain: { agents: Agents };
  };
const web = (lng: string) => bundle(lng).agents;
/** with the Settings "Advanced" switch off (the default) a technical label reads its plain glossary words */
const plain = (lng: string) => bundle(lng).plain.agents;

const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );
/** the smallest font size of any visible element that holds text inside `sel` */
const smallestText = (page: Page, sel: string) =>
  page.evaluate((s) => {
    let min = 99;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${s} *`))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!own || !el.offsetParent) continue;
      min = Math.min(min, Number.parseFloat(getComputedStyle(el).fontSize));
    }
    return min;
  }, sel);
/** every radio card / model row is at least 44 px tall (tap target) */
const shortestRow = (page: Page) =>
  page.evaluate(() =>
    Math.min(
      ...Array.from(document.querySelectorAll<HTMLElement>('.brain-card, .model-row')).map(
        (e) => e.getBoundingClientRect().height,
      ),
    ),
  );

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1200, height: 800 });
});

test('the agent form lists the brain models with hints and a tick; the choice is saved and changed in the details panel', async ({
  page,
  server,
}, info) => {
  await claimServer(page, server);
  const form = page.locator('form');
  // the only (ready) brain is chosen, as a checked card
  await expect(page.getByTestId('brain-option-fake').getByRole('radio')).toBeChecked();
  const models = page.getByTestId('model-picker');
  // the model sits under the closed "More options"
  await expect(models).toBeHidden();
  await openMoreOptions(page);
  // Automatic first and ticked; then what the brain offers, each with its plain hint
  await expect(models.getByTestId('model-option-auto').getByRole('radio')).toBeChecked();
  await expect(models.getByTestId('model-option-fake-quick')).toContainText('Quick (test)');
  await expect(models.getByTestId('model-option-fake-quick')).toContainText('Fast');
  await expect(models.getByTestId('model-option-fake-deep')).toContainText('Smartest');
  await pickModel(page, 'fake-deep');
  await expect(models.getByTestId('model-option-fake-deep').getByRole('radio')).toBeChecked();
  await expect(models.getByTestId('model-option-fake-deep').locator('svg')).toHaveCount(1);
  await expect(models.getByTestId('model-option-auto').locator('svg')).toHaveCount(0);
  // Refresh asks the brain again and keeps the tick
  await models.getByRole('button', { name: 'Check for new versions' }).click();
  await expect(models.getByTestId('model-option-fake-deep').getByRole('radio')).toBeChecked();
  expect(await noSideScroll(page)).toBe(true);
  expect(await smallestText(page, 'form')).toBeGreaterThanOrEqual(12);
  if (info.project.name === 'phone') expect(await shortestRow(page)).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`agent-form-${info.project.name}.png`), fullPage: true });
  await form.getByLabel('Name', { exact: true }).fill('Tala');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();

  // the details panel says Main and Backup, and Change opens the same picker in place
  // the header's agent button opens the details panel (a side panel at 1200 px, a sheet on the phone)
  const brain = page.getByTestId('details-brain');
  if (info.project.name === 'phone') await page.getByRole('button', { name: /Tala/ }).first().click();
  else if (!(await brain.isVisible()))
    await page.getByRole('region', { name: 'Tala' }).getByRole('button', { name: /Tala/ }).first().click();
  await expect(brain).toBeVisible();
  // the model as the brain names it, never its raw id (qa-a 4)
  await expect(brain.getByTestId('details-main')).toContainText('Deep (test)');
  await expect(brain.getByTestId('details-main')).not.toContainText('fake-deep');
  await brain.getByTestId('details-brain-change').click();
  const inline = brain.getByTestId('details-brain-picker');
  await expect(inline.getByTestId('model-option-fake-deep').getByRole('radio')).toBeChecked();
  await inline.getByTestId('model-option-fake-quick').click();
  await inline.getByRole('button', { name: 'Save' }).click();
  await expect(inline).toHaveCount(0);
  await expect(brain.getByTestId('details-main')).toContainText('Quick (test)');
  expect(await noSideScroll(page)).toBe(true);
});

for (const lng of ['fil', 'ar'] as const)
  test(`${lng}: the model picker reads in the app language and fits`, async ({ page, server }, info) => {
    const t = web(lng);
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await page.goto(`${server.url}/#/settings/look/language`);
    await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
    await expect(page.locator('html')).toHaveAttribute('lang', lng);
    await page.goto(`${server.url}/#/agents/new`);
    await expect(page.getByTestId('agent-form')).toBeVisible();
    await openMoreOptions(page);
    const models = page.getByTestId('model-picker');
    await expect(models.getByTestId('model-option-auto')).toContainText(t.modelAuto);
    await expect(models.getByTestId('model-option-fake-quick')).toContainText(t.modelHints.fast!);
    await expect(models.getByTestId('model-option-fake-deep')).toContainText(t.modelHints.smartest!);
    await expect(models.getByRole('button', { name: plain(lng).modelsRefresh })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    expect(await smallestText(page, 'form')).toBeGreaterThanOrEqual(12);
    await page.screenshot({
      path: info.outputPath(`agent-form-${lng}-${info.project.name}.png`),
      fullPage: true,
    });
  });
