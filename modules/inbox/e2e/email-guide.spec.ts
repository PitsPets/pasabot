/**
 * The guided email setup (ws/email) in the browser, at 1440 px and 390 px, on the Fake brain and the in-repo fake
 * IMAP/SMTP server (the named services point at it through test-only operator config; no network, no real account):
 *   - connect my own Gmail, in English: the Stage's email answer -> the done screen's next step -> the service tiles
 *     -> the address -> the app password guide (Google's own pages open in a new tab) -> the code, with each failure's
 *     plain reason (not 16 letters, wrong code, 2-step off, IMAP off) -> connected -> what helpers may do (read and
 *     draft by default) -> the tiny test -> done; the main helper's chat has the same card, finished.
 *   - make a new email, in Filipino: the main helper's checklist card in its chat (address ideas, Gmail sign-up in
 *     the owner's own browser, only they do that part) -> the new address -> a reload resumes mid-way -> the same
 *     connect steps -> done.
 * No side scroll, no text under 12 px, 44 px tap targets on the phone. Screenshots: `.qa/w32-<step>-<width>-<lang>.png`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  answerTeamSetup,
  passTeamOks,
  stageStep,
  startTeamSetup,
} from '../../../packages/testkit/src/e2e.js';
import { buildMail } from '../src/mime.js';
import { startFakeMail } from '../src/testing/fake-mail.js';
import { test as base, expect, fits, PASSWORD, signupSubmits } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
mkdirSync(QA, { recursive: true });
const GMAIL = 'owner.team@gmail.com';
const CODE = 'abcdefghijklmnop';
type Loc = Record<string, any>;
const loc = (lng: string) =>
  JSON.parse(readFileSync(new URL(`../locales/${lng}.json`, import.meta.url), 'utf8')) as Loc;

// the fake mail server knows the Gmail address and its 16-letter app password
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  mail: async ({}, use) => {
    const m = await startFakeMail({ user: GMAIL, pass: CODE, tls: 'implicit' });
    await use(m);
    await m.close();
  },
});

async function claim(page: Page, setupLink: string) {
  await page.goto(setupLink);
  await page.locator('input[autocomplete="name"]').fill('Liza');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('onb-brain')).toBeVisible();
}

const ANSWERS = (email: 'new' | 'connect') =>
  [
    ['help', 'shop'],
    ['people', 'solo'],
    ['chat', 'none'],
    ['email', email],
    ['askFirst', 'none'],
  ] as const;

/** every button and link in `scope` is at least 44 px tall on the phone */
async function tapTargets(page: Page, scope: string) {
  const small = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return ['(no scope)'];
    return [...root.querySelectorAll('button, a[href], input[type="radio"]')]
      .map((el) => (el.closest('label') ?? el) as HTMLElement)
      .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().height < 44)
      .map((el) => `${el.tagName} ${el.textContent?.trim().slice(0, 30)}`);
  }, scope);
  expect(small).toEqual([]);
}

