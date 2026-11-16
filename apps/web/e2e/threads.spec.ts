import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { claimServer, createFakeAgent, expect, send, test } from './fixtures.js';

/**
 * Report back + one chat per helper (owner: "di nirereport ng orchestrator ang findings ng ibang agents, and also
 * dapat nasa main chat na rin nila ang message ng orchestrator, nakalagay lang kung sino nag-message, parang thread"):
 * the main helper hands work on, the request shows in the other helper's own chat as a thread "From Mayumi", and the
 * main helper reports back in the owner's chat, saying whose answer it is, with the full answer one tap away. Two
 * helpers at once give one report; a helper that fails is reported too. Screenshots: `.qa/w50-*.png`.
 */
const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: `${QA}w50-${name}-${info.project.name}.png` });
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
const setLang = async (page: Page, base: string, lng: 'en' | 'fil') => {
  await page.goto(`${base}/#/settings/look/language`);
  await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
  await expect(page.locator('html')).toHaveAttribute('lang', lng);
};
const team = async (page: Page, base: string, names: string[]) => {
  const chats: Record<string, string> = {};
  for (const [i, n] of names.entries()) {
    if (i) await page.goto(`${base}/#/agents/new`);
    await createFakeAgent(page, n);
    chats[n] = page.url();
  }
  return chats;
};

