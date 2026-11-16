/**
 * The r7 picky list (W27 → W28), at 1440 px and 390 px: with Technical words off no Settings page (home, every group,
 * the side list) says a technical word, in English or Filipino; the add-chat-app form shows the apps as brand tiles in
 * plain words (technical names with Technical words on) and the stores are brand tiles; on the Stage the plan's lines
 * stay under the "arriving" badge (all cards at once with reduced motion), the mail helper has a reason of its own,
 * each helper keeps the face its plan card showed (done screen, chat list), and an answer tapped but not sent when
 * Skip is pressed is still there on the resume; on desktop Stop all is calm (not red) while nothing works, red while
 * something does, and the chat's More menu and Ctrl/⌘ + Shift + . always stop. Screenshots: `.qa/w28-<name>-<w>.png`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { stageStep, startTeamSetup } from '../../../packages/testkit/src/e2e.js';
import { claimServer, createFakeAgent, done, expect, PASSWORD, script, send, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
type Loc = Record<string, any>;
const loc = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')) as Loc;
const web = { en: loc('apps/web/locales/en.json'), fil: loc('apps/web/locales/fil.json') };
const orch = loc('modules/orchestrator/locales/fil.json');
const ch = loc('modules/channels/locales/en.json');
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
const shooter = (page: Page, w: string) => async (name: string) => {
  mkdirSync(QA, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${QA}w28-${name}-${w}.png` });
};

/**
 * Words a first-timer should never meet with Technical words off (English, and the English words a Filipino screen
 * would borrow): the plain word for a helper is "helper" / "katulong", everywhere.
 */
const DENY = /\b(MCP|ACP|skills?|tokens?|vault|API[ -]?keys?|providers?|agents?|ahente)\b/i;
/** brand and product names that carry one of those words and are not technical talk */
const ALLOW = [/AgentChat/gi];
const offenders = (text: string) =>
  text
    .split('\n')
    .map((l) => ALLOW.reduce((s, re) => s.replace(re, ''), l))
    .filter((l) => DENY.test(l));

const GROUPS = [
  'agents',
  'safety',
  'people',
  'look',
  'tools',
  'inbox',
  'shopping',
  'memory',
  'automations',
  'spending',
  'machines',
  'advanced',
] as const;

test('Technical words off: no technical word anywhere in Settings, in English or Filipino', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  const shot = shooter(page, w);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const base = page.url().replace(/#.*$/, '');
  const found: string[] = [];
  for (const lng of ['en', 'fil'] as const) {
    await page.goto(`${base}#/settings/look/language`);
    await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
    await expect(page.locator('html')).toHaveAttribute('lang', lng);
    await page.goto(`${base}#/settings`);
    await expect(page.getByTestId('settings-home')).toBeVisible();
    for (const l of offenders(await page.getByTestId('settings-home').innerText()))
      found.push(`${lng} home: ${l}`);
    for (const g of GROUPS) {
      await page.goto(`${base}#/settings/${g}`);
      const p = page.getByTestId(`settings-page-${g}`);
      await expect(p).toBeVisible();
      for (const l of offenders(await p.innerText())) found.push(`${lng} ${g}: ${l}`);
      // the side list of groups (desktop) reads the same plain words
      if (!phone && g === 'agents')
        for (const l of offenders(await page.locator('.set-nav').first().innerText()))
          found.push(`${lng} side list: ${l}`);
      if (lng === 'fil' && (g === 'tools' || g === 'agents')) await shot(`settings-${g}-plain`);
    }
  }
  expect(found, found.join('\n')).toEqual([]);
  // with Technical words on, the technical names are back
  await technical(page, true);
  await page.goto(`${base}#/settings/tools`);
  await page.reload();
  await expect(page.getByTestId('settings-page-tools')).toContainText(web.fil.groups.tools.name);
  await shot('settings-tools-technical');
  await technical(page, false);
});

