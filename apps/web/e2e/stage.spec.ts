/**
 * The team builder's Stage (onboarding direction A, owner-approved 2026-11-15), at 1440 px and 390 px, in English
 * and Filipino: claim -> "Pick a brain" -> the Stage, full screen (no chats list, no side panel): hello -> language
 * (the app's language switches at once) -> name the main helper (its face follows the name) -> the five questions
 * (taps and own words) -> the plan (helpers arrive one by one) -> Approve -> done -> the app, the main helper pinned
 * first with one short summary in its chat. Also: Back on every step, a reload resumes at the same step, skip keeps
 * it for later and Settings picks it up again, "Set up my team again" starts a new round and keeps the helpers, a
 * slow or failing server shows a calm wait then a plain retry (nothing waits on the brain), owner only.
 * Screenshots of every step go to `.qa/w23-stage-<step>-<width>-<lang>.png`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import {
  answerTeamSetup,
  QUICK_TEAM_ANSWERS,
  skipTeamSetup,
  stageStep,
  startTeamSetup,
} from '../../../packages/testkit/src/e2e.js';
import { expect, PASSWORD, send, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
type Loc = Record<string, any>;
const orch = (lng: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../modules/orchestrator/locales/${lng}.json`, import.meta.url), 'utf8'),
  ) as Loc;

const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );
/** the smallest font size of any text on screen */
const smallestText = (page: Page) =>
  page.evaluate(() => {
    let min = Number.POSITIVE_INFINITY;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || el.closest('.bk-visually-hidden')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      min = Math.min(min, Number.parseFloat(getComputedStyle(el).fontSize));
    }
    return min;
  });
/** every visible button and tap card (a label around a radio) on the Stage is at least 44 px tall and wide */
const smallTargets = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="stage"] button, [data-testid="stage"] label:has(input)')]
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44))
      .map(
        ({ b }) => (b as HTMLElement).innerText || b.getAttribute('aria-label') || b.outerHTML.slice(0, 60),
      ),
  );

async function claim(page: Page, setupLink: string) {
  await page.goto(setupLink);
  await page.locator('input[autocomplete="name"]').fill('Liza');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('onb-brain')).toBeVisible();
}
const agentsNow = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/v1/agents', { credentials: 'same-origin' });
    return (
      (await r.json()) as {
        agents: { id: string; name: string; providerId: string; instructions: string; avatarSalt?: string }[];
      }
    ).agents;
  });