for (const lng of ['en', 'fil'] as const) {
  const L =
    lng === 'en'
      ? {
          asked: 'Mayumi asked Ligaya to help',
          from: 'From Mayumi',
          credit: 'Answer from Ligaya',
          full: 'Show the full answer',
          finished: 'Ligaya finished:',
          open: 'Open in Ligaya’s chat',
          reply: 'Reply in thread',
          replying: 'Replying to Mayumi’s request',
        }
      : {
          asked: 'Nagpatulong si Mayumi kay Ligaya',
          from: 'Mula kay Mayumi',
          credit: 'Sagot ni Ligaya',
          full: 'Ipakita ang buong sagot',
          finished: 'Tapos na si Ligaya:',
          open: 'Buksan sa chat ni Ligaya',
          reply: 'Sumagot dito',
          replying: 'Sumasagot sa hiling ni Mayumi',
        };

  test(`${lng}: the main helper hands work on, the request is a thread in the other’s chat, and it reports back`, async ({
    page,
    server,
  }, info) => {
    test.setTimeout(150_000);
    const phone = info.project.name === 'phone';
    if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
    await claimServer(page, server);
    const chats = await team(page, server.url, ['Mayumi', 'Ligaya']);
    await setLang(page, server.url, lng);
    await page.goto(chats.Mayumi!);
    await expect(page.getByTestId('composer')).toBeVisible();

    await send(page, probe('collab_delegate', { to: 'Ligaya', task: 'Count the pens' }));
    // Mayumi's turn: one calm line, never the raw tool result
    const asked = page
      .getByTestId('msg-agent')
      .filter({ has: page.getByTestId('handoff') })
      .first();
    await expect(asked.getByTestId('handoff')).toContainText(L.asked, { timeout: 30_000 });
    await expect(asked).not.toContainText('taskId');

    // the report: Mayumi's own message, saying whose answer it carries; the full answer one tap away
    const report = page.getByTestId('msg-agent').filter({ has: page.getByTestId('report-from') });
    await expect(report).toHaveCount(1, { timeout: 30_000 });
    await expect(report.getByTestId('report-from')).toHaveText(L.credit);
    await expect(report.getByTestId('msg-text')).toContainText('Count the pens');
    await expect(page.getByTestId('report-status')).toHaveCount(0);
    // one helper's short answer is already said in the report: no fold that repeats it, only the way to her chat
    await expect(report.getByTestId('report-full')).toHaveCount(0);
    await expect(report).not.toContainText(L.finished);
    const open = report.getByTestId('report-links').getByTestId('report-open-thread');
    await expect(open).toHaveText(L.open);
    const box = await open.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await report.scrollIntoViewIfNeeded();
    await shot(page, info, `${lng}-report`);
    await noSideScroll(page);

    // no "Team talk" list of helper-to-helper chats any more
    if (phone) await page.goto(page.url().replace(/#.*$/, '#/'));
    const list = page.locator('[data-testid="chats-list"]:visible');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('team-talk-toggle')).toHaveCount(0);
    await expect(list.getByRole('link', { name: /→/ })).toHaveCount(0);
    // Ligaya's row: a dot for the request she got (until her chat is opened)
    const ligRow = list
      .getByTestId('roster-agent')
      .filter({ has: page.locator('.n', { hasText: /^Ligaya$/ }) });
    await expect(ligRow.getByTestId('row-unread')).toBeVisible();
    await shot(page, info, `${lng}-list`);
    await noSideScroll(page);

    // the link opens that exact thread in Ligaya's own chat
    await page.goto(chats.Mayumi!);
    const again = page.getByTestId('msg-agent').filter({ has: page.getByTestId('report-from') });
    const link = again.getByTestId('report-open-thread');
    await expect(link).toHaveText(L.open);
    await link.click();
    const thread = page.getByTestId('thread');
    await expect(thread).toHaveCount(1);
    await expect(thread.getByTestId('thread-from')).toContainText(L.from);
    await expect(thread.getByTestId('thread-ask')).toHaveText('Count the pens');
    // her work and answer sit under the request, labelled as hers (not the owner's bubble)
    await expect(thread.getByTestId('msg-agent')).toContainText('echo: Count the pens');
    await expect(thread.getByTestId('msg-me')).toHaveCount(0);
    await expect(thread).toHaveClass(/thread--focus/);
    await shot(page, info, `${lng}-thread`);
    await noSideScroll(page);

    // the owner replies in the thread: marked as theirs, answered there
    await thread.getByTestId('thread-reply').click();
    await expect(thread.getByTestId('thread-reply')).toHaveText(L.reply);
    await expect(page.getByTestId('composer-thread')).toContainText(L.replying);
    await send(page, 'Salamat, ilan ang pula?');
    await expect(thread.getByTestId('msg-me')).toContainText('Salamat, ilan ang pula?');
    await expect(thread.getByTestId('msg-agent').filter({ hasText: 'echo: Salamat' })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('composer-thread')).toHaveCount(0);
    await shot(page, info, `${lng}-thread-reply`);
    await noSideScroll(page);

    // the handoff line in Mayumi's chat links to the same thread
    await page.goto(chats.Mayumi!);
    const line = page.getByTestId('handoff').first();
    if ((await line.getAttribute('open')) === null) await line.locator('summary').click();
    await expect(line.getByTestId('handoff-open')).toHaveText(L.open);
  });
}

test('while a helper works on another’s request, its row says for whom (en, fil)', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  const chats = await team(page, server.url, ['Mayumi', 'Ligaya']);
  await page.goto(chats.Mayumi!);
  await expect(page.getByTestId('composer')).toBeVisible();
  // Ligaya takes a while on Mayumi's request
  const slow = JSON.stringify({
    fakeScript: [
      { after: 45_000, event: { type: 'text.final', text: 'twelve pens' } },
      { event: { type: 'done', stop: 'end' } },
    ],
  });
  await send(page, probe('collab_delegate', { to: 'Ligaya', task: slow }));
  await expect(page.getByTestId('report-status')).toBeVisible({ timeout: 30_000 });
  const row = async () => {
    if (phone) await page.goto(`${server.url}/#/`);
    else await page.goto(chats.Mayumi!);
    const list = page.locator('[data-testid="chats-list"]:visible');
    await expect(list).toBeVisible();
    return list.getByTestId('roster-agent').filter({ has: page.locator('.n', { hasText: /^Ligaya$/ }) });
  };
  let lig = await row();
  await expect(lig.getByTestId('working-for')).toHaveText('Working for Mayumi', { timeout: 20_000 });
  await expect(lig).toHaveAttribute('data-status', 'working');
  // the asker's own row never says it works for anyone
  const may = page
    .locator('[data-testid="chats-list"]:visible')
    .getByTestId('roster-agent')
    .filter({ has: page.locator('.n', { hasText: /^Mayumi$/ }) });
  await expect(may.getByTestId('working-for')).toHaveCount(0);
  await shot(page, info, 'working-for-en');
  await setLang(page, server.url, 'fil');
  lig = await row();
  await expect(lig.getByTestId('working-for')).toHaveText('Tinutulungan si Mayumi', { timeout: 20_000 });
  await shot(page, info, 'working-for-fil');
  await noSideScroll(page);
});

