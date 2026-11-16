/**
 * The r6 picky list (W26), at 1440 px and 390 px, in Filipino (Taglish picked on the Stage): the look is Dark for a new
 * person; "what do you want help with" takes several answers and the plan holds a helper for each, every card's
 * reason starting with a capital; the plan's picks are whole short phrases ("Wala munang chat app"); once the team is
 * built the main helper's job line says what it does now; a handoff shows no raw tool result, no task id, no old name
 * and no English header (in the bubble, the chat list or Team talk; ids and JSON only with Technical words on); a
 * phone chat header gives the helper's name the room (the brain is its icon, Stop all only while working); Settings
 * says plain words for MCP servers and skills unless Technical words is on. Screenshots: `.qa/w26-<name>-<w>.png`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { stageStep, startTeamSetup } from '../../../packages/testkit/src/e2e.js';
import { done, expect, PASSWORD, script, send, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
type Loc = Record<string, any>;
const loc = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')) as Loc;
const orch = loc('modules/orchestrator/locales/fil.json');
const mcp = loc('modules/mcp/locales/fil.json');
const skills = loc('modules/skills/locales/fil.json');
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
const technical = (page: Page, value: boolean) =>
  page.evaluate(
    (v) =>
      fetch('/api/v1/me/prefs/ui.advanced', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: v }),
      }),
    value,
  );

test('r6 polish: dark Stage, several areas, plain picks, the lead’s job, plain handoffs, phone header, plain Settings', async ({
  page,
  server,
}, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  const shot = async (name: string) => {
    mkdirSync(QA, { recursive: true });
    await settle(page);
    await page.screenshot({ path: `${QA}w26-${name}-${w}.png` });
  };

  await page.goto(server.setupLink);
  await page.locator('input[autocomplete="name"]').fill('Liza');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await startTeamSetup(page);

  // 7. a new person sees the Dark look (the approved Stage), whatever the device's own setting
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(14, 23, 19)');
  await shot('stage-welcome');
  await page.getByTestId('stage-next').click();
  await stageStep(page, 'language').waitFor();
  await page.getByTestId('stage-lang-taglish').click();
  await page.getByTestId('stage-next').click();
  await stageStep(page, 'name').waitFor();
  await page.getByTestId('stage-name').fill('Mayumi');
  await page.getByTestId('stage-next').click();

  // 8. "what do you want help with": pick any number (checkboxes); the others take one
  const q = (qid: string) => page.locator(`[data-testid="stage"][data-step="question"][data-qid="${qid}"]`);
  await expect(q('help')).toBeVisible();
  const options = page.getByTestId('stage-options');
  await expect(options).toHaveAttribute('data-multi', 'true');
  await expect(options.locator('input[type="checkbox"]')).toHaveCount(4);
  await expect(page.locator('.stg-sub')).toHaveText(orch.stage.q.subMulti);
  await page.getByTestId('stage-option-shop').click();
  await page.getByTestId('stage-option-study').click();
  await expect(page.getByTestId('stage-option-shop').locator('input')).toBeChecked();
  await expect(page.getByTestId('stage-option-study').locator('input')).toBeChecked();
  // a second tap takes one back off
  await page.getByTestId('stage-option-home').click();
  await page.getByTestId('stage-option-home').click();
  await expect(page.getByTestId('stage-option-home').locator('input')).not.toBeChecked();
  expect(await noSideScroll(page)).toBe(true);
  await shot('stage-help-multi');
  await page.getByTestId('stage-next').click();
  await expect(q('people')).toBeVisible();
  await expect(page.getByTestId('stage-options').locator('input[type="radio"]')).toHaveCount(3);
  for (const [qid, option] of [
    ['people', 'solo'],
    ['chat', 'none'],
    ['email', 'skip'],
    ['askFirst', 'none'],
  ] as const) {
    await expect(q(qid)).toBeVisible();
    await page.getByTestId(`stage-option-${option}`).click();
    await page.getByTestId('stage-next').click();
  }

  // the plan: a helper for each area picked, each with its own reason (with a capital); 4. whole short phrases
  await expect(stageStep(page, 'plan')).toBeVisible();
  const cards = page.getByTestId('stage-plan-agent');
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId('stage-plan')).toContainText('Ligaya');
  await expect(page.getByTestId('stage-plan')).toContainText('Dalisay');
  await expect(page.getByTestId('stage-plan')).toContainText('Tanglaw');
  for (const why of await page.getByTestId('stage-plan-why').allTextContents())
    expect(why, 'a reason starts with a capital').toMatch(/^Kasi: \p{Lu}/u);
  const picks = page.getByTestId('stage-picks');
  for (const p of [
    orch.stage.plan.pick.language.replace('{{language}}', 'Taglish'),
    orch.stage.plan.pick.people.solo,
    orch.stage.plan.pick.chat.none,
    orch.stage.plan.pick.email.skip,
    orch.stage.plan.pick.askFirst.none,
  ])
    await expect(picks).toContainText(p);
  // never a bare "Hindi muna" / "Iyon lang" that does not say what it answers
  expect(await picks.locator('li').allTextContents()).not.toContain(orch.q.chat.options.none);
  expect(await picks.locator('li').allTextContents()).not.toContain(orch.q.askFirst.options.none);
  expect(await noSideScroll(page)).toBe(true);
  await shot('stage-plan');
  await page.getByTestId('stage-approve').click();
  // W40: the "needs your OK" screen comes first; Continue leaves the rest for later
  await expect(stageStep(page, 'oks')).toBeVisible();
  await page.getByTestId('stage-oks-finish').click();
  await expect(stageStep(page, 'done')).toBeVisible();
  await page.getByTestId('stage-open').click();
  await expect(page).toHaveURL(/#\/chats\//);
  const mainChat = page.url();

  // 3. the main helper's job line: what it does now (it leads the team), in the owner's language
  const toggle = page.getByTestId(phone ? 'phone-details-toggle' : 'details-toggle');
  await toggle.click();
  const panel = page.getByTestId('details-panel');
  await expect(panel.getByTestId('details-summary')).toHaveText(orch.summaryLead);
  await shot('side-panel');
  await toggle.click();
  await expect(panel).toHaveCount(0);

  // 5. the phone chat header: the name whole, the brain as its icon, Stop all only while a helper works
  if (phone) {
    const top = page.locator('.ptop--chat');
    const name = top.locator('.ptop-name b');
    await expect(name).toHaveText('Mayumi');
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const pill = (await top.getByTestId('model-pill').boundingBox())!;
    expect(pill.width).toBeLessThanOrEqual(46);
    await expect(top.getByTestId('model-pill')).toHaveAccessibleName(/\S/);
    await expect(top.getByTestId('stop-all')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);
    await shot('phone-header');
    await send(page, script([{ after: 2500, event: { type: 'text.final', text: 'tapos na' } }, done]));
    await expect(top.getByTestId('stop-all')).toBeVisible();
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shot('phone-header-working');
    await expect(top.getByTestId('stop-all')).toHaveCount(0, { timeout: 15_000 });
  }

  // 1 + 2. Mayumi hands work to Dalisay: one plain line; no raw tool result, task id, old name or English header
  await send(
    page,
    probe('collab_delegate', {
      to: 'Dalisay',
      task: 'Ilista ang mga order ngayong araw',
      wait: true,
      timeoutSec: 30,
    }),
  );
  const handed = page
    .getByTestId('msg-agent')
    .filter({ has: page.getByTestId('handoff') })
    .last();
  await expect(handed.getByTestId('handoff-reply')).toBeAttached({ timeout: 30_000 });
  for (const bad of ['tool said', 'taskId', 'Task from agent', 'Task id', '(tala)'])
    await expect(handed).not.toContainText(bad);
  await handed.getByTestId('handoff').locator('summary').click();
  await expect(handed.getByTestId('handoff-reply')).toContainText('Ilista ang mga order ngayong araw');
  await expect(handed.getByTestId('handoff-reply')).not.toContainText(/01[0-9A-Z]{24}/);
  await shot('delegation');

  // the chat list: Mayumi's and Dalisay's previews speak plainly (no Team talk list any more: the request is a
  // thread in Dalisay's own chat), with the helpers' names as they are now
  if (phone) await page.goto(mainChat.replace(/#.*$/, '#/'));
  const list = page.locator('[data-testid="chats-list"]:visible');
  await expect(list).toBeVisible();
  const mine = list.getByTestId('roster-agent').filter({ hasText: 'Mayumi' }).first();
  await expect(mine.getByTestId('chat-preview')).toBeVisible();
  // no raw tool result (its shape: the handoff's task id); the owner's own words (here the test's JSON probe) may show
  await expect(mine.getByTestId('chat-preview')).not.toContainText('taskId');
  await expect(mine.getByTestId('chat-preview')).not.toContainText('tool said');
  await expect(list.getByTestId('team-talk-toggle')).toHaveCount(0);
  const row = list.getByTestId('roster-agent').filter({ has: page.locator('.n', { hasText: /^Dalisay$/ }) });
  await expect(row).toContainText('Ilista ang mga order');
  for (const bad of ['Task from agent', 'Task id', 'tala', 'not an order'])
    await expect(row).not.toContainText(bad);
  expect(await noSideScroll(page)).toBe(true);
  await shot('team-talk');
  await row.click();
  const thread = page.getByTestId('thread').first();
  await expect(thread.getByTestId('thread-from')).toContainText('Mayumi');
  await expect(thread.getByTestId('thread-ask')).toContainText('Ilista ang mga order ngayong araw');
  const first = thread.getByTestId('msg-agent').first();
  await expect(first).toContainText('Ilista ang mga order ngayong araw');
  for (const bad of ['Task from agent', 'Task id', '(tala)']) await expect(thread).not.toContainText(bad);
  await shot('team-talk-open');

  // ids and the raw result come back only with Technical words on
  await technical(page, true);
  await page.goto(mainChat);
  await page.reload();
  await expect(
    page
      .getByTestId('msg-agent')
      .filter({ has: page.getByTestId('handoff') })
      .last(),
  ).toContainText('taskId');
  await technical(page, false);

  // 6. Settings: plain words for MCP servers and skills; the technical names with Technical words on
  await page.goto(mainChat.replace(/#.*$/, '#/settings/tools'));
  await page.reload();
  const tools = page.getByTestId('settings-page-tools');
  await expect(tools.getByTestId('feature-mcp')).toContainText(mcp.plain.nav);
  await expect(tools.getByTestId('feature-mcp')).toContainText(mcp.plain.find.navHint);
  await expect(tools.getByTestId('feature-skills')).toContainText(skills.plain.nav);
  await expect(tools).not.toContainText('MCP');
  expect(await noSideScroll(page)).toBe(true);
  await shot('settings-tools');
  await technical(page, true);
  await page.reload();
  await expect(tools.getByTestId('feature-mcp')).toContainText(mcp.nav);
  await expect(tools.getByTestId('feature-skills')).toContainText(skills.nav);
  await shot('settings-tools-technical');
  await technical(page, false);
});