const chatMessages = (page: Page, chatId: string) =>
  page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/chats/${id}/messages`, { credentials: 'same-origin' });
    return (
      (await r.json()) as { messages: { authorKind: string; body: string; blocks: { kind: string }[] }[] }
    ).messages;
  }, chatId);
const stageState = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/m/orchestrator/state', { credentials: 'same-origin' });
    return (await r.json()) as { chatId: string; stage: string | null };
  });

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
});

for (const lng of ['en', 'fil'] as const)
  test.describe(`the Stage (${lng})`, () => {
    test.use({ locale: lng === 'fil' ? 'fil-PH' : 'en-US' });
    test(`${lng}: hello -> language -> name -> questions -> plan -> approve -> the app`, async ({
      page,
      server,
    }, info) => {
      const phone = info.project.name === 'phone';
      const w = phone ? '390' : '1440';
      // the owner picks the other language on the Stage: an English browser picks Taglish, a Filipino one English
      const pick = lng === 'en' ? 'taglish' : 'en';
      const after = pick === 'taglish' ? 'fil' : 'en';
      const o = orch(after);
      const shot = async (name: string) => {
        mkdirSync(QA, { recursive: true });
        // the step's entrance (a short fade, helpers arriving) has finished: the picture shows the settled screen
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
              .map((a) => a.finished.catch(() => {})),
          ),
        );
        await page.screenshot({ path: `${QA}w23-stage-${name}-${w}-${lng}.png` });
      };
      const check = async () => {
        expect(await noSideScroll(page)).toBe(true);
        expect(await smallestText(page)).toBeGreaterThanOrEqual(12);
        expect(await smallTargets(page)).toEqual([]);
      };
      await claim(page, server.setupLink);
      await startTeamSetup(page);
      await expect(page).toHaveURL(/#\/team-setup$/);
      const stage = page.getByTestId('stage');
      // full screen: no chats list, no side panel, no top bar; one way out ("Skip for now")
      await expect(page.getByTestId('chats-list')).toHaveCount(0);
      await expect(page.locator('aside')).toHaveCount(0);
      await expect(page.getByRole('banner').filter({ hasNot: stage })).toHaveCount(0);
      await expect(page.getByTestId('stage-skip')).toBeVisible();
      await expect(stage.getByRole('heading', { level: 1 })).toHaveText(orch(lng).stage.welcome.title);
      await expect(stage).toContainText('Tala');
      await check();
      await shot('1-hello');

      // language: English, Filipino, Taglish, and Other... (every language the app ships)
      await page.getByTestId('stage-next').click();
      await expect(stageStep(page, 'language')).toBeVisible();
      await expect(page.getByTestId('stage-progress')).toHaveAttribute('aria-valuenow', '1');
      await expect(page.getByTestId('stage-langs').locator('input[type="radio"]')).toHaveCount(3);
      await page.getByTestId('stage-lang-other').click();
      await expect(page.getByTestId('stage-lang-list').locator('input[type="radio"]')).toHaveCount(12);
      await page.getByTestId('stage-lang-other').click();
      await check();
      await shot('2-language');
      await page.getByTestId(`stage-lang-${pick}`).click();
      // the app's language follows the pick at once, before Continue
      await expect(page.locator('html')).toHaveAttribute('lang', after);
      await expect(page.getByTestId('stage-next')).toContainText(o.stage.next);
      await shot('2-language-picked');
      // Back to the hello and forward again: the pick is kept, the hello is now in the picked language
      await page.getByTestId('stage-back').click();
      await expect(stageStep(page, 'welcome')).toBeVisible();
      await expect(stage.getByRole('heading', { level: 1 })).toHaveText(o.stage.welcome.title);
      await page.getByTestId('stage-next').click();
      await expect(page.getByTestId(`stage-lang-${pick}`).locator('input')).toBeChecked();
      await page.getByTestId('stage-next').click();

      // name: the default, ideas to tap, own typing; the face follows the name
      await expect(stageStep(page, 'name')).toBeVisible();
      const field = page.getByTestId('stage-name');
      await expect(field).toHaveValue('Tala');
      await field.fill('');
      await page.getByTestId('stage-next').click();
      await expect(page.getByTestId('stage-name-error')).toHaveText(o.stage.name.errors.empty);
      await field.fill('PasaBot');
      await page.getByTestId('stage-next').click();
      await expect(page.getByTestId('stage-name-error')).toHaveText(o.stage.name.errors.taken);
      await page.getByTestId('stage-idea-Diwa').click();
      await expect(field).toHaveValue('Diwa');
      await field.fill('Mayumi');
      await expect(stage).toContainText(o.stage.name.newLook);
      await expect(page.getByTestId('stage-next')).toContainText('Mayumi');
      await check();
      await shot('3-name');
      await page.getByTestId('stage-next').click();

      // the questions: one at a time, a tap or own words; Back keeps the answer picked
      const q = (qid: string) =>
        page.locator(`[data-testid="stage"][data-step="question"][data-qid="${qid}"]`);
      await expect(q('help')).toBeVisible();
      await expect(page.getByTestId('stage-question')).toHaveText(o.q.help.text);
      await expect(page.getByTestId('stage-progress')).toHaveAttribute('aria-valuenow', '3');
      // the face on the question is the renamed helper's; the main helper is renamed everywhere
      const renamed = (await agentsNow(page))[0]!;
      expect([renamed.name, renamed.avatarSalt]).toEqual(['Mayumi', 'Mayumi']);
      await page.getByTestId('stage-option-shop').click();
      await page.getByTestId('stage-free').fill('May online shop ako ng kakanin');
      await check();
      await shot('4-q-help');
      await page.getByTestId('stage-next').click();
      await expect(q('people')).toBeVisible();
      await page.getByTestId('stage-back').click();
      await expect(q('help')).toBeVisible();
      await expect(page.getByTestId('stage-option-shop').locator('input')).toBeChecked();
      await page.getByTestId('stage-next').click();
      await expect(q('people')).toBeVisible();

      // a reload (or closing the app and opening it again on its home) resumes at the same step
      await page.goto(`${server.url}/#/`);
      await page.reload();
      await expect(q('people')).toBeVisible();
      await expect(page).toHaveURL(/#\/team-setup$/);

      // own words alone are read by the server at once: nothing waits on the brain
      await page.getByTestId('stage-free').fill(lng === 'en' ? 'just me' : 'ako lang');
      await shot('5-q-people');
      await page.getByTestId('stage-next').click();
      for (const [qid, option, n] of [
        ['chat', 'none', '6'],
        ['email', 'skip', '7'],
        ['askFirst', 'money', '8'],
      ] as const) {
        await expect(q(qid)).toBeVisible();
        await page.getByTestId(`stage-option-${option}`).click();
        await shot(`${n}-q-${qid}`);
        await page.getByTestId('stage-next').click();
      }

      // the plan: the lead (the renamed main helper), then each helper arrives
      await expect(stageStep(page, 'plan')).toBeVisible();
      await expect(page.getByTestId('stage-progress')).toHaveAttribute('aria-valuenow', '8');
      await expect(page.getByTestId('stage-lead')).toContainText('Mayumi');
      await expect(page.getByTestId('stage-plan-agent')).toHaveCount(2);
      await expect(page.getByTestId('stage-plan')).toContainText('Ligaya');
      await expect(page.getByTestId('stage-plan')).toContainText('Dalisay');
      await expect(page.getByTestId('stage-plan')).toContainText('May online shop ako ng kakanin');
      await expect(page.getByTestId('stage-picks')).toContainText(pick === 'taglish' ? 'Taglish' : 'English');
      await expect(page.getByTestId('stage-plan')).not.toHaveAttribute('aria-busy', 'true');
      // nothing is made before Approve
      expect((await agentsNow(page)).map((a) => a.name)).toEqual(['Mayumi']);
      await check();
      await shot('9-plan');
      await page.getByTestId('stage-approve').click();
      // W40: the "needs your OK" screen comes first; Continue leaves the rest for later
      await expect(stageStep(page, 'oks')).toBeVisible();
      await page.getByTestId('stage-oks-finish').click();

      // done: the team, the main helper pinned on top; then the app
      await expect(stageStep(page, 'done')).toBeVisible();
      await expect(page.getByTestId('stage-done-pinned')).toContainText('Mayumi');
      await expect(page.getByTestId('stage-done-agent')).toHaveCount(2);
      await expect(page.getByTestId('stage-skip')).toHaveCount(0);
      await check();
      await shot('10-done');
      const agents = await agentsNow(page);
      expect(agents.map((a) => a.name).sort()).toEqual(['Dalisay', 'Ligaya', 'Mayumi']);
      // the language the owner picked is in every helper's instructions, written by the server
      for (const a of agents.filter((x) => x.name !== 'Mayumi'))
        expect(a.instructions).toContain(pick === 'taglish' ? 'Taglish' : 'English');
      await page.getByTestId('stage-open').click();
      await expect(page).toHaveURL(/#\/chats\//);
      await expect(page.getByTestId('chat-who')).toContainText('Mayumi');
      // the chat: one short summary of the Stage, never the old interview cards
      await expect(page.getByTestId('orch-summary')).toContainText('May online shop ako ng kakanin');
      await expect(page.locator('[data-testid="orch-question"], [data-testid="orch-plan"]')).toHaveCount(0);
      if (!phone) {
        const first = page.locator('[data-testid="chats-list"]').getByTestId('roster-agent').first();
        await expect(first).toContainText('Mayumi');
        await expect(first).toHaveAttribute('data-pinned', 'true');
      }
      expect(await noSideScroll(page)).toBe(true);
      await shot('11-app');
      // the Stage never shows again: the app opens on its home (the chats; on a wide window the first chat)
      await page.goto(`${server.url}/#/`);
      await page.reload();
      await expect(page.locator('[data-testid="chats-list"]:visible').first()).toBeVisible();
      await expect(page.getByTestId('stage')).toHaveCount(0);
      // a helper answers in its own chat (its link is in the summary card)
      await page.goto(`${server.url}/#/chats/${(await stageState(page)).chatId}`);
      await page.getByTestId('orch-team-agent').first().click();
      await expect(page.getByTestId('chat-who')).toContainText('Ligaya');
      await send(page, 'kumusta');
      await expect(page.getByTestId('msg-agent').last()).toContainText('echo: kumusta');
    });
  });

