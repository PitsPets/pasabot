/**
 * W40 cards (Fake brain), at 1440 px and 390 px: the Stage's "A few things need your OK" screen (en + fil) builds its
 * cards from the answers, keeps each choice on the server (Later, Back; on a phone Back never covers the title), and
 * everything not done comes back as cards from the main helper in its chat: only the one that blocks a helper (the
 * mailbox) needs an answer and is in the pinned decision bar on other screens ("Things that still need your OK: 1");
 * the optional ones are quiet ideas. "Not now" settles a card to one line. A brain that is signed out leaves a "Sign
 * in again" card (in the bar on other screens until a turn works again, then one line); right after the first reply,
 * suggestion chips that put an example in the message box (never sent for the owner).
 * Screenshots: `.qa/w40-cards-<name>-<w>-<lng>.png`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { answerTeamSetup, stageStep, startTeamSetup } from '../../../packages/testkit/src/e2e.js';
import { claimServer, createFakeAgent, expect, PASSWORD, script, send, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
type Loc = Record<string, any>;
const loc = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')) as Loc;
const orch = {
  en: loc('modules/orchestrator/locales/en.json'),
  fil: loc('modules/orchestrator/locales/fil.json'),
};
const web = { en: loc('apps/web/locales/en.json'), fil: loc('apps/web/locales/fil.json') };
const core = loc('packages/i18n/locales/en.json');
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shooter = (page: Page, w: string, lng: string) => async (name: string) => {
  mkdirSync(QA, { recursive: true });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: `${QA}w40-cards-${name}-${w}-${lng}.png` });
};
/** every tap target in the card is at least 44 px high */
const short = async (page: Page, sel: string) =>
  page
    .locator(sel)
    .evaluateAll((els) =>
      els
        .map((e) => ({ t: e.textContent, h: Math.round(e.getBoundingClientRect().height) }))
        .filter((x) => x.h < 44),
    );

