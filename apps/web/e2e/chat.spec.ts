import { claimServer, createFakeAgent, delta, done, expect, final, script, send, test } from './fixtures.js';

test('setup link -> owner -> Fake agent -> streamed reply', async ({ page, server }) => {
  await claimServer(page, server);
  await createFakeAgent(page);
  await expect(page.getByTestId('conn').first()).toHaveAttribute('data-state', 'live');

  // a plain message: the Fake echoes it word by word
  await send(page, 'kumusta ka');
  await expect(page.getByTestId('msg-me').last()).toContainText('kumusta ka');
  const reply = page.getByTestId('msg-agent').last();
  await expect(reply).toContainText('echo: kumusta ka');
  await expect(reply).toHaveAttribute('data-status', 'final');

  // a slow script: the reply is seen while it streams, then final
  await send(
    page,
    script([
      // the gaps leave seconds to see it streaming, however slow the machine is
      delta('Six rolls left,', 50),
      delta(' good for', 2000),
      delta(' four days.', 2000),
      { event: { type: 'tool.call', id: 't1', name: 'inventory_lookup', input: {} } },
      { event: { type: 'tool.result', id: 't1', ok: true, summary: 'ok' } },
      final('Six rolls left, good for four days.'),
      done,
    ]),
  );
  const streaming = page.locator('[data-testid="msg-agent"][data-status="streaming"]');
  await expect(streaming).toContainText('Six rolls left');
  const last = page.getByTestId('msg-agent').last();
  await expect(last).toHaveAttribute('data-status', 'final', { timeout: 20_000 });
  await expect(last).toContainText('Six rolls left, good for four days.');
  // tool-activity summary line: a tool PasaBot has no friendly name for reads "Used a tool"; its raw id only with
  // Technical words on (relay.spec)
  await expect(last.getByTestId('activity')).toContainText('Used a tool');
  await expect(last.getByTestId('activity')).not.toContainText('inventory_lookup');
  // roster shows the agent free again
  if ((page.viewportSize()?.width ?? 0) > 600)
    await expect(page.getByTestId('roster-agent').first()).toHaveAttribute('data-status', 'idle');
});

test('reload mid-stream resumes the reply', async ({ page, server }) => {
  await claimServer(page, server);
  await createFakeAgent(page);
  const words = ['one', ' two', ' three', ' four', ' five', ' six', ' seven', ' eight'];
  // 1.5 s a word: the reload and the reconnect land mid-stream even on a loaded machine
  await send(page, script([...words.map((w) => delta(w, 1500)), final(words.join('')), done]));
  const streaming = page.locator('[data-testid="msg-agent"][data-status="streaming"]');
  await expect(streaming).toContainText('one two');
  await page.reload();
  // after the reload the same reply keeps streaming (live deltas carry the text so far), then lands final
  await expect(streaming).toContainText(/three|four|five|six/, { timeout: 15_000 });
  const last = page.getByTestId('msg-agent').last();
  await expect(last).toHaveAttribute('data-status', 'final', { timeout: 30_000 });
  await expect(last).toContainText('one two three four five six seven eight');
  await expect(page.getByTestId('conn').first()).toHaveAttribute('data-state', 'live');
});

test('390 px: no horizontal overflow, the log scrolls inside the chat', async ({ page, server }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await claimServer(page, server);
  const noOverflow = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    );
  expect(await noOverflow()).toBe(true);
  await createFakeAgent(page, 'Kidlat with a rather long agent name');
  for (let i = 0; i < 8; i++) {
    await send(page, `line ${i} ${'pakiusap '.repeat(i % 4)}`);
    // wait for each reply: a message sent mid-turn is steered into the running turn instead
    await expect(page.getByTestId('msg-agent').nth(i)).toHaveAttribute('data-status', 'final');
  }
  await expect(page.getByTestId('msg-agent').nth(7)).toContainText('echo: line 7');
  expect(await noOverflow()).toBe(true);
  // the composer stays on screen; the message list scrolls inside its own box
  const comp = await page.getByTestId('composer').boundingBox();
  expect(comp && comp.y + comp.height).toBeLessThanOrEqual(844);
  const log = page.getByTestId('chat-log');
  expect(await log.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // language toggle (Settings > Language & look > Language) switches system text
  const chatUrl = page.url();
  await page.goto(chatUrl.replace(/#.*$/, '#/settings'));
  await page
    .getByTestId('settings-home')
    .getByRole('link', { name: /Language & look/ })
    .click();
  await page.getByTestId('feature-language').getByRole('link').click();
  await page.locator('[data-testid="lang-select"]:visible').first().selectOption('fil');
  await expect(page.getByRole('heading', { name: 'Wika' })).toBeVisible();
  expect(await noOverflow()).toBe(true);
  await page.goto(chatUrl);
  await expect(page.getByTestId('composer')).toHaveAttribute('placeholder', /Mag-message kay/);
  expect(await noOverflow()).toBe(true);
});
