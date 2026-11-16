// W16 macOS in a real browser: the shared e2e server runs the macOS driver (`PASABOT_COMPUTER_DRIVER=macos`)
// against a fake PasaBot Screen Helper (src/helper/fake.ts: the real socket protocol, the reference guard, the
// practice test app as its "screen"), so the owner's cards are proven on any OS without touching a real screen:
// the setup card in the agent's chat ("Let Tala use this computer?" → password → step cards whose ticks turn on as
// each System Settings pane is "opened" → Try it), the approval card's picture with the red ring where it will
// click, the typed-text card, and the "watch live" card. Screenshots go to `.qa/` (git-ignored).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';
import { FakeHelper } from '../src/helper/fake.js';

type E2EServer = { url: string; setupLink: string; fake: FakeHelper };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
// where screenshots go (a git-ignored folder at the repo root unless PASABOT_QA_DIR says otherwise)
const QA = process.env.PASABOT_QA_DIR ?? fileURLToPath(new URL('../../../.qa', import.meta.url));

const test = base.extend<{ server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-e2e-h-'));
    const fake = new FakeHelper({ dir: join(dir, 'run'), autoGrantMs: 400 });
    await fake.start();
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PASABOT_COMPUTER_DRIVER: 'macos', PASABOT_SCREEN_HELPER_DIR: fake.paths.dir },
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
    });
    await use({ ...(JSON.parse(line) as { url: string; setupLink: string }), fake });
    child.stdin?.end();
    child.kill('SIGTERM');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

const PASSWORD = 'correct horse battery';
async function claimServer(page: Page, server: E2EServer) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
}
async function createFakeAgent(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Uses my Mac for me.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
const shot = async (page: Page, name: string, project: string, el?: ReturnType<Page['locator']>) => {
  mkdirSync(QA, { recursive: true });
  const path = join(QA, `w34-${name}-${project}.png`);
  if (el) await el.screenshot({ path });
  else await page.screenshot({ path, fullPage: false });
};
async function approve(page: Page) {
  const card = page.getByTestId('approval-card').last();
  await card.getByRole('button', { name: /^(Approve|Allow)/ }).click();
  const sheet = page.getByRole('dialog', { name: "Confirm it's you" });
  const approved = card.getByTestId('approval-state').filter({ hasText: 'Approved' });
  await expect(sheet.or(approved)).toBeVisible();
  if (await sheet.isVisible()) {
    // a real password field: the Screen Helper never types into secure input, so it cannot fake this re-auth
    await expect(sheet.getByLabel('Password')).toHaveAttribute('type', 'password');
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

test('macOS: setup card in the chat, step cards with live ticks, Try it, approval picture and the live card', async ({
  page,
  server,
}, info) => {
  const p = info.project.name;
  const phone = p === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');

  // 1. Tala asks before it was set up: no approval card, a setup card instead
  await send(page, probe('computer_click', { x: 300, y: 170 }));
  const setup = page.locator('[data-computer-chat-card="setup"]');
  await expect(setup).toBeVisible({ timeout: 15_000 });
  await expect(setup.getByRole('heading', { name: 'Let Tala use this computer?' })).toBeVisible();
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
  await expect(setup.getByRole('button', { name: 'Not now' })).toBeVisible();
  await setup.scrollIntoViewIfNeeded();
  await shot(page, 'setup-ask', p);
  await noSideScroll(page);

  // 2. the password, then step cards; each tick turns on as the owner "flips the switch" in Settings
  await expect(setup.getByLabel('Your password')).toHaveAttribute('type', 'password');
  await setup.getByLabel('Your password').fill(PASSWORD);
  const yes = setup.getByRole('button', { name: 'Yes, set it up' });
  if (phone) expect((await yes.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await yes.click();
  await expect(setup.getByRole('heading', { name: 'Set up this computer for Tala' })).toBeVisible();
  await expect(setup.locator('[data-computer-step="helper"]')).toHaveAttribute('data-done', 'true');
  await expect(setup.locator('[data-computer-step="screen"]')).toHaveAttribute('data-done', 'false');
  await shot(page, 'setup-steps', p);
  await setup.getByRole('button', { name: 'Open Screen Recording settings' }).click();
  await expect(setup.locator('[data-computer-step="screen"]')).toHaveAttribute('data-done', 'true', {
    timeout: 10_000,
  });
  await setup.getByRole('button', { name: 'Open Accessibility settings' }).click();
  await expect(setup.locator('[data-computer-step="access"]')).toHaveAttribute('data-done', 'true', {
    timeout: 10_000,
  });
  expect(server.fake.opened).toEqual([
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  ]);

  // 3. Try it: one harmless picture, shown in the card
  await setup.getByRole('button', { name: 'Take a test picture' }).click();
  await expect(setup.locator('[data-computer-try]')).toBeVisible();
  await expect(setup).toContainText('It works. This is what Tala would see.');
  await expect
    .poll(() => setup.locator('[data-computer-try]').evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBe(640);
  await shot(page, 'setup-ready', p, setup);
  await noSideScroll(page);

  // 4. a click: the approval card shows where, with a red ring on the newest picture
  await send(page, probe('computer_click', { x: 300, y: 170 }));
  const card = page.getByTestId('approval-card').last();
  await expect(card).toContainText('Risky', { timeout: 15_000 });
  const pv = card.locator('[data-computer-preview="computer_click"]');
  await expect(pv).toContainText('It will click the red ring.');
  await expect(pv.locator('[data-computer-preview-mark]')).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'approval-click', p, card);
  await approve(page);
  await expect.poll(() => server.fake.screen.app.presses, { timeout: 15_000 }).toBe(1);

  // 5. the live card: watch, take over, stop
  const live = page.locator('[data-computer-chat-card="live"]');
  await expect(live).toBeVisible({ timeout: 15_000 });
  await expect(live).toContainText('Tala is using your computer');
  await expect(live.getByRole('button', { name: 'Take over' })).toBeVisible();
  await expect(live.getByRole('button', { name: 'Stop' })).toBeVisible();
  await live.scrollIntoViewIfNeeded();
  await shot(page, 'live', p, live);

  // 6. typing: the card says how many characters and shows the text; the helper refuses a password box
  server.fake.secureInput = true;
  await send(page, probe('computer_type', { text: 'hello po' }));
  const typeCard = page.getByTestId('approval-card').last();
  await expect(typeCard.locator('[data-computer-preview="computer_type"]')).toContainText(
    'It will type 8 characters:',
    { timeout: 15_000 },
  );
  await shot(page, 'approval-type', p, typeCard);
  await approve(page);
  await expect(page.getByTestId('msg-agent').last()).toContainText('password box', { timeout: 15_000 });
  expect(server.fake.screen.app.typed).toBe('');
  server.fake.secureInput = false;
  await noSideScroll(page);

  // 7. the Computer screen shows the same card, ready, and the live display
  await page.goto(`${server.url}/#/computer`);
  const pageCard = page.locator(`[data-computer-setup-card]`).first();
  await expect(pageCard).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('[data-computer-display]')).toHaveCount(1);
  await shot(page, 'computer-page', p);
  await noSideScroll(page);

  // 8. Stop on the live card closes the display
  await page.goBack();
  await expect(live).toBeVisible();
  await live.getByRole('button', { name: 'Stop' }).click();
  await expect(live).toContainText('Tala is not using the computer right now.');
});