for (const lng of ['en', 'fil'] as const) {
  test(`onboarding: a few things need your OK, then Later ones are cards in the chat and the bar (${lng})`, async ({
    page,
    server,
  }, info) => {
    test.setTimeout(180_000);
    const phone = info.project.name === 'phone';
    const w = phone ? '390' : '1440';
    if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
    const shot = shooter(page, w, lng);
    const o = orch[lng].oks;
    await page.goto(server.setupLink);
    await page.locator('input[autocomplete="name"]').fill('Liza');
    await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
    await page.locator('form button[type="submit"]').click();
    await startTeamSetup(page);
    await answerTeamSetup(
      page,
      [
        ['help', 'work'],
        ['people', 'solo'],
        ['chat', 'telegram'],
        ['email', 'connect'],
        ['askFirst', 'money'],
      ],
      { language: lng, name: 'Mayumi' },
    );
    await page.getByTestId('stage-approve').click();

    // the OK screen: one card per thing the answers call for, each with Connect / Allow and Later
    await expect(stageStep(page, 'oks')).toBeVisible();
    await expect(page.locator('#stg-h')).toHaveText(o.title);
    for (const k of ['email', 'chat', 'apps', 'browser', 'ask', 'alerts'])
      await expect(page.getByTestId(`ok-${k}`).first()).toBeVisible();
    await expect(page.getByTestId('ok-chat')).toContainText('Telegram');
    await expect(page.getByTestId('ok-apps').first()).toContainText('Google Calendar');
    expect(await noSideScroll(page)).toBe(true);
    expect(await short(page, '[data-testid="stage-oks"] .bk-hcard__btns .bk-btn')).toEqual([]);
    // the last step (8 of 8): the seven before it are filled, the last one is the one in progress
    const prog = page.getByTestId('stage-progress');
    await expect(prog).toHaveAttribute('aria-valuenow', '8');
    await expect(prog.locator('i.done')).toHaveCount(7);
    await expect(prog.locator('i.now')).toHaveCount(1);
    await expect(prog.locator('i').nth(6)).toHaveCSS(
      'background-color',
      await prog
        .locator('i')
        .nth(0)
        .evaluate((e) => getComputedStyle(e).backgroundColor),
    );
    await shot('oks');

    // Later collapses it to one line; Back reopens it; nothing is granted without a tap
    const chatCard = page.getByTestId('ok-chat');
    await chatCard.locator('[data-card-action="later"]').click();
    await expect(chatCard).toHaveAttribute('data-state', 'later');
    await page.getByTestId('stage-back').click();
    await expect(chatCard).toHaveAttribute('data-state', 'open');
    await chatCard.locator('[data-card-action="later"]').click();
    await expect(chatCard).toHaveAttribute('data-state', 'later');
    // the choice is on the server: a reload shows the same screen
    await page.reload();
    await expect(stageStep(page, 'oks')).toBeVisible();
    await expect(page.getByTestId('ok-chat')).toHaveAttribute('data-state', 'later');
    // Back is on the screen now: it never covers the title (a phone keeps its row free)
    const overlap = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="stage-back"]')?.getBoundingClientRect();
      const h = document.getElementById('stg-h')?.getBoundingClientRect();
      if (!b || !h) return null;
      return !(b.right <= h.left || h.right <= b.left || b.bottom <= h.top || h.bottom <= b.top);
    });
    expect(overlap).toBe(false);
    await shot('oks-later');

    // Continue: the rest stays for later; the finish screen, then the app
    await page.getByTestId('stage-oks-finish').click();
    await expect(stageStep(page, 'done')).toBeVisible();
    await page.getByTestId('stage-open').click();
    await expect(page).toHaveURL(/#\/chats\//);

    // every OK not done is a card from the main helper in its chat: the mailbox needs an answer, the rest are ideas
    const cards = page.locator('[data-testid="msg-card"] .bk-hcard[data-state="open"]');
    const kicker = (text: string) => page.locator('.bk-hcard__kicker', { hasText: text });
    await expect(cards.first()).toBeVisible();
    const n = await cards.count();
    expect(n).toBeGreaterThanOrEqual(6);
    await expect(page.locator('[data-testid="msg-card"]').first()).toContainText(o.email.title);
    await expect(cards.filter({ has: kicker(web[lng].cards.needsOk) })).toHaveCount(1);
    await expect(cards.filter({ has: kicker(web[lng].cards.idea) })).toHaveCount(n - 1);
    // the one that needs an answer is right here in the chat: no bar above it saying it twice
    const bar = page.getByTestId('decision-bar');
    await expect(bar).toHaveCount(0);
    // right after the setup, "what can I ask next" as chips in the main helper's chat
    await expect(page.getByTestId('suggestions')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot('chat-cards');

    // the same after a reload (the state is on the server)
    await page.reload();
    await expect(cards.first()).toBeVisible();
    await expect(cards).toHaveCount(n);

    // Connect only opens the guided page: the card stays open (nothing is lost if the page is left unfinished)
    const chatUrl = page.url();
    const mail = cards.filter({ has: kicker(web[lng].cards.needsOk) }).first();
    const mailId = await mail.getAttribute('data-card-id');
    await mail.locator('[data-card-action="yes"]').click();
    await expect(page).not.toHaveURL(chatUrl);
    // on another screen the bar counts only what blocks a helper
    await expect(bar).toContainText(web[lng].cards.stillNeed.replace('{{count}}', '1'));
    await bar.getByRole('button').click();
    const review = page.getByTestId('decision-review');
    await expect(review.locator('[data-decision-kind="card"]')).toHaveCount(1);
    await expect(review.locator(`[data-card-id="${mailId}"]`)).toHaveAttribute('data-state', 'open');
    expect(await noSideScroll(page)).toBe(true);
    await shot('review');
    await page.keyboard.press('Escape');

    // "Not now" settles one to a single line
    await page.goto(chatUrl);
    const first = cards.filter({ has: kicker(web[lng].cards.idea) }).first();
    const id = await first.getAttribute('data-card-id');
    await first.locator('[data-card-action="later"]').click();
    const log = page.getByTestId('chat-log');
    await expect(log.locator(`[data-card-id="${id}"]`)).toHaveAttribute('data-state', 'later');
    await expect(log.locator(`[data-card-id="${id}"]`).getByTestId('card-settled')).toBeVisible();
    await expect(cards).toHaveCount(n - 1);
  });
}

