import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, done, expect, final, script, send, test } from './fixtures.js';

const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

test("agent A delegates to agent B, waits, and gets B's reply as the tool result", async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const talaChat = page.url();
  await page.goto(`${server.url}/#/agents/new`);
  await createFakeAgent(page, 'Ligaya');
  await page.goto(talaChat);
  await expect(page.getByTestId('composer')).toBeVisible();

  // a note first (Ligaya's queue gets work ahead of the delegated task), then the delegation
  await send(page, probe('collab_message', { to: 'Ligaya', text: 'Pakicheck ang stock ng lapis.' }));
  // a handoff is one plain line; the tool's raw result (JSON) is never shown in the bubble (W26)
  const handed = page.getByTestId('msg-agent').filter({ has: page.getByTestId('handoff') });
  await expect(handed).toHaveCount(1, {
    timeout: 15_000,
  });
  // the header line is the state alone now (the brain moved to the model pill): "Ready" there and on the avatar
  await expect(page.getByRole('region', { name: 'Tala' }).locator('.ch .sub')).toHaveText('Ready');
  await send(
    page,
    probe('collab_delegate', { to: 'Ligaya', task: 'Count the pens', wait: true, timeoutSec: 30 }),
  );
  const reply = handed.nth(1);
  await expect(reply).toBeVisible({ timeout: 30_000 });
  // B (a Fake brain) echoes the task it was given; A's tool call returns that reply, read plainly on the line
  await expect(reply.getByTestId('handoff-reply')).toContainText('Count the pens', { timeout: 30_000 });
  await expect(reply).not.toContainText('"state":"done"');

  // two messages typed back to back: the second, typed while the first is still being sent, is not lost
  // (the QA run lost its delegate message exactly there)
  await send(page, 'isa pa');
  await send(page, 'at isa pa ulit');
  await expect(page.getByTestId('msg-me').filter({ hasText: 'at isa pa ulit' })).toBeVisible();
  await expect(page.getByTestId('composer')).toHaveValue('');
  await noSideScroll(page);
});

test('sub-agent spans from the brain show in the chat log', async ({ page, server }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const sub = (state: 'start' | 'end') => ({
    event: { type: 'subagent', id: 's1', name: 'researcher', state },
  });
  await send(
    page,
    script([sub('start'), { after: 50, ...sub('end') }, final('Found three suppliers.'), done]),
  );
  const bubble = page.getByTestId('msg-agent').filter({ hasText: 'Found three suppliers.' });
  await expect(bubble.getByTestId('subagent-span')).toHaveText([
    'Sub-agent researcher started',
    'Sub-agent researcher finished',
  ]);
  // still there after a reload (spans come back from the run's stored events)
  await page.reload();
  await expect(
    page.getByTestId('msg-agent').filter({ hasText: 'Found three suppliers.' }).getByTestId('subagent-span'),
  ).toHaveCount(2);
  await noSideScroll(page);
});

test('a multi-agent channel: the Team sheet reassigns the lead, both agents reply, reactions show on bubbles', async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  await page.goto(`${server.url}/#/agents/new`);
  await createFakeAgent(page, 'Ligaya');
  const ids = await page.evaluate(async () => {
    const r = (await (await fetch('/api/v1/agents')).json()) as { agents: { id: string; name: string }[] };
    return Object.fromEntries(r.agents.map((a) => [a.name, a.id]));
  });
  const chat = await page.evaluate(
    async (d) =>
      (
        (await (
          await fetch('/api/v1/chats', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(d),
          })
        ).json()) as { chat: { id: string } }
      ).chat,
    { kind: 'channel', title: 'Purchasing', agentIds: [ids.Tala, ids.Ligaya], taskOwnerAgentId: ids.Tala },
  );
  await page.goto(`${server.url}/#/chats/${chat.id}`);
  await page.reload(); // the channel was made over REST, not in this page
  await expect(page.getByTestId('composer')).toBeVisible();

  // who wrote the agent replies of the channel (names, from the server)
  const repliers = () =>
    page.evaluate(
      async ({ chatId, names }) => {
        const r = (await (await fetch(`/api/v1/chats/${chatId}/messages`)).json()) as {
          messages: { authorKind: string; authorId: string; body: string; status: string }[];
        };
        return r.messages
          .filter((m) => m.authorKind === 'agent' && m.status === 'final')
          .map((m) => `${names[m.authorId] ?? '?'}: ${m.body}`);
      },
      { chatId: chat.id, names: Object.fromEntries(Object.entries(ids).map(([n, id]) => [id, n])) },
    );

  // the lead (Tala) answers people
  await send(page, 'hello team');
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'echo: hello team' })).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(repliers).toEqual(['Tala: echo: hello team']);

  // a reaction on a bubble
  const first = page.getByTestId('msg-agent').first();
  const messageId = await first.getAttribute('data-message-id');
  const r = await page.evaluate(
    async (id) =>
      (
        await fetch(`/api/m/collab/chats/${id.chat}/reactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId: id.message, emoji: '👍' }),
        })
      ).status,
    { chat: chat.id, message: messageId },
  );
  expect(r).toBeLessThan(300);
  await expect(first.getByTestId('reactions')).toContainText('👍');

  // Team sheet: make Ligaya the lead (Reassign); the Team controls open from the chat's More menu
  await page.locator('[data-testid$="chat-more-btn"]:visible').click();
  await page.locator('[data-testid="more-collab-team"]:visible').click();
  await page.getByTestId('collab-team-open').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await noSideScroll(page);
  await sheet.getByRole('button', { name: 'Make lead' }).first().click();
  await expect(page.getByText(/Ligaya.*lead|lead.*Ligaya/).first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // the next message goes to the new lead: both agents have now replied in the channel
  await send(page, 'second message');
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'echo: second message' })).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(repliers).toEqual(['Tala: echo: hello team', 'Ligaya: echo: second message']);
  await noSideScroll(page);
});