test('an answer the main helper waited for in its own turn is credited too, with the way to the thread', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  const chats = await team(page, server.url, ['Mayumi', 'Ligaya']);
  await page.goto(chats.Mayumi!);
  await expect(page.getByTestId('composer')).toBeVisible();
  // real brains often wait for the answer inside the turn (wait: true, collab_wait): same credit, same link
  await send(page, probe('collab_delegate', { to: 'Ligaya', task: 'Count the pens', wait: true }));
  const report = page.getByTestId('msg-agent').filter({ has: page.getByTestId('report-from') });
  await expect(report).toHaveCount(1, { timeout: 30_000 });
  await expect(report.getByTestId('report-from')).toHaveText('Answer from Ligaya');
  await expect(report.getByTestId('report-open-thread')).toHaveText('Open in Ligaya’s chat');
  await page.waitForTimeout(1500);
  await expect(report).toHaveCount(1);
  await report.getByTestId('report-open-thread').click();
  await expect(page.getByTestId('thread').getByTestId('thread-ask')).toHaveText('Count the pens');
  await shot(page, info, 'in-turn-credit');
  await noSideScroll(page);
});

test('two helpers at once give one report; a helper that fails is reported too', async ({
  page,
  server,
}, info) => {
  test.setTimeout(150_000);
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  const chats = await team(page, server.url, ['Mayumi', 'Ligaya', 'Tala']);
  await page.goto(chats.Mayumi!);
  await expect(page.getByTestId('composer')).toBeVisible();

  // one turn asks both: one report, once both are back
  await send(
    page,
    JSON.stringify({
      fakeScript: [
        { callTool: { name: 'collab_delegate', args: { to: 'Ligaya', task: 'Count the pens' } } },
        { callTool: { name: 'collab_delegate', args: { to: 'Tala', task: 'Count the paper' } } },
      ],
    }),
  );
  const reports = page.getByTestId('msg-agent').filter({ has: page.getByTestId('report-from') });
  await expect(reports).toHaveCount(1, { timeout: 40_000 });
  await expect(reports.getByTestId('report-from')).toHaveText('Answers from Ligaya and Tala');
  // both short answers are already in the report's words: no fold, a way to each helper's chat
  await expect(reports.getByTestId('msg-text')).toContainText('echo: Count the paper');
  await expect(reports.getByTestId('report-full')).toHaveCount(0);
  await expect(reports.getByTestId('report-open-thread')).toHaveCount(2);
  await page.waitForTimeout(1500);
  await expect(reports).toHaveCount(1);
  await reports.scrollIntoViewIfNeeded();
  await shot(page, info, 'two-helpers');
  await noSideScroll(page);

  // a helper whose brain fails: the report still comes, and says it could not finish
  const crash = JSON.stringify({
    fakeScript: [
      { event: { type: 'error', kind: 'crash', message: 'brain crashed' } },
      { event: { type: 'done', stop: 'error' } },
    ],
  });
  await send(page, probe('collab_delegate', { to: 'Tala', task: crash }));
  await expect(reports).toHaveCount(2, { timeout: 40_000 });
  const failed = reports.nth(1);
  await expect(failed.getByTestId('report-from')).toHaveText('Answer from Tala');
  // nothing more to read than the report says: no fold, only the way to Tala's chat
  await expect(failed.getByTestId('report-full')).toHaveCount(0);
  await expect(failed.getByTestId('report-open-thread')).toHaveText('Open in Tala’s chat');
  await failed.scrollIntoViewIfNeeded();
  await shot(page, info, 'helper-failed');
  await noSideScroll(page);
});