test('a signed-out brain: a "Sign in again" card in the chat and the bar until a turn works; suggestions after the first reply', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  const shot = shooter(page, w, 'en');
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');

  // the first reply: "what can I ask next" as chips under it; a tap puts the example in the message box, unsent
  await send(page, 'hi');
  await expect(page.getByTestId('msg-agent').last()).toContainText('echo: hi');
  const ideas = page.getByTestId('suggestions');
  await expect(ideas).toBeVisible();
  await expect(ideas.locator('button')).toHaveCount(3);
  expect(await short(page, '[data-testid="suggestions"] button')).toEqual([]);
  expect(await noSideScroll(page)).toBe(true);
  await shot('suggestions');
  const before = await page.getByTestId('msg-me').count();
  await ideas.getByTestId('suggest-write').click();
  await expect(page.getByTestId('composer')).toHaveValue(web.en.cards.suggest.write.send);
  await expect(page.getByTestId('composer')).toBeFocused();
  expect(await page.getByTestId('msg-me').count()).toBe(before);
  await page.getByTestId('composer').fill('');

  // the brain is signed out: the reply is a card with a plain reason and a way out, never the raw error
  await send(
    page,
    script([
      { event: { type: 'error', kind: 'auth', message: 'Not logged in. Please run /login' } },
      { event: { type: 'done', stop: 'error' } },
    ]),
  );
  await expect(ideas).toHaveCount(0);
  const card = page.locator('.bk-hcard[data-variant="error"][data-state="open"]').last();
  await expect(card).toBeVisible();
  await expect(card).toContainText(core.plain.card.signIn.title.replace('{{name}}', 'Tala'));
  await expect(card.locator('[data-card-action="signin"]')).toBeVisible();
  // Try again would only fail again before a sign-in: just the way in and another mind
  await expect(card.locator('[data-card-action="retry"]')).toHaveCount(0);
  await expect(card.locator('[data-card-action="brain"]')).toBeVisible();
  await expect(card).not.toContainText('Please run /login');
  // plain words (Technical words off): no "brain", no brain name ("Fake (tests)")
  await expect(card).not.toContainText(/brain/i);
  await expect(card).not.toContainText('Fake');
  // the title stays a heading (the live region is around it)
  await expect(
    card.getByRole('heading', { name: core.plain.card.signIn.title.replace('{{name}}', 'Tala') }),
  ).toBeVisible();
  // the card is right here: no bar above it saying the same thing
  const bar = page.getByTestId('decision-bar');
  await expect(bar).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
  await shot('signin');

  // a turn that works settles it to one line, and the bar is gone
  await send(page, 'hello again');
  await expect(page.getByTestId('msg-agent').last()).toContainText('echo: hello again');
  const settled = page.locator('.bk-hcard[data-variant="error"]').last();
  await expect(settled).toHaveAttribute('data-state', 'done');
  await expect(settled).toContainText(core.card.settled.signedIn);
  await expect(bar).toHaveCount(0);
  await shot('signin-settled');

  // a helper saves something: "I'll remember that" with Undo (the owner's own delete)
  const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
  const memory = loc('modules/memory/locales/en.json').card.saved;
  await send(page, probe('memory_remember', { text: "Mom's birthday is June 3" }));
  const saved = page.locator('.bk-hcard[data-variant="result"]').filter({ hasText: memory.title }).last();
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("Mom's birthday is June 3");
  await shot('memory');
  await saved.locator('[data-card-action="undo"]').click();
  await expect(saved).toHaveAttribute('data-state', 'dismissed');
  await expect(saved).toContainText(memory.undone);

  // a helper sets up a routine: what it is, with Pause and Undo
  const routines = loc('modules/routines/locales/en.json').card;
  await send(
    page,
    probe('routines_create', {
      name: 'Morning news',
      prompt: 'Summarize the news',
      trigger: { kind: 'manual' },
    }),
  );
  const made = page.locator('.bk-hcard').filter({ hasText: 'Morning news' }).last();
  await expect(made).toBeVisible();
  // the buttons say what they do: Pause it (the one primary) and Delete it
  await expect(made.locator('[data-card-action="pause"]')).toHaveText(routines.pause);
  await expect(made.locator('[data-card-action="pause"]')).toHaveClass(/bk-btn--primary/);
  await expect(made.locator('[data-card-action="undo"]')).toHaveText(routines.undo);
  expect(await noSideScroll(page)).toBe(true);
  await shot('routine');
  await made.locator('[data-card-action="pause"]').click();
  await expect(made).toHaveAttribute('data-state', 'done');
  await expect(made).toContainText(routines.paused);
});
