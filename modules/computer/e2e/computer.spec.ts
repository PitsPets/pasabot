// W16 in a real browser on the shared e2e server (apps/web/e2e/server.ts: every module, Fake brain that calls
// gateway tools for `{"probe": {"name", "args"}}`), with the practice display (`PASABOT_COMPUTER_DRIVER=practice`)
// standing in for Xvfb behind the same driver interface. The Fake agent takes a screenshot and clicks the test
// app's button; each action is a tier-3 approval the owner confirms with re-auth. The owner then watches the
// display in the viewer (the button is green in the live frame), sees the action log, takes control (click +
// type, logged as "You" with the text's length only) and stops the display. The server is spawned by path (modules never import app code).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type E2EServer = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));

const test = base.extend<{ server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PASABOT_COMPUTER_DRIVER: 'practice' },
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
    });
    await use(JSON.parse(line) as E2EServer);
    child.stdin?.end();
    child.kill('SIGTERM');
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
  await page.getByLabel('What should it help with?').fill('Uses the desktop for me.');
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

/** the newest approval card is tier 3 (even for a trusted agent on the owner's own turn); approve with re-auth */
async function approveTier3(page: Page) {
  const card = page.getByTestId('approval-card').last();
  await expect(card).toContainText('Risky', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
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

/** RGB of one pixel of the viewer's current frame (same-origin image, so the canvas is readable) */
const pixel = (page: Page, x: number, y: number) =>
  page.locator('[data-computer-frame]').evaluate(
    (img: HTMLImageElement, [px, py]) => {
      if (!img.complete || img.naturalWidth === 0) return null;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(px!, py!, 1, 1).data.slice(0, 3));
    },
    [x, y],
  );

test('a Fake agent clicks a test app button after tier-3 approvals and the owner watches in the viewer', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const replies = page.getByTestId('msg-agent').filter({ hasText: 'tool said' });

  await send(page, probe('computer_screenshot', {}));
  await approveTier3(page);
  await expect(replies.first()).toContainText('"width":640', { timeout: 15_000 });

  await send(page, probe('computer_click', { x: 320, y: 180 }));
  await approveTier3(page);
  await expect(replies.nth(1)).toContainText('"ok":true', { timeout: 15_000 });

  // the owner reaches the viewer through Settings › Skills & tools
  await page.goto(`${server.url}/#/settings/tools`);
  await page.getByTestId('feature-computer').getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Computer use' })).toBeVisible();
  const card = page.locator('[data-computer-display]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Tala');
  await expect(card.getByRole('img', { name: "Tala's display" })).toBeVisible();
  // the live frame shows the button the agent pressed (green, not the idle blue) and the pointer on it (red)
  await expect.poll(() => pixel(page, 250, 160), { timeout: 10_000 }).toEqual([46, 158, 91]);
  expect(await pixel(page, 320, 180)).toEqual([220, 40, 40]);

  const log = page.locator('[data-computer-action]');
  await expect(log.filter({ hasText: 'click 320, 180' })).toContainText('Tala');
  await expect(log.filter({ hasText: 'screenshot 640x400' })).toHaveCount(1);
  await noSideScroll(page);

  // take control: a click on the picture lands on the display, typed text too; both logged as the owner
  const control = card.getByRole('button', { name: 'Take control' });
  if (phone) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await control.click();
  await expect(card.getByRole('button', { name: 'Stop controlling' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const img = card.locator('[data-computer-frame]');
  const box = (await img.boundingBox())!;
  await img.click({ position: { x: box.width * (20 / 640), y: box.height * (380 / 400) } });
  await expect(log.filter({ hasText: 'You' }).first()).toContainText(/click \d+, \d+/);
  // the pointer moved to the bottom-left corner of the frame (drawn red)
  await expect.poll(() => pixel(page, 20, 380), { timeout: 10_000 }).toEqual([220, 40, 40]);
  await card.getByLabel('Type on the display').fill('halo po');
  const sendText = card.getByRole('button', { name: 'Send text' });
  if (phone) expect((await sendText.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sendText.click();
  // typed text is masked in the box and never logged: only its length
  await expect(card.getByLabel('Type on the display')).toHaveAttribute('type', 'password');
  await expect(log.filter({ hasText: 'type (7 characters)' })).toContainText('You');
  await expect(page.getByText('halo po')).toHaveCount(0);
  await noSideScroll(page);

  // smallest text on the screen is at least 12 px
  const smallest = await page
    .locator('[data-testid="computer-page"]')
    .evaluate((root) =>
      Math.min(
        ...[...root.querySelectorAll('*')]
          .filter((e) => (e as HTMLElement).textContent?.trim())
          .map((e) => Number.parseFloat(getComputedStyle(e).fontSize)),
      ),
    );
  expect(smallest).toBeGreaterThanOrEqual(12);

  await card.getByRole('button', { name: 'Stop display' }).click();
  await expect(page.locator('[data-computer-empty]')).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('Filipino: the Computer screen reads in Taglish', async ({ page, server }) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Ligaya');
  await page.goto(`${server.url}/#/computer`);
  await expect(page.getByRole('heading', { name: 'Computer use' })).toBeVisible();
  await page.evaluate(() => document.documentElement.setAttribute('lang', 'fil'));
  await expect(page.getByRole('heading', { name: 'Paggamit ng computer' })).toBeVisible();
  // Technical words off (the default): the plain words, "katulong" and "screen"
  await expect(page.locator('[data-computer-empty]')).toContainText('Walang katulong na gumagamit ng screen');
  await noSideScroll(page);
});
