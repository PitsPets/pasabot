import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { claimServer, createFakeAgent, done, expect, final, script, send, test } from './fixtures.js';

/**
 * Helpers talking to each other stay out of the way (owner, "ayaw ko pag nag rerelay ng message"): a handoff in the
 * owner's chat is one calm line that opens to what was asked, the reply and a link to that request in the other
 * helper's own chat (a thread there since ws/threads: no "Team talk" list of helper-to-helper chats any more), tool
 * lines use friendly names (raw ids only with Technical words on), and a reply's Markdown is drawn (no "**Approve**").
 * Screenshots: `.qa/w22-relay-*.png`.
 */
const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: `${QA}w22-relay-${name}-${info.project.name}.png` });
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
/** under 600 px the chats list is the home page: go there (Back), else it is the sidebar */
const toList = async (page: Page, phone: boolean) => {
  if (phone) await page.goto(page.url().replace(/#.*$/, '#/'));
  // the phone's home holds the list as the page (the hidden sidebar has one too)
  const list = page.locator('[data-testid="chats-list"]:visible');
  await expect(list).toBeVisible();
  return list;
};

test('helpers handing work to each other: one calm line, a thread in the other’s chat, friendly tool names, Markdown', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const talaChat = page.url();
  await page.goto(`${server.url}/#/agents/new`);
  await createFakeAgent(page, 'Ligaya');
  await page.goto(talaChat);
  await expect(page.getByTestId('composer')).toBeVisible();

  // a built-in tool reads as plain words, never its id
  await send(page, probe('collab_agents', {}));
  const first = page.getByTestId('msg-agent').filter({ hasText: 'tool said' }).first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(first.getByTestId('activity')).toContainText('Checked the team');
  await expect(first.getByTestId('activity')).not.toContainText('collab_agents');

  // Tala hands work to Ligaya: one line with both avatars, no tool line for it
  await send(
    page,
    probe('collab_delegate', { to: 'Ligaya', task: 'Count the pens', wait: true, timeoutSec: 30 }),
  );
  const asked = page
    .getByTestId('msg-agent')
    .filter({ has: page.getByTestId('handoff') })
    .first();
  await expect(asked).toBeVisible({ timeout: 30_000 });
  const line = asked.getByTestId('handoff');
  // the tool's raw result never shows under the line (W26): the line says it plainly
  await expect(line.getByTestId('handoff-reply')).toBeAttached({ timeout: 30_000 });
  await expect(asked).not.toContainText('tool said');
  await expect(asked).not.toContainText('taskId');
  await expect(line).toContainText('Tala asked Ligaya to help');
  await expect(asked.getByTestId('activity')).toHaveCount(0);
  await expect(line.locator('.handoff-q')).toBeHidden();
  await line.locator('summary').click();
  await expect(line.locator('.handoff-q')).toHaveText('Count the pens');
  await expect(line.getByTestId('handoff-reply')).toBeVisible();
  await expect(line.getByTestId('handoff-open')).toHaveText('Open in Ligaya’s chat');
  const box = await line.locator('summary').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await line.scrollIntoViewIfNeeded();
  await shot(page, info, 'handoff');
  await noSideScroll(page);

  // the chats list: the people's own chats only, and no "Team talk" list of helper-to-helper chats
  const list = await toList(page, phone);
  await expect(list.getByRole('link', { name: /→/ })).toHaveCount(0);
  await expect(list.getByTestId('team-talk-toggle')).toHaveCount(0);
  await shot(page, info, 'list');
  await noSideScroll(page);

  // the request is a thread in Ligaya's own chat, from Tala, with her answer under it; the owner can still write
  await page.goto(talaChat);
  const open = page.getByTestId('handoff').first();
  // on a desktop the chat stayed mounted (the line is still open): open it only when it is closed
  if ((await open.getAttribute('open')) === null) await open.locator('summary').click();
  await open.getByTestId('handoff-open').click();
  const thread = page.getByTestId('thread');
  await expect(thread.getByTestId('thread-from')).toContainText('From Tala');
  await expect(thread.getByTestId('thread-ask')).toHaveText('Count the pens');
  await expect(thread.getByTestId('msg-agent')).toContainText('Count the pens');
  await expect(page.getByTestId('composer')).toBeEditable();
  await shot(page, info, 'team-chat');
  await noSideScroll(page);

  // a reply's Markdown is drawn: bold and a list, no asterisks
  await page.goto(talaChat);
  await send(
    page,
    script([final('Para mabuo sila, i-tap ang **Approve** sa card.\n\n- Taga-hanap\n- Taga-budget'), done]),
  );
  const md = page.getByTestId('msg-agent').last().getByTestId('msg-text');
  await expect(md.locator('strong')).toHaveText('Approve', { timeout: 20_000 });
  await expect(md).not.toContainText('**');
  await expect(md.locator('li')).toHaveCount(2);
  await shot(page, info, 'markdown');
  await noSideScroll(page);

  // with Technical words on, the raw tool ids come back
  await page.evaluate(() =>
    fetch('/api/v1/me/prefs/ui.advanced', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true }),
    }),
  );
  await page.reload();
  await expect(
    page.getByTestId('msg-agent').filter({ hasText: 'tool said' }).first().getByTestId('activity'),
  ).toContainText('collab_agents');
});
