/**
 * The right-hand agent details (owner: "yung gilid ang daming nakalagay"), at 1440 px and 390 px: closed on first
 * use, opened by its own button in the chat header (a sheet on a phone) and remembered; short when open (avatar,
 * name, status, "What <name> does" in a sentence or two, the brain it thinks with, Edit / Change); everything else
 * behind one More. The built-in team builder's internal prompt never reaches the page; a helper's full instructions
 * sit folded under More in a box that scrolls inside. Screenshots go to `.qa/w22-side-*.png`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  answerTeamSetup,
  approveTeamSetup,
  QUICK_TEAM_ANSWERS,
  skipTeamSetup,
  startTeamSetup,
} from '../../../packages/testkit/src/e2e.js';
import { expect, PASSWORD, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
const shot = async (page: Page, name: string, w: string) => {
  mkdirSync(QA, { recursive: true });
  await page.screenshot({ path: `${QA}w22-side-${name}-${w}.png` });
};
const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );
/** the smallest font size of any visible text inside the panel */
const smallestText = (page: Page) =>
  page.getByTestId('details-panel').evaluate((root) => {
    let min = Infinity;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || el.closest('details:not([open]) > :not(summary)')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      min = Math.min(min, Number.parseFloat(getComputedStyle(el).fontSize));
    }
    return min;
  });
const en = JSON.parse(
  readFileSync(new URL('../../../modules/orchestrator/locales/en.json', import.meta.url), 'utf8'),
) as { summary: string; plan: { roles: { shop: { job: string } } } };
const PROMPT = readFileSync(
  new URL('../../../modules/orchestrator/prompts/team-builder.md', import.meta.url),
  'utf8',
);

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
});

test('details: closed first, its own header button, short, More holds the rest; no internal prompt', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  const toggle = page.getByTestId(phone ? 'phone-details-toggle' : 'details-toggle');
  const panel = page.getByTestId('details-panel');

  await page.goto(server.setupLink);
  await page.locator('input[autocomplete="name"]').fill('Liza');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  // the Stage first; "Skip for now" opens the team builder's chat
  await startTeamSetup(page);
  await skipTeamSetup(page);

  // first use: closed; one clear button in the header opens it (44 px, says whose details): an info button on a
  // wide screen, the agent's own name and face on a phone (no room there for one more icon)
  await expect(page.locator('aside.det')).toHaveCount(0);
  await expect(toggle).toHaveAccessibleName('About Tala');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const box = (await toggle.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'closed', w);
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // the team builder: a friendly line, never its internal prompt, nothing to edit
  await expect(panel.getByTestId('details-summary')).toHaveText(en.summary);
  await expect(panel.getByTestId('details-main')).toContainText('Fake');
  await expect(panel.getByTestId('details-edit')).toHaveCount(0);
  const more = panel.getByTestId('details-more');
  await expect(more).not.toHaveAttribute('open', '');
  await more.getByTestId('details-more-toggle').click();
  await expect(panel.getByTestId('details-instructions')).toHaveCount(0);
  const html = await page.content();
  for (const bit of [PROMPT.trim().slice(0, 60), 'orchestrator_answer', 'How the setup works'])
    expect(html).not.toContain(bit);
  const api = await page.evaluate(async () => (await fetch('/api/v1/agents')).text());
  expect(api).not.toContain('orchestrator_answer');
  expect(api).toContain(en.summary);
  await more.getByTestId('details-more-toggle').click();
  expect(await smallestText(page)).toBeGreaterThanOrEqual(12);
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'builder', w);

  // remembered: still open after a reload; Hide closes it and that is remembered too
  await page.reload();
  await expect(panel).toBeVisible();
  await panel.locator('[data-details-hide]').click();
  await expect(page.locator('aside.det')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('chat-log')).toBeVisible();
  await expect(page.locator('aside.det')).toHaveCount(0);

  // a helper: "what it does" is its job in a line; the full instructions wait under More and scroll inside
  await page.goto(`${page.url().replace(/#.*$/, '')}#/team-setup`);
  await answerTeamSetup(page, QUICK_TEAM_ANSWERS);
  await approveTeamSetup(page);
  await page.getByTestId('orch-team').getByTestId('orch-team-agent').first().click();
  await expect(page.getByTestId(phone ? 'phone-details-toggle' : 'details-toggle')).toHaveAccessibleName(
    'About Ligaya',
  );
  await toggle.click();
  await expect(panel.getByTestId('details-summary')).toHaveText(en.plan.roles.shop.job);
  await expect(panel.getByTestId('details-edit')).toBeVisible();
  await expect(panel.getByTestId('details-brain-change')).toBeVisible();
  // short by default: the instructions are not on screen until More is opened
  await expect(panel.getByTestId('details-instructions')).toBeHidden();
  expect(await smallestText(page)).toBeGreaterThanOrEqual(12);
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'helper', w);

  await panel.getByTestId('details-more-toggle').click();
  const instr = panel.getByTestId('details-instructions');
  await expect(instr).toBeVisible();
  await expect(instr).toContainText(en.plan.roles.shop.job);
  await expect(instr).toContainText('Reply in the language the person writes in');
  expect((await instr.boundingBox())!.height).toBeLessThanOrEqual(221);
  await expect(panel.getByTestId('details-backup')).toBeVisible();
  expect(await smallestText(page)).toBeGreaterThanOrEqual(12);
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'more', w);
});
