/**
 * W23 in a real browser (1440 and 390 px): the owner invites a guest to one chat from People, the guest accepts the
 * link signed out and sees only that chat (and only its agent), writes in it, and the owner removes them from the
 * chat's People sheet. A second test: a member imports a shared agent into their own chat.
 */
import type { Browser, Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, send, test } from './fixtures.js';

/** a chat in the chats list: an agent's row when the viewer knows the agent, a plain chat row otherwise */
const CHAT_ROW = '[data-testid="chat-link"]:visible, [data-testid="roster-agent"]:visible';

const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

async function makeInvite(page: Page, kind: 'Guest' | 'Member', chat?: string) {
  await page.goto(`${new URL(page.url()).origin}/#/people`);
  const form = page.getByTestId('people-invite-form');
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: kind, exact: true }).click();
  if (chat) await form.getByLabel(chat, { exact: true }).check();
  await form.getByRole('button', { name: 'Create invite link' }).click();
  const link = await form.getByLabel('Invite link').inputValue();
  expect(link).toContain('/#/join?invite=');
  return link;
}

/**
 * Owner-only core Settings features typed in by a member or guest: the plain owner-only note, never the trust
 * level, the always-asks form, the owner's hidden list or a pin switch (regression: deep links skipped the role).
 */
async function ownerOnlyDeepLinks(page: Page, url: string) {
  for (const path of ['safety/trust', 'safety/always-asks', 'advanced/hidden-features']) {
    await page.goto(`${url}/#/settings/${path}`);
    await expect(page.getByTestId('owner-only-page')).toBeVisible();
    await expect(page.getByTestId('default-trust')).toHaveCount(0);
    await expect(page.getByTestId('always-asks')).toHaveCount(0);
    await expect(page.getByTestId('hidden-features')).toHaveCount(0);
    await expect(page.locator('[data-testid^="pin-"]')).toHaveCount(0);
  }
}

async function join(
  browser: Browser,
  link: string,
  name: string,
  viewport: { width: number; height: number },
) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByTestId('people-join')).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Choose a password').fill('guest password 1');
  await page.getByLabel('Password again').fill('guest password 1');
  await page.getByRole('button', { name: 'Join' }).click();
  // the accept page reloads into the signed-in app
  await expect(page.getByTestId('people-join')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('load');
  return { ctx, page };
}

