/**
 * W25: Settings → Agent board with a mock board on 127.0.0.1 (no real board, no account). The owner connects the
 * board, a listed board agent's message reaches the agent and the reply goes back to the board, an unlisted board
 * agent gets nothing, the chat shows the board message, and the screen fits at 1440 and 390 px.
 */
import { type Page, test } from '@playwright/test';
import { MockBoard } from '../../../plugins/agentchat-bridge/src/__fixtures__/mock-board.js';
import { boot, claimServer, createFakeAgent, expect, stop } from './fixtures.js';

const TOKEN = 'board-token-e2e-0001';

async function fits(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await expect(page.getByTestId('agentchat-settings')).toBeVisible();
  const o = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="agentchat-settings"]')!;
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...root.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return el.childNodes.length > 0 && el.textContent?.trim() && Number.parseFloat(s.fontSize) < 12;
      }).length,
      smallTargets: [...root.querySelectorAll('button, a, select, input, textarea')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height < 44;
      }).length,
    };
  });
  expect(o.doc, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
  if (width <= 390) expect(o.smallTargets, 'tap targets under 44px').toBe(0);
}

test('agent board: connect, board → agent → board round trip, unlisted board agent dropped', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one run covers both viewports');
  test.setTimeout(120_000);
  const board = await new MockBoard([
    { id: 'pasabot', name: 'PasaBot', token: TOKEN },
    { id: 'scout', name: 'Scout', token: 'scout-token-e2e-01' },
    { id: 'builder', name: 'Builder', token: 'builder-token-e2e-1' },
  ]).start();
  const { server, child } = await boot();
  try {
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await page.goto(`${server.url}/#/settings/advanced/agentchat-bridge`);
    // the agent board is technical setup: with Technical words off the page says so; its switch opens it in place
    await expect(page.getByTestId('settings-technical-only')).toBeVisible();
    await page.getByTestId('settings-advanced').click();
    const section = page.getByTestId('agentchat-settings');
    await expect(section.getByRole('heading', { name: 'Agent board' })).toBeVisible();
    await expect(section.getByText('Board agents are never you.')).toBeVisible();

    await section.getByRole('button', { name: 'Connect a board' }).click();
    const form = page.getByTestId('agentchat-add-form');
    await form.getByLabel('Board address').fill(board.url);
    await expect(form.getByLabel('Board token')).toHaveAttribute('type', 'password');
    await form.getByLabel('Board token').fill(TOKEN);
    await form.getByLabel('Agent that answers').selectOption({ label: 'Tala' });
    await form.getByLabel('Board agents that may talk to it').fill('scout');
    await form.getByRole('button', { name: 'Connect' }).click();

    const card = section.getByTestId('agentchat-bridge');
    await expect(card.getByTestId('agentchat-status')).toHaveText('Connected', { timeout: 15_000 });
    await expect(card.getByTestId('agentchat-allowed')).toHaveText('scout');
    await expect(card).toContainText(board.url);
    await expect(page.locator('body')).not.toContainText(TOKEN);
    // the same binding is managed in Settings → Channels
    await page.goto(`${server.url}/#/settings/people/channels`);
    await expect(page.getByTestId('channels-settings').getByTestId('channel-binding')).toHaveCount(1);
    await page.goto(`${server.url}/#/settings/advanced/agentchat-bridge`);

    // a listed board agent writes to the bridge: the agent answers on the board, in the same thread
    const asked = board.post('scout', { to: 'pasabot', text: 'hello from scout on the board' });
    await expect
      .poll(() => board.textsFrom('pasabot').join(' '), { timeout: 30_000 })
      .toContain('hello from scout on the board');
    const reply = board.messages.find((m) => m.from.id === 'pasabot')!;
    expect(reply).toMatchObject({ to: 'scout', threadId: asked.threadId });

    // an unlisted board agent is dropped: no reply, no chat
    board.post('builder', { to: 'pasabot', text: 'builder wants in' });
    await page.waitForTimeout(7000);
    expect(board.messages.filter((m) => m.from.id === 'pasabot' && m.to === 'builder')).toEqual([]);
    // the dropped count is on the binding in Settings → Channels
    await page.goto(`${server.url}/#/settings/people/channels`);
    await expect(page.getByTestId('channel-binding')).toContainText('1 message from strangers dropped', {
      timeout: 10_000,
    });
    await page.goto(`${server.url}/#/settings/advanced/agentchat-bridge`);

    // the bridge's chat shows the board message
    await expect(card.getByRole('link', { name: 'Open chat' })).toHaveCount(1, { timeout: 10_000 });
    await fits(page, 1440);
    await fits(page, 390);
    await card.getByRole('link', { name: 'Open chat' }).click();
    await expect(page.getByText('hello from scout on the board').first()).toBeVisible();
  } finally {
    await stop(child);
    await board.stop();
  }
});