test('skip keeps it for later; Settings picks it up at the same step; run again keeps the helpers', async ({
  page,
  server,
}, info) => {
  const o = orch('en');
  const w = info.project.name === 'phone' ? '390' : '1440';
  await claim(page, server.setupLink);
  await startTeamSetup(page);
  await page.getByTestId('stage-next').click();
  await page.getByTestId('stage-lang-en').click();
  await page.getByTestId('stage-next').click();
  await expect(stageStep(page, 'name')).toBeVisible();
  await skipTeamSetup(page);
  await expect(page.getByTestId('chat-log')).toContainText(o.stage.skipped.slice(0, 20));
  expect((await stageState(page)).stage).toBe('paused');
  // skipped: opening the app again goes to the chat, not back to the Stage
  await page.goto(`${server.url}/#/`);
  await page.reload();
  await expect(page.locator('[data-testid="chats-list"]:visible').first()).toBeVisible();
  await expect(page.getByTestId('stage')).toHaveCount(0);
  // the main helper is a normal agent meanwhile
  const { chatId } = await stageState(page);
  await page.goto(`${server.url}/#/chats/${chatId}`);
  await send(page, 'hello there');
  await expect(page.getByTestId('msg-agent').last()).toContainText('echo: hello there');

  // Settings › Set up my team: "Continue" opens the Stage where it was left
  await page.goto(`${server.url}/#/settings/agents/team-setup`);
  await expect(page.getByTestId('orch-again')).toHaveText(o.web.settings.continue);
  expect(await noSideScroll(page)).toBe(true);
  mkdirSync(QA, { recursive: true });
  await page.screenshot({ path: `${QA}w23-stage-settings-${w}-en.png` });
  await page.getByTestId('orch-again').click();
  await expect(stageStep(page, 'name')).toBeVisible();
  await answerTeamSetup(page, QUICK_TEAM_ANSWERS);
  await page.getByTestId('stage-approve').click();
  // W40: the "needs your OK" screen comes first; Continue leaves the rest for later
  await expect(stageStep(page, 'oks')).toBeVisible();
  await page.getByTestId('stage-oks-finish').click();
  await expect(stageStep(page, 'done')).toBeVisible();
  expect((await agentsNow(page)).map((a) => a.name).sort()).toEqual(['Dalisay', 'Ligaya', 'Tala']);

  // run it again: a new round on the hello; the helpers already made stay (nothing is deleted)
  await page.goto(`${server.url}/#/settings/agents/team-setup`);
  await expect(page.getByTestId('orch-again')).toHaveText(o.web.settings.again);
  await page.getByTestId('orch-again').click();
  await expect(stageStep(page, 'welcome')).toBeVisible();
  await expect(page.getByTestId('stage-back')).toHaveCount(0);
  expect((await agentsNow(page)).map((a) => a.name).sort()).toEqual(['Dalisay', 'Ligaya', 'Tala']);
  await page.getByTestId('stage-next').click();
  // the language picked before is still picked
  await expect(page.getByTestId('stage-lang-en').locator('input')).toBeChecked();
});