test('connect my own Gmail: done screen -> tiles -> app password guide -> each failure -> connected -> test', async ({
  page,
  server,
  mail,
}, info) => {
  const w = info.project.name === 'phone' ? 390 : 1440;
  const en = loc('en').guide;
  const shot = (s: string) => page.screenshot({ path: `${QA}w32-connect-${s}-${w}-en.png`, fullPage: true });
  await claim(page, server.setupLink);
  await startTeamSetup(page);
  await answerTeamSetup(page, ANSWERS('connect'));
  await page.getByTestId('stage-approve').click();
  // W40: "A few things need your OK" comes before the finish; Continue leaves them for later
  await passTeamOks(page);
  await expect(stageStep(page, 'done')).toBeVisible();

  // the done screen's next step says what really happens next, and opens it
  const next = page.getByTestId('stage-done-next');
  await expect(next).toContainText('Connect your email now');
  await shot('done');
  await page.getByTestId('stage-done-email').click();
  await expect(page).toHaveURL(/#\/inbox\/connect$/);
  const flow = page.getByTestId('guide');
  await expect(flow).toHaveAttribute('data-step', 'service');
  for (const s of ['gmail', 'outlook', 'yahoo', 'icloud', 'other'])
    await expect(page.getByTestId(`guide-service-${s}`)).toBeVisible();
  await fits(page, '[data-testid="connect-page"]');
  if (w === 390) await tapTargets(page, '[data-testid="connect-page"]');
  await shot('tiles');
  // "Other email" with Technical words off: plain words, no server names or ports; the helper helps in the chat
  await page.getByTestId('guide-service-other').click();
  await expect(flow).toHaveAttribute('data-step', 'manual');
  await expect(page.getByTestId('guide-manual-plain')).toBeVisible();
  await expect(page.getByTestId('connect-page')).not.toContainText(/IMAP|SMTP/);
  await page.getByTestId('guide-back').click();
  await expect(flow).toHaveAttribute('data-step', 'service');
  await page.getByTestId('guide-service-gmail').click();

  // the address, then the plain three-step guide; Google's own pages open in the owner's own browser
  await expect(flow).toHaveAttribute('data-step', 'address');
  // an address of another service, or a company's own domain, is pointed out before any code is made
  await page.getByTestId('guide-address').fill('juan@yahoo.com');
  await expect(page.getByTestId('guide-address-mismatch')).toContainText('Yahoo Mail');
  await expect(page.getByTestId('guide-address-switch')).toBeVisible();
  await page.getByTestId('guide-address').fill('sales@theircompany.ph');
  await expect(page.getByTestId('guide-address-work')).toHaveText(en.address.work);
  await page.getByTestId('guide-address').fill('not an address');
  await page.getByTestId('guide-address-next').click();
  await expect(flow).toHaveAttribute('data-step', 'address');
  await page.getByTestId('guide-address').fill(GMAIL);
  await page.getByTestId('guide-address-next').click();
  await expect(flow).toHaveAttribute('data-step', 'guide');
  const open = page.getByTestId('guide-open-apppw');
  await expect(open).toHaveAttribute('href', 'https://myaccount.google.com/apppasswords');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener/);
  await expect(page.getByTestId('guide-open-2sv')).toHaveAttribute(
    'href',
    /^https:\/\/myaccount\.google\.com\//,
  );
  await expect(page.getByTestId('guide-apppw')).toContainText('PasaBot');
  // all three steps keep their own number (1, 2, 3), not just the last one
  expect(
    await page
      .getByTestId('guide-apppw')
      .locator(':scope > li')
      .evaluateAll((lis) => lis.map((li) => getComputedStyle(li).display)),
  ).toEqual(['list-item', 'list-item', 'list-item']);
  await fits(page, '[data-testid="connect-page"]');
  if (w === 390) await tapTargets(page, '[data-testid="connect-page"]');
  await shot('guide');
  await page.getByTestId('guide-done').click();

  // the code: masked, and each failure's own plain reason
  await expect(flow).toHaveAttribute('data-step', 'code');
  // the pressed button is gone: focus lands on the new step's "Step n of total", not at the top of the page
  await expect(page.getByTestId('guide-count')).toBeFocused();
  const code = page.getByTestId('guide-code');
  await expect(code).toHaveAttribute('type', 'password');
  const reason = page.getByTestId('guide-reason');
  const tryCode = async (c: string, why: string) => {
    await code.fill(c);
    await page.getByTestId('guide-connect').click();
    await expect(reason).toHaveAttribute('data-reason', why);
  };
  await tryCode('my real password', 'code_shape');
  await expect(reason).toContainText('16');
  mail.refuseWith('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
  await tryCode('abcd efgh ijkl mnop', 'wrong_code');
  await expect(reason).toContainText(en.reason.wrong_code.replace('{{company}}', 'Google').slice(0, 20));
  await shot('wrong-code');
  mail.refuseWith('[WEBALERT] Please log in via your web browser');
  await tryCode('abcd efgh ijkl mnop', 'two_step_off');
  await expect(reason.getByRole('link')).toHaveAttribute('href', /myaccount\.google\.com/);
  mail.refuseWith('[ALERT] Your account is not enabled for IMAP use.');
  await tryCode('abcd efgh ijkl mnop', 'imap_off');
  // no IMAP switch to hunt for at Google, no jargon, and the code is still in the box: Connect works again as is
  await expect(reason.getByRole('link')).toHaveCount(0);
  await expect(reason).not.toContainText('IMAP');
  await expect(code).toHaveValue('abcd efgh ijkl mnop');
  await expect(page.getByTestId('guide-connect')).toBeEnabled();
  await fits(page, '[data-testid="connect-page"]');
  await shot('imap-off');
  mail.refuseWith(null);

  // the right code, already in the box after the fix elsewhere: connected; the code is gone from the page
  await page.getByTestId('guide-connect').click();
  await expect(flow).toHaveAttribute('data-step', 'access');
  await expect(page.getByTestId('guide-connected')).toHaveText(
    'Connected. I can now read and draft for you.',
  );
  expect(await page.content()).not.toContain('abcd efgh');
  // read and draft is picked first; sending always waits for the owner's approval
  await expect(page.getByTestId('guide-access-draft').locator('input')).toBeChecked();
  await expect(page.getByTestId('guide-access-send')).toContainText('Approve');
  if (w === 390) await tapTargets(page, '[data-testid="connect-page"]');
  await shot('access');
  await page.getByTestId('guide-access-save').click();

  // the tiny test: only the owner's own mail with the word counts (a newsletter that arrives proves nothing)
  await expect(flow).toHaveAttribute('data-step', 'test');
  const word = ((await page.getByTestId('guide-test-word').textContent()) ?? '').trim();
  expect(word).toMatch(/^[a-z]{6,14}$/);
  mail.deliver(
    buildMail({ from: 'Shop <news@shop.example>', to: [GMAIL], subject: 'Big sale today', text: 'Buy now' }),
  );
  await page.getByTestId('guide-check').click();
  await expect(page.getByTestId('guide-arrived')).toHaveText(en.test.none.replace('{{word}}', word));
  mail.deliver(
    buildMail({ from: 'Liza <liza@example.com>', to: [GMAIL], subject: `Hello PasaBot ${word}`, text: 'hi' }),
  );
  await page.getByTestId('guide-check').click();
  await expect(page.getByTestId('guide-arrived')).toContainText('Hello PasaBot');
  await expect(page.getByTestId('guide-arrived')).toContainText(en.test.proves);
  await shot('test');
  await page.getByTestId('guide-done').click();
  await expect(flow).toHaveAttribute('data-step', 'done');
  await expect(page.getByTestId('guide-finished')).toBeVisible();
  await expect(flow).toContainText(GMAIL);
  await fits(page, '[data-testid="connect-page"]');
  await shot('finished');

  // the main helper's chat has the same card, finished; Settings shows the mailbox and what helpers may do
  await page.goto(`${server.url}/#/settings/inbox/mailbox`);
  await expect(page.getByTestId('mailbox-connected')).toContainText(GMAIL);
  await expect(page.getByTestId('guide-access-draft').locator('input')).toBeChecked();
  await fits(page, '[data-testid="mailbox-settings"]');
  await shot('settings');
});

test('make a new email: the helper’s checklist in its chat, sign-up in the owner’s browser, resume mid-way', async ({
  page,
  server,
}, info) => {
  const w = info.project.name === 'phone' ? 390 : 1440;
  const fil = loc('fil').guide;
  const shot = (s: string) => page.screenshot({ path: `${QA}w32-new-${s}-${w}-fil.png`, fullPage: true });
  await claim(page, server.setupLink);
  await startTeamSetup(page);
  await answerTeamSetup(page, ANSWERS('new'), { language: 'fil', name: 'Mayumi' });
  await page.getByTestId('stage-approve').click();
  // W40: "A few things need your OK" comes before the finish; Continue leaves them for later
  await passTeamOks(page);
  await expect(stageStep(page, 'done')).toBeVisible();
  await expect(page.getByTestId('stage-done-next')).toContainText('Mayumi');
  await shot('done');
  await page.getByTestId('stage-done-email').click();
  await expect(page).toHaveURL(/#\/chats\//);

  // the lead's own checklist card, in Filipino, one step at a time
  const card = page.getByTestId('guide-card');
  await expect(card).toBeVisible();
  const flow = card.getByTestId('guide');
  await expect(flow).toHaveAttribute('data-step', 'ideas');
  await expect(card.getByTestId('guide-say')).toHaveText(fil.say.ideas);
  // the ideas come from the business name the owner types, never from the helper's own name
  await expect(card.getByTestId('guide-ideas')).toHaveCount(0);
  await card.getByTestId('guide-team-name').fill('Reyes Hardware');
  await card.getByTestId('guide-ideas-show').click();
  const ideas = card.getByTestId('guide-idea');
  await expect(ideas).toHaveCount(3);
  for (const t of await ideas.allInnerTexts()) expect(t).toMatch(/^reyes.*@gmail\.com$/);
  // each idea copies with one tap; the step's button says "Susunod", not "Tapos na"
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.getByTestId('guide-idea-copy').first().click();
  await expect(card.getByTestId('guide-idea-copy').first()).toHaveText(fil.ideas.copied);
  await expect(card.getByTestId('guide-done')).toHaveText(fil.next);
  await expect(card).toContainText(fil.ideas.note);
  await fits(page, '[data-testid="guide-card"]');
  if (w === 390) await tapTargets(page, '[data-testid="guide-card"]');
  await shot('ideas');
  await card.getByTestId('guide-done').click();

  // sign-up happens in the owner's own browser; only they do it
  await expect(flow).toHaveAttribute('data-step', 'signup');
  // W43: "Do it with me" is the step's first choice; this run keeps the owner's own browser
  await expect(card.getByTestId('guide-withme-go')).toHaveText(fil.withMe.do);
  await card.getByTestId('guide-withme-mine').click();
  const signup = card.getByTestId('guide-signup-open');
  await expect(signup).toHaveAttribute('href', 'https://accounts.google.com/signup');
  await expect(signup).toHaveAttribute('target', '_blank');
  await expect(card.getByTestId('guide-only-you')).toHaveText(fil.signup.onlyYou);
  await expect(card).toContainText(fil.signup.ask4);
  await fits(page, '[data-testid="guide-card"]');
  await shot('signup');
  await card.getByTestId('guide-done').click();

  await expect(flow).toHaveAttribute('data-step', 'address');
  await card.getByTestId('guide-address').fill(GMAIL);
  await card.getByTestId('guide-address-next').click();
  await expect(flow).toHaveAttribute('data-step', 'guide');

  // a reload: the card picks up at the same step, from the server
  await page.reload();
  await expect(page.getByTestId('guide-card').getByTestId('guide')).toHaveAttribute('data-step', 'guide');
  await expect(page.getByTestId('guide-card')).toContainText(fil.apppw.title);
  await shot('resumed');
  await page.getByTestId('guide-card').getByTestId('guide-done').click();
  const card2 = page.getByTestId('guide-card');
  await expect(card2.getByTestId('guide')).toHaveAttribute('data-step', 'code');
  await card2.getByTestId('guide-code').fill(CODE.toUpperCase());
  await card2.getByTestId('guide-connect').click();
  await expect(card2.getByTestId('guide')).toHaveAttribute('data-step', 'access');
  await expect(card2.getByTestId('guide-connected')).toHaveText(fil.code.ok);
  await card2.getByTestId('guide-access-save').click();
  await expect(card2.getByTestId('guide')).toHaveAttribute('data-step', 'test');
  await card2.getByTestId('guide-done').click();
  await expect(card2.getByTestId('guide')).toHaveAttribute('data-step', 'done');
  await expect(card2.getByTestId('guide-finished')).toHaveText(fil.finished.title);
  await fits(page, '[data-testid="guide-card"]');
  await shot('finished');
});

for (const lng of ['en', 'fil'] as const)
  test(`${lng}: "Do it with me": the helper opens the sign-up in its own browser, the owner does the secret parts`, async ({
    page,
    server,
  }, info) => {
    test.setTimeout(180_000);
    const w = info.project.name === 'phone' ? 390 : 1440;
    const g = loc(lng).guide;
    const shot = (s: string) => page.screenshot({ path: `${QA}w43-${s}-${w}-${lng}.png`, fullPage: true });
    await claim(page, server.setupLink);
    await startTeamSetup(page);
    await answerTeamSetup(page, ANSWERS('new'), { language: lng, name: 'Mayumi' });
    await page.getByTestId('stage-approve').click();
    await passTeamOks(page);
    await expect(stageStep(page, 'done')).toBeVisible();
    await page.getByTestId('stage-done-email').click();
    await expect(page).toHaveURL(/#\/chats\//);
    // the managed browser may open the loopback fake sign-up page (the test-only safe-net allow-list)
    expect(
      await page.evaluate(() =>
        fetch('/api/m/browser/settings', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowHosts: ['127.0.0.1'] }),
        }).then((r) => r.status),
      ),
    ).toBe(200);

    const card = page.getByTestId('guide-card');
    const flow = card.getByTestId('guide');
    await card.getByTestId('guide-team-name').fill('Reyes Hardware');
    await card.getByTestId('guide-ideas-show').click();
    await expect(card.getByTestId('guide-idea')).toHaveCount(3);
    await card.getByTestId('guide-done').click();
    await expect(flow).toHaveAttribute('data-step', 'signup');

    // the step's first choice: confirm the names and pick an idea; the other way stays one tap away
    await expect(card.getByTestId('guide-withme-go')).toHaveText(g.withMe.do);
    await expect(card.getByTestId('guide-withme-mine')).toHaveText(g.withMe.mine);
    await card.getByTestId('guide-withme-first').fill('Ligaya');
    await card.getByTestId('guide-withme-last').fill('Santos');
    await card.getByTestId('guide-withme-idea').nth(1).check();
    await fits(page, '[data-testid="guide-card"]');
    if (w === 390) await tapTargets(page, '[data-testid="guide-card"]');
    await shot('start');
    await card.getByTestId('guide-withme-go').click();

    // the helper's own browser, live inside the checklist, and the owner's turn
    const live = card.getByTestId('guide-withme-live');
    await expect(live).toBeVisible({ timeout: 30_000 });
    await expect(live).toHaveAttribute('data-state', 'yours');
    await expect(live.getByRole('heading')).toHaveText(g.withMe.yourTurn);
    await expect(live.getByTestId('guide-withme-frame')).toHaveAttribute('src', /^data:image\/jpeg;base64,/, {
      timeout: 20_000,
    });
    // the hand-over card: "Your turn …", with Take over and Done, in the helper's chat
    const handOver = page
      .locator('.bk-hcard[data-variant="ok"]')
      .filter({ hasText: g.withMe.yourTurn })
      .last();
    await expect(handOver).toBeVisible();
    await expect(handOver.locator('[data-card-action="take"]')).toBeVisible();
    await expect(handOver.locator('[data-card-action="done"]')).toBeVisible();
    await fits(page, 'body');
    await shot('yours');
    expect(signupSubmits).toBe(0);

    // Take over: the owner drives the helper's browser on the Browser page
    await live.getByTestId('guide-withme-take').click();
    await expect(page).toHaveURL(/#\/browser\?profile=/);
    await expect(page.getByTestId('browser-page')).toBeVisible();
    await shot('takeover');
    await page.goBack();
    const live2 = page.getByTestId('guide-card').getByTestId('guide-withme-live');
    await expect(live2).toHaveAttribute('data-state', 'taken');
    await expect(live2).toContainText(g.withMe.taken.replace('{{name}}', 'Mayumi'));

    // Done: the checklist asks for the new address and goes on to the Gmail connect steps
    await live2.getByTestId('guide-withme-done').click();
    const flow2 = page.getByTestId('guide-card').getByTestId('guide');
    await expect(flow2).toHaveAttribute('data-step', 'address');
    await expect(handOver).toHaveAttribute('data-state', 'done');
    await fits(page, 'body');
    await shot('done');
    expect(signupSubmits).toBe(0);
  });
