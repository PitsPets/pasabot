// W15 in a real browser on the shared e2e server (apps/web/e2e/server.ts: every module, Fake brain that calls
// gateway tools for `{"probe": {"name", "args"}}`). The owner lets the browser reach a local test page, makes a
// profile from the Browser screen, a Fake agent opens the page through MCP, live frames show up in the agent
// details dock, the full view and the pop-out (which stays open on the chat screen and follows the agent to the
// next page); once the owner marks the profile as holding sign-ins, the agent's next use asks at tier 3.
// The server is spawned by path (modules never import app code, dependency-cruiser rule); the local test page is
// served by this test on 127.0.0.1 port 0 and closed by it.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type E2EServer = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));

const test = base.extend<{ server: E2EServer; site: string }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
    });
    await use(JSON.parse(line) as E2EServer);
    const gone = new Promise((r) => child.once('exit', r));
    child.stdin?.end();
    child.kill('SIGTERM');
    await gone;
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  site: async ({}, use) => {
    const srv: Server = createServer((q, r) => {
      const two = q.url?.startsWith('/two');
      r.writeHead(200, { 'content-type': 'text/html' }).end(
        two
          ? '<!doctype html><title>Page two</title><body style="background:#14532d;color:#fff"><h1>Second page</h1></body>'
          : '<!doctype html><title>Tindahan ni Aling Nena</title><body style="background:#fde68a"><h1>Hello tindahan</h1></body>',
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    await use(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
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
  await page.getByLabel('What should it help with?').fill('Checks prices online.');
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
/** no text under 12px in the scope; on the phone every button is at least 44px tall */
const sizes = async (page: Page, testId: string, phone: boolean) => {
  const r = await page.getByTestId(testId).evaluate((el) => {
    let minFont = 99;
    for (const n of el.querySelectorAll('*')) {
      if (!n.textContent?.trim()) continue;
      minFont = Math.min(minFont, Number.parseFloat(getComputedStyle(n).fontSize));
    }
    const minTap = Math.min(
      99,
      ...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height),
    );
    return { minFont, minTap };
  });
  expect(r.minFont).toBeGreaterThanOrEqual(12);
  if (phone) expect(r.minTap).toBeGreaterThanOrEqual(44);
};
const frameSrc = (page: Page, scope: string) =>
  page.getByTestId(scope).getByTestId('browser-frame').getAttribute('src');

test('an agent browses a local page through MCP, the owner watches it live, signed-in use asks tier 3', async ({
  page,
  server,
  site,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chatUrl = page.url();

  // the Browser screen from the nav: allow the local test host, make a profile
  await page.goto(`${server.url}/#/browser`);
  await expect(page.getByRole('heading', { name: 'Browser', level: 1 })).toBeVisible();
  const net = page.getByTestId('browser-network');
  await net.getByLabel('Hosts the browser may open on your network').fill('127.0.0.1');
  await net.getByRole('button', { name: 'Save' }).click();
  await expect(net.getByRole('status')).toHaveText('Saved.');
  await page.getByRole('button', { name: 'New profile' }).click();
  const form = page.getByTestId('browser-profile-form');
  await form.getByLabel('Name').fill('Tindahan');
  await form.getByLabel('Colour').fill('#e11d48');
  await form.getByRole('button', { name: 'Save' }).click();
  const card = page.getByTestId('browser-profile').filter({ hasText: 'Tindahan' });
  await expect(card).toBeVisible();
  await noSideScroll(page);

  // the agent opens the local page through its MCP tool
  await page.goto(chatUrl);
  await send(page, probe('browser_navigate', { url: `${site}/`, profile: 'Tindahan' }));
  const reply = page.getByTestId('msg-agent').last();
  await expect(reply).toContainText('tool said:');
  await expect(reply).toContainText('Tindahan ni Aling Nena');
  await expect(reply).toContainText('Hello tindahan');

  if (!phone) {
    // live frames reach the dock in the agent details (closed by default; the module docks sit under its More),
    // which opens the full view
    await page.getByTestId('chat-who').click();
    await page.getByTestId('details-more-toggle').click();
    const dock = page.getByTestId('browser-dock');
    await expect(dock.getByTestId('browser-frame')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await noSideScroll(page);
    await dock.getByRole('button', { name: 'Full view' }).click();
  } else {
    // the phone has no details column: Settings › Skills & tools › Browser -> Watch
    await page.goto(`${server.url}/#/settings/tools`);
    await page.getByTestId('feature-browser').getByRole('link').click();
    await card.getByRole('button', { name: 'Watch' }).click();
  }
  await expect(page.getByTestId('browser-page')).toBeVisible();
  await expect(page.getByTestId('browser-url')).toHaveText(`${site}/`);
  await sizes(page, 'browser-page', phone);
  await expect(page.getByTestId('browser-page').getByTestId('browser-frame')).toHaveAttribute(
    'src',
    /^data:image\/jpeg;base64,/,
  );
  await noSideScroll(page);

  // pop out: the picture-in-picture stays open on the chat screen and follows the agent to the next page live
  await page.getByRole('button', { name: 'Pop out' }).click();
  const pip = page.getByTestId('browser-pip');
  await expect(pip.getByTestId('browser-frame')).toBeVisible();
  await page.goto(chatUrl);
  await expect(pip).toBeVisible();
  await expect(pip.getByTestId('browser-frame')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await sizes(page, 'browser-pip', phone);
  const before = await frameSrc(page, 'browser-pip');
  await noSideScroll(page);
  await send(page, probe('browser_navigate', { url: `${site}/two`, profile: 'Tindahan' }));
  await expect(page.getByTestId('msg-agent').last()).toContainText('Second page');
  await expect.poll(() => frameSrc(page, 'browser-pip')).not.toBe(before);
  await pip.getByRole('button', { name: 'Close' }).click();
  await expect(pip).toHaveCount(0);

  // the owner marks the profile as holding sign-ins: the agent must now ask at tier 3
  await page.goto(`${server.url}/#/browser`);
  await card.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('This browser has my sign-ins (helpers must ask first)').check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(card).toContainText('Has your sign-ins');
  await page.goto(chatUrl);
  await send(page, probe('browser_snapshot', { profile: 'Tindahan' }));
  const approval = page.getByTestId('approval-card').last();
  await expect(approval).toContainText('Tala wants to: Browser: read the page');
  await expect(approval).toContainText('Risky');
  await approval.getByRole('button', { name: 'Approve' }).click();
  const sheet = page.getByRole('dialog', { name: "Confirm it's you" });
  await sheet.getByLabel('Password').fill(PASSWORD);
  await sheet.getByRole('button', { name: 'Confirm and approve' }).click();
  await expect(approval.getByTestId('approval-state')).toHaveText('Approved');
  await expect(page.getByTestId('msg-agent').last()).toContainText('Second page');
  await noSideScroll(page);
});
