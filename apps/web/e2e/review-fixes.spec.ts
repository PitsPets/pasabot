import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boot,
  claimServer,
  createFakeAgent,
  delta,
  done,
  expect,
  final,
  script,
  send,
  stop,
  test,
} from './fixtures.js';

const phone = (page: { viewportSize(): { width: number } | null }) =>
  (page.viewportSize()?.width ?? 0) <= 600;
const askBash = script([
  { expectPermission: { tool: 'Bash', input: { command: 'touch order.txt' }, decision: 'allow' } },
  final('Done.'),
  done,
]);

test('chat header: a human subtitle, never a raw id; no sample-module widgets in the real app', async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  await createFakeAgent(page);
  // on a phone the header is visually hidden but still in the page for screen readers
  // the line under the name is the state; the brain's human name is on the model pill beside it (polish B)
  const sub = page.locator('.ch .sub');
  await expect(sub).toHaveText('Ready');
  await expect(page.locator('.ch [data-testid="model-pill"]')).toContainText('Fake');
  expect(await page.locator('.ch').innerText()).not.toMatch(/[0-9A-Z]{26}/);
  await expect(page.locator('[data-slot]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Example' })).toHaveCount(0);
});

test('FIL: the approval title and the decision bar are translated; agent-written text stays as written', async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala', 'standard');
  await send(page, askBash);
  await expect(page.getByTestId('approval-card')).toContainText(
    'Tala wants to run a command on your computer',
  );
  await page.evaluate(() => localStorage.setItem('pasabot.lang', 'fil'));
  await page.reload();
  await expect(page.getByTestId('approval-card')).toContainText(
    'Gusto ni Tala na magpatakbo ng utos sa computer mo',
  );
  await expect(page.getByTestId('approval-card')).not.toContainText('wants to');
  await expect(page.getByTestId('decision-bar')).toContainText(
    'Gusto ni Tala na magpatakbo ng utos sa computer mo',
  );
  if (!phone(page)) {
    // the agent's own description is the owner's text: not translated (the details open from the chat header)
    await page.getByTestId('chat-who').click();
    // ("What Tala does" is its job line; the full text waits folded under More)
    await expect(page.getByTestId('details-summary')).toHaveText('Handles purchasing. Asks before ordering.');
  }
});

test('approval waiting: pinned decision bar above the log, queued chip visible, whole roster in reach', async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala', 'standard');
  await page.goto(`${server.url}/#/agents/new`);
  await createFakeAgent(page, 'Kidlat');
  // every agent has its own avatar in the chats list (the sidebar; the home screen on a phone)
  if (phone(page)) await page.goto(page.url().replace(/#.*$/, '#/'));
  const blobs = page.locator('[data-testid="roster-agent"]:visible .bk-blob');
  await expect(blobs).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect(blobs.nth(i)).toBeVisible();
    // W29: a generated avatar; its backdrop is the agent's accent colour
    expect(await blobs.nth(i).locator('svg rect').first().getAttribute('fill')).toMatch(/^#[0-9A-F]{6}$/);
  }
  await page.locator('[data-testid="roster-agent"]:visible', { hasText: 'Tala' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tala' })).toBeAttached();
  // the chat header says who the message goes to and on which brain (the composer no longer repeats it): the
  // brain is on the model pill (polish B)
  if (!phone(page)) await expect(page.locator('.ch [data-testid="model-pill"]')).toContainText('Fake');

  await send(page, askBash);
  const card = page.getByTestId('approval-card');
  const bar = page.getByTestId('decision-bar');
  await expect(card).toBeVisible();
  await expect(bar).toBeVisible();
  const log = (await page.getByTestId('chat-log').boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(log.y + 1);

  // a message queued behind the waiting decision shows as a chip, on every width
  // while busy there is no mode chooser: Send adds to the turn, and "Send after it finishes" sits in the menu by Send
  await expect(page.getByText('While busy')).toHaveCount(0);
  await page.getByTestId('composer').fill('next one please');
  await page.getByTestId('send-more').click();
  await page.getByRole('menuitem', { name: 'Send after it finishes' }).click();
  const chip = page.getByTestId('queue-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('1 queued');
  const vp = page.viewportSize()!;
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.x).toBeGreaterThanOrEqual(0);
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(vp.width);
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(vp.height);
});

test('after a crash and restart: no typing bubble, the partial text sits in the interrupted card', async ({
  page,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'pasabot-e2e-restart-'));
  const first = await boot({ PASABOT_E2E_HOME: home });
  let second: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    await claimServer(page, first.server);
    await createFakeAgent(page);
    await send(
      page,
      script([
        delta('Checking the supplier prices now', 0),
        { after: 600_000, event: { type: 'text.final', text: 'never' } },
      ]),
    );
    await expect(page.locator('[data-testid="msg-agent"][data-status="streaming"]')).toContainText(
      'Checking the supplier prices now',
    );
    // give the partial a moment to be saved, then pull the plug
    await page.waitForTimeout(700);
    first.child.kill('SIGKILL');
    await new Promise((r) => first.child.once('exit', r));

    second = await boot({ PASABOT_E2E_HOME: home });
    await page.goto(second.server.url);
    // a phone opens on the chats list
    if (phone(page)) await page.locator('[data-testid="roster-agent"]:visible').first().click();
    const card = page.getByTestId('interrupted-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('interrupted-partial')).toContainText('Checking the supplier prices now');
    await expect(card.getByTestId('interrupted-partial')).toContainText('Partial reply');
    await expect(page.locator('.typing')).toHaveCount(0);
    await expect(page.getByTestId('msg-agent')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Retry' })).toBeVisible();
  } finally {
    if (second) await stop(second.child);
    first.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(home, { recursive: true, force: true });
  }
});
