/**
 * Regression (QA W16 → W17 → W18 in one session): computer use, then a voice message, then a site publish, all in
 * one chat. The publish request goes out while the voice reply is still being written, so it is steered into that
 * running turn ("Added to what Tala is doing now"). A steered message must still get its answer: the run answers
 * it before it ends, and once the run has said its final words a new message is queued for a turn of its own.
 * Before the fix the Fake brain took the steered text and dropped it, so the publish never got a reply.
 */
import type { Page } from '@playwright/test';
import {
  test as base,
  boot,
  claimServer,
  createFakeAgent,
  type E2EServer,
  expect,
  PASSWORD,
  send,
  stop,
} from './fixtures.js';

const test = base.extend<{ server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const { server, child } = await boot({
      PASABOT_VOICE_ENGINE: 'fake',
      PASABOT_COMPUTER_DRIVER: 'practice',
    });
    await use(server);
    await stop(child);
  },
});
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });

async function approveTier3(page: Page) {
  const card = page.getByTestId('approval-card').last();
  await expect(card).toContainText('Risky', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
  const sheet = page.getByRole('dialog', { name: "Confirm it's you" });
  const approved = card.getByTestId('approval-state').filter({ hasText: 'Approved' });
  await expect(sheet.or(approved)).toBeVisible();
  if (await sheet.isVisible()) {
    await sheet.getByLabel('Password').fill(PASSWORD);
    await sheet.getByRole('button', { name: 'Confirm and approve' }).click();
    // right after a screen action the server refuses every approve for 2 s ("Wait a moment"): confirm again
    const wait = sheet.getByText('Wait a moment — a helper just used the screen');
    await expect(approved.or(wait)).toBeVisible();
    if (await wait.isVisible()) {
      await page.waitForTimeout(2_100);
      await sheet.getByRole('button', { name: 'Confirm and approve' }).click();
    }
  }
  await expect(approved).toBeVisible();
}

test('computer use, a voice message and a site publish in one session all get their replies', async ({
  page,
  context,
  server,
}) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();
  const replies = page.getByTestId('msg-agent');

  // W16: two tier-3 computer actions, then the owner takes control and stops the display
  await send(page, probe('computer_screenshot', {}));
  await approveTier3(page);
  await expect(replies.filter({ hasText: '"width":640' }).first()).toBeVisible({ timeout: 15_000 });
  await send(page, probe('computer_click', { x: 320, y: 180 }));
  await approveTier3(page);
  await expect(replies.filter({ hasText: '"ok":true' }).first()).toBeVisible({ timeout: 15_000 });
  // Computer lives in Settings > Skills & tools
  await page.goto(`${server.url}/#/settings/tools`);
  await page.getByTestId('feature-computer').getByRole('link', { name: 'Computer' }).click();
  const display = page.locator('[data-computer-display]');
  await expect(display.getByRole('img', { name: "Tala's display" })).toBeVisible();
  await display.getByRole('button', { name: 'Take control' }).click();
  const frame = display.locator('[data-computer-frame]');
  const box = await frame.boundingBox();
  await frame.click({ position: { x: box!.width * 0.03, y: box!.height * 0.95 } });
  await expect(page.locator('[data-computer-action]').filter({ hasText: 'You' }).first()).toBeVisible();
  await display.getByRole('button', { name: 'Stop display' }).click();

  // W17: hold to talk, send the transcript
  await page.goto(chatUrl);
  await expect(replies).toHaveCount(2);
  await page.getByTestId('voice-talk').hover();
  await page.mouse.down();
  await expect(page.getByTestId('voice-status')).toHaveText('Listening… release to stop');
  await page.waitForTimeout(900);
  await page.mouse.up();
  const sheet = page.getByRole('dialog', { name: 'Your message' });
  await expect(sheet.getByLabel('What you said')).toHaveValue('hello from the test recogniser');
  await sheet.getByRole('button', { name: 'Send' }).click();
  await expect(sheet).toBeHidden();

  // W18 right away, while the voice reply is still being written: the request must get its answer either way
  const files = [{ path: 'index.html', content: '<!doctype html><title>Lunch</title><h1>Tanghalian</h1>' }];
  await send(page, probe('sites_publish', { title: 'Lunch menu', files, days: 1 }));
  const published = replies.filter({ hasText: 'tool said' }).filter({ hasText: '"url":' });
  await expect(published).toHaveCount(1, { timeout: 15_000 });
  const url = /"url":"([^"]+)"/.exec((await published.textContent()) ?? '')?.[1];
  expect(url).toBeTruthy();
  // the voice message keeps its own answer: a steered answer is added to the reply, never written over it
  await expect(replies.filter({ hasText: 'echo: hello from the test recogniser' })).toHaveCount(1);
  // nothing is left running: every reply in the chat is final and the composer takes a new message
  await expect(page.locator('[data-testid="msg-agent"]:not([data-status="final"])')).toHaveCount(0);
  await send(page, 'salamat');
  await expect(replies.filter({ hasText: 'echo: salamat' })).toHaveCount(1, { timeout: 15_000 });

  // the site really is up
  const tab = await context.newPage();
  await tab.goto(url!);
  await expect(tab.getByRole('heading', { name: 'Tanghalian' })).toBeVisible();
  await tab.close();
});