test('a slow or failing server: a calm wait, then a plain retry; nothing on the Stage waits on the brain', async ({
  page,
  server,
}) => {
  const o = orch('en');
  await claim(page, server.setupLink);
  await startTeamSetup(page);
  await page.getByTestId('stage-next').click();
  await page.getByTestId('stage-lang-en').click();
  await page.getByTestId('stage-next').click();
  await expect(stageStep(page, 'name')).toBeVisible();
  await page.getByTestId('stage-next').click();
  await expect(stageStep(page, 'question')).toBeVisible();
  const { chatId } = await stageState(page);

  // a failed call: a plain line and Try again, and the step is still there
  await page.route('**/api/m/orchestrator/answer', (r) => r.abort('failed'));
  await page.getByTestId('stage-option-home').click();
  await page.getByTestId('stage-next').click();
  await expect(page.getByTestId('stage-status')).toContainText(o.web.failed);
  await expect(page.getByTestId('stage-retry')).toBeVisible();
  await page.unroute('**/api/m/orchestrator/answer');
  await page.getByTestId('stage-retry').click();
  await expect(page.locator('[data-testid="stage"][data-qid="people"]')).toBeVisible();

  // a call that never answers: "One moment…", then "taking longer" and Try again (never a spinner forever)
  let release: (() => void) | null = null;
  await page.route('**/api/m/orchestrator/answer', async (r) => {
    await new Promise<void>((res) => {
      release = res;
    });
    await r.abort('timedout').catch(() => {});
  });
  await page.getByTestId('stage-free').fill('just me');
  await page.getByTestId('stage-next').click();
  await expect(page.getByTestId('stage-status')).toContainText(o.stage.wait);
  await expect(page.getByTestId('stage-next')).toBeDisabled();
  await page.screenshot({ path: `${QA}w23-stage-wait-${page.viewportSize()!.width}-en.png` });
  await expect(page.getByTestId('stage-status')).toContainText(o.stage.slow, { timeout: 20_000 });
  await page.screenshot({ path: `${QA}w23-stage-retry-${page.viewportSize()!.width}-en.png` });
  (release as (() => void) | null)?.();
  await page.unroute('**/api/m/orchestrator/answer');
  await page.getByTestId('stage-retry').click();
  await expect(page.locator('[data-testid="stage"][data-qid="chat"]')).toBeVisible();

  // own words were read by the server alone: the brain was never asked (the main helper's chat is still empty)
  expect(await chatMessages(page, chatId)).toHaveLength(0);
});