test('a guest invited to one chat sees only it; the owner removes them', async ({
  page,
  server,
  browser,
}) => {
  const viewport = page.viewportSize()!;
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const talaChat = page.url();
  await page.goto(`${server.url}/#/agents/new`);
  await createFakeAgent(page, 'Lihim');

  const link = await makeInvite(page, 'Guest', 'Tala');
  await noSideScroll(page);
  // tap targets on the invite form are at least 44 px tall
  const h = await page.getByRole('button', { name: 'Create invite link' }).boundingBox();
  expect(h!.height).toBeGreaterThanOrEqual(44);

  const g = await join(browser, link, 'Bisita', viewport);
  try {
    const links = g.page.locator(CHAT_ROW);
    await expect(links).toHaveCount(1, { timeout: 15_000 });
    await expect(g.page.getByText('Lihim')).toHaveCount(0);
    // the list is off-screen on a phone while a chat is open: open the one chat by its link
    await g.page.goto(`${server.url}/${await links.first().getAttribute('href')}`);
    await send(g.page, 'hello from the guest');
    await expect(g.page.getByTestId('chat-log').getByText('hello from the guest')).toBeVisible();
    await noSideScroll(g.page);

    // the owner sees the guest in the chat's People sheet and removes them
    await page.goto(talaChat);
    // People in this chat lives in the chat's More menu
    await page.locator('[data-testid$="chat-more-btn"]:visible').first().click();
    await page.getByTestId('more-people').click();
    await page.getByTestId('people-chat-button').click();
    const sheet = page.getByTestId('people-chat-list');
    await expect(sheet.getByText('Bisita', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Bisita' }).click();
    await expect(sheet.getByText('Bisita', { exact: true })).toHaveCount(0);

    await g.page.reload();
    await expect(g.page.locator(CHAT_ROW)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await g.ctx.close();
  }
});

test('a member opens a chat with an agent the owner shared', async ({ page, server, browser }) => {
  const viewport = page.viewportSize()!;
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const link = await makeInvite(page, 'Member');
  await page.getByTestId('people-agents').getByLabel('Let members use Tala').click();
  await expect(page.getByTestId('people-agents').getByLabel('Let members use Tala')).toBeChecked();

  const m = await join(browser, link, 'Maya', viewport);
  try {
    await expect(m.page.locator(CHAT_ROW)).toHaveCount(0, { timeout: 15_000 });
    await m.page.goto(`${server.url}/#/people`);
    await m.page.getByRole('button', { name: 'Chat with Tala' }).click();
    await expect(m.page.getByTestId('composer')).toBeVisible();
    await send(m.page, 'kumusta si Maya');
    // the Fake brain echoes the member's words back
    await expect(m.page.getByText('kumusta si Maya').nth(1)).toBeVisible({ timeout: 15_000 });
    await noSideScroll(m.page);
    await ownerOnlyDeepLinks(m.page, server.url);
    // signed out, the login form remembers who this device belongs to
    await m.ctx.clearCookies();
    await m.page.goto(`${server.url}/#/login`);
    await m.page.reload();
    await expect(m.page.getByTestId('login-account')).toContainText('Signing in as Maya');
    await m.page.getByLabel('Password').fill('guest password 1');
    await m.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(m.page.locator(CHAT_ROW)).toHaveCount(1, { timeout: 15_000 });
  } finally {
    await m.ctx.close();
  }
});

test('W39: a read-only guest gets a disabled composer that says so, and no owner pages or forms', async ({
  page,
  server,
  browser,
}) => {
  const viewport = page.viewportSize()!;
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  await page.goto(`${server.url}/#/people`);
  const form = page.getByTestId('people-invite-form');
  await form.getByRole('button', { name: 'Guest', exact: true }).click();
  await form.getByLabel('Tala', { exact: true }).check();
  await form.getByRole('button', { name: 'Read only' }).click();
  await form.getByRole('button', { name: 'Create invite link' }).click();
  const link = await form.getByLabel('Invite link').inputValue();

  const g = await join(browser, link, 'Bisita', viewport);
  try {
    const links = g.page.locator(CHAT_ROW);
    await expect(links).toHaveCount(1, { timeout: 15_000 });
    // the row is only on screen on the chats list: keep its link for later
    const chatHref = await links.first().getAttribute('href');
    // the owner's pages are not in the guest's list (Safety, Budget, Admin, Skills); People is
    await g.page.goto(`${server.url}/#/settings/people`);
    await expect(g.page.getByTestId('feature-people')).toBeVisible();
    for (const id of ['safety', 'budget', 'admin', 'skills'])
      await expect(g.page.getByTestId(`feature-${id}`)).toHaveCount(0);
    for (const group of ['safety', 'spending', 'tools'])
      await expect(g.page.getByTestId(`settings-group-${group}`)).toHaveCount(0);
    // a typed-in owner page says plainly it is the owner's, with no forms that would only fail
    await g.page.goto(`${server.url}/#/budget`);
    await expect(g.page.getByTestId('owner-only-page')).toContainText('Only the owner can use this page.');
    await expect(g.page.getByTestId('budget-bundle')).toHaveCount(0);
    await g.page.goto(`${server.url}/#/safety`);
    await expect(g.page.getByTestId('owner-only-page')).toBeVisible();
    await expect(g.page.getByTestId('safety-page')).toHaveCount(0);
    // settings: language and account only, never the owner's safety forms; no stop button in the top bar
    await g.page.goto(`${server.url}/#/settings`);
    await expect(g.page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(g.page.getByTestId('always-asks')).toHaveCount(0);
    await expect(g.page.getByTestId('default-trust')).toHaveCount(0);
    await noSideScroll(g.page);
    await ownerOnlyDeepLinks(g.page, server.url);

    // the read-only chat: a disabled composer with a clear note, never a generic error
    await g.page.goto(`${server.url}/${chatHref}`);
    await expect(g.page.getByTestId('readonly-note')).toContainText(
      'You can read this chat, but not write in it.',
    );
    await expect(g.page.getByTestId('composer')).toBeDisabled();
    await expect(g.page.getByText('Something went wrong')).toHaveCount(0);
    await noSideScroll(g.page);
  } finally {
    await g.ctx.close();
  }
});