test('add a chat app: the apps as brand tiles in plain words (technical names with the switch on); stores as tiles', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  const shot = shooter(page, w);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const base = page.url().replace(/#.*$/, '');
  const open = async () => {
    await page.goto(`${base}#/settings/people/channels`);
    const section = page.getByTestId('channels-settings');
    await section.getByRole('button', { name: /Add/ }).click();
    return page.getByTestId('channel-add-form');
  };
  let form = await open();
  await expect(
    page.getByTestId('channels-settings').getByRole('heading', { name: ch.plain.settings.title }),
  ).toBeVisible();
  const tiles = form.getByTestId('channel-kinds').locator('label');
  expect(await tiles.count()).toBeGreaterThan(0);
  // no list to open: each app is a tile with its own mark, a radio to tap
  await expect(form.locator('select').first()).not.toHaveAccessibleName(ch.add.kind);
  for (const tile of await tiles.all()) {
    await expect(tile.locator('.bk-brand-tile')).toHaveCount(1);
    expect((await tile.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await tiles.last().click();
  await expect(tiles.last().locator('input[type="radio"]')).toBeChecked();
  await tiles.first().click();
  await expect(tiles.first().locator('input[type="radio"]')).toBeChecked();
  await expect(form.getByLabel(ch.plain.add.agent)).toBeVisible();
  expect(offenders(await form.innerText())).toEqual([]);
  if (await form.getByLabel(ch.plain.add.token).count())
    await expect(form).toContainText(ch.plain.add.tokenHint);
  expect(await noSideScroll(page)).toBe(true);
  await shot('add-chat-app');
  // Technical words on: the technical names
  await technical(page, true);
  await page.reload();
  form = await open();
  await expect(form.getByLabel(ch.add.agent)).toBeVisible();
  await expect(form.locator('legend')).toHaveText(ch.add.kind);
  await shot('add-chat-app-technical');
  await technical(page, false);

  // the stores: tiles with each store's mark, still a checkbox each
  await page.goto(`${base}#/settings/shopping/shop`);
  const shop = page.getByTestId('shop-settings');
  await shop.getByLabel('Country').selectOption({ label: 'Philippines' });
  const stores = shop.getByTestId('shop-stores').locator('label');
  await expect(stores.first()).toBeVisible();
  for (const s of await stores.all()) {
    await expect(s.locator('.bk-brand-tile')).toHaveCount(1);
    await expect(s.locator('input[type="checkbox"]')).toHaveCount(1);
  }
  expect(await noSideScroll(page)).toBe(true);
  await shot('stores');
});

test('the Stage: lines stay under the arriving badge, the mail helper has its own reason, one face per helper, a tapped answer survives Skip', async ({
  page,
  server,
}, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  const shot = shooter(page, w);
  await page.goto(server.setupLink);
  await page.locator('input[autocomplete="name"]').fill('Liza');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await startTeamSetup(page);
  await page.getByTestId('stage-next').click();
  await stageStep(page, 'language').waitFor();
  await page.getByTestId('stage-lang-taglish').click();
  await page.getByTestId('stage-next').click();
  await stageStep(page, 'name').waitFor();
  await page.getByTestId('stage-name').fill('Mayumi');
  await page.getByTestId('stage-next').click();
  const q = (qid: string) => page.locator(`[data-testid="stage"][data-step="question"][data-qid="${qid}"]`);
  await expect(q('help')).toBeVisible();
  for (const o of ['shop', 'home', 'work', 'study']) await page.getByTestId(`stage-option-${o}`).click();
  await page.getByTestId('stage-next').click();
  for (const [qid, option] of [
    ['people', 'solo'],
    ['chat', 'none'],
  ] as const) {
    await expect(q(qid)).toBeVisible();
    await page.getByTestId(`stage-option-${option}`).click();
    await page.getByTestId('stage-next').click();
  }

  // 7. an answer tapped but not sent, then Skip: still tapped (not sent) when the Stage opens again
  await expect(q('email')).toBeVisible();
  await page.getByTestId('stage-option-new').click();
  await expect(page.getByTestId('stage-option-new').locator('input')).toBeChecked();
  await shot('skip-before');
  await page.getByTestId('stage-skip').click();
  await expect(page).toHaveURL(/#\/chats\//);
  await page.goto(page.url().replace(/#.*$/, '#/settings/agents/team-setup'));
  await page.getByTestId('orch-again').click();
  await expect(q('email')).toBeVisible();
  await expect(page.getByTestId('stage-option-new').locator('input')).toBeChecked();
  await expect(page.getByTestId('stage-next')).toBeEnabled();
  await shot('resume-kept');
  await page.getByTestId('stage-next').click();
  await expect(q('askFirst')).toBeVisible();
  await page.getByTestId('stage-option-none').click();
  await page.getByTestId('stage-next').click();

  // 3. mid-reveal: the "arriving" badge is painted over the card's connector line, never under it
  await expect(stageStep(page, 'plan')).toBeVisible();
  const badge = page.locator('.stg-arriving');
  const cards = page.getByTestId('stage-plan-agent');
  await expect(badge).toBeVisible();
  // a few cards in, still arriving: the moment the old line ran through the badge
  await expect(cards).toHaveCount(3);
  // read in one tick, straight away: the badge moves to the next card every 520 ms, so a handle resolved first and
  // evaluated a moment later (or after waiting for animations, slow under a full parallel run) can be the old,
  // already removed badge, whose closest('li') is null
  const stack = await (
    await page.waitForFunction(
      () => {
        const b = document.querySelector('.stg-arriving');
        const li = b?.closest('li');
        if (!b || !li) return null;
        return {
          badge: getComputedStyle(b).zIndex,
          before: getComputedStyle(li, '::before').zIndex,
          after: getComputedStyle(li, '::after').zIndex,
        };
      },
      undefined,
      { polling: 'raf', timeout: 10_000 },
    )
  ).jsonValue();
  if (!stack) throw new Error('the arriving badge was never read');
  expect(Number(stack.badge)).toBeGreaterThan(0);
  expect([stack.before, stack.after]).toEqual(['auto', 'auto']);
  await settle(page);
  await page.screenshot({ path: `${QA}w28-plan-arriving-${w}.png` });
  await expect(cards).toHaveCount(5);
  await expect(badge).toHaveCount(0);

  // reduced motion: change the answers (all still picked), go through again, and every card is there at once
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('stage-change').click();
  for (const qid of ['help', 'people', 'chat', 'email', 'askFirst']) {
    await expect(q(qid)).toBeVisible();
    await page.getByTestId('stage-next').click();
  }
  await expect(stageStep(page, 'plan')).toBeVisible();
  await expect(cards).toHaveCount(5);
  await expect(badge).toHaveCount(0);

  // 5. the mail helper's reason is its own short line, like the others (never "Gumawa ng bagong mailbox")
  const mailWhy = orch.plan.roles.mail.why as string;
  const liham = cards.filter({ hasText: 'Liham' });
  await expect(liham.getByTestId('stage-plan-why')).toHaveText(
    orch.stage.plan.because.replace('{{what}}', mailWhy[0]!.toUpperCase() + mailWhy.slice(1)),
  );
  await expect(page.getByTestId('stage-plan')).not.toContainText(orch.q.email.options.new);
  expect(await noSideScroll(page)).toBe(true);
  await shot('plan');

  // 4. one face per helper: the plan card, the done screen and the chat list draw the same avatar
  const faces = async (rows: ReturnType<Page['locator']>) => {
    const out: Record<string, string> = {};
    for (const r of await rows.all()) {
      const name = (await r.locator('b').first().innerText()).trim();
      out[name] = await r
        .locator('svg')
        .first()
        .evaluate((s) => s.outerHTML);
    }
    return out;
  };
  const planned = await faces(cards);
  expect(Object.keys(planned).sort()).toEqual(['Amihan', 'Liham', 'Ligaya', 'Sinag', 'Tanglaw'].sort());
  await page.getByTestId('stage-approve').click();
  // W40: the "needs your OK" screen comes first; Continue leaves the rest for later
  await expect(stageStep(page, 'oks')).toBeVisible();
  await page.getByTestId('stage-oks-finish').click();
  await expect(stageStep(page, 'done')).toBeVisible();
  expect(await faces(page.getByTestId('stage-done-agent'))).toEqual(planned);
  await shot('done');
  await page.getByTestId('stage-open').click();
  await expect(page).toHaveURL(/#\/chats\//);
  if (phone) await page.goto(page.url().replace(/#.*$/, '#/'));
  const list = page.locator('[data-testid="chats-list"]:visible');
  for (const [name, svg] of Object.entries(planned)) {
    const row = list.getByTestId('roster-agent').filter({ hasText: name }).first();
    await expect(row).toBeVisible();
    expect(
      await row
        .locator('svg')
        .first()
        .evaluate((s) => s.outerHTML),
    ).toBe(svg);
  }
  await shot('chats-faces');
});

test('Stop all: calm while nothing works, red while something does; the More menu and the keys always stop', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  const shot = shooter(page, w);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const bar = page.locator(phone ? '.ptop' : '.top');
  const stopAll = bar.getByTestId('stop-all');
  if (!phone) {
    // 6. idle: calm (neutral), not the red button
    await expect(stopAll).toBeVisible();
    await expect(stopAll).toHaveAttribute('data-calm', '1');
    await expect(stopAll).not.toHaveClass(/bk-btn--danger/);
    await shot('stop-calm');
    await send(page, script([{ after: 2500, event: { type: 'text.final', text: 'tapos na' } }, done]));
    await expect(stopAll).toHaveAttribute('data-calm', '0');
    await expect(stopAll).toHaveClass(/bk-btn--danger/);
    await shot('stop-working');
    await expect(stopAll).toHaveAttribute('data-calm', '1', { timeout: 15_000 });
  } else {
    await expect(stopAll).toHaveCount(0);
  }
  // the chat's More menu stops everything, whatever the button looks like
  await page.getByTestId(phone ? 'phone-chat-more-btn' : 'chat-more-btn').click();
  await page.getByTestId('more-stop-all').click();
  const report = page.locator('dialog[open]').getByTestId('stop-report');
  await expect(report).toBeVisible();
  await shot('stop-from-menu');
  await report.getByRole('button', { name: 'OK' }).click();
  await expect(bar.getByTestId('stopped-pill')).toBeVisible();
  const resume = async () => {
    await page.getByTestId('paused-banner').getByRole('button', { name: 'Start again' }).click();
    const form = page.locator('dialog[open]').getByTestId('resume-form');
    await form.getByLabel('Password').fill(PASSWORD);
    await form.getByRole('button', { name: 'Start again' }).click();
    await expect(form).toBeHidden();
  };
  await resume();
  // the menu offers no stop while paused; after the resume it is back
  await expect(bar.getByTestId('stopped-pill')).toHaveCount(0);
  if (!phone) {
    // Ctrl + Shift + . stops from anywhere
    await page.keyboard.press('Control+Shift+Period');
    await expect(page.locator('dialog[open]').getByTestId('stop-report')).toBeVisible();
    await page.locator('dialog[open]').getByRole('button', { name: 'OK' }).click();
    await expect(bar.getByTestId('stopped-pill')).toBeVisible();
    await resume();
  }
});