async function joinAsMember(
  browser: Browser,
  url: string,
  path: string,
  viewport: { width: number; height: number },
) {
  const ctx = await browser.newContext({ viewport, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(`${url}${path}`);
  await expect(page.getByTestId('people-join')).toBeVisible();
  await page.getByLabel('Your name').fill('Mia');
  await page.getByLabel('Choose a password').fill('member password 1');
  await page.getByLabel('Password again').fill('member password 1');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByTestId('people-join')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 });
  return { ctx, page };
}

test('the Stage is the owner’s: a member gets the owner-only note and every route refuses them', async ({
  page,
  server,
  browser,
}) => {
  await claim(page, server.setupLink);
  await startTeamSetup(page);
  await skipTeamSetup(page);
  const { chatId } = await stageState(page);
  const inv = await page.evaluate(async (chatId) => {
    const r = await fetch('/api/m/people/invites', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'member', chats: [{ chatId, role: 'member' }] }),
    });
    return { status: r.status, json: (await r.json()) as { path: string } };
  }, chatId);
  expect(inv.status).toBeLessThan(300);
  const m = await joinAsMember(browser, server.url, inv.json.path, page.viewportSize()!);
  try {
    await m.page.goto(`${server.url}/#/team-setup`);
    await expect(m.page.getByTestId('owner-only-page')).toBeVisible();
    await expect(m.page.getByTestId('stage')).toHaveCount(0);
    const statuses = await m.page.evaluate(async () => {
      const post = (path: string, body: unknown) =>
        fetch(`/api/m/orchestrator${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.status);
      return [
        await fetch('/api/m/orchestrator/stage', { credentials: 'same-origin' }).then((r) => r.status),
        await post('/stage/welcome', {}),
        await post('/stage/language', { code: 'en' }),
        await post('/stage/name', { name: 'Mia' }),
        await post('/stage/back', { step: 1 }),
        await post('/start', { providerId: 'fake', stage: true }),
        await post('/skip', {}),
        await post('/restart', { stage: true }),
        await post('/approve', { planId: 'x' }),
      ];
    });
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403]);
    // the member's chat with the main helper has no setup cards to tap
    await m.page.goto(`${server.url}/#/chats/${chatId}`);
    await expect(m.page.locator('[data-testid="orch-question"]')).toHaveCount(0);
  } finally {
    await m.ctx.close();
  }
  // the owner's Stage did not move
  expect((await stageState(page)).stage).toBe('paused');
});
