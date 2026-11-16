// W18 in a real browser on the shared e2e server (apps/web/e2e/server.ts: every module, Fake brain that calls
// gateway tools for `{"probe": {"name", "args"}}`). A standard-trust agent publishes a 3-file site (tier 2: the
// owner approves the card), the owner opens Sites from the nav, opens the site on the sites origin (every response
// carries `CSP: sandbox allow-scripts`; the site's script reads no cookie and gets nothing from the credentialed
// /api and /ws), renews it, sets a tunnel address, makes it public and removes it.
// The server is spawned by path (modules never import app code, dependency-cruiser rule).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Response } from '@playwright/test';
import { openMoreOptions, pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type E2EServer = { url: string; sitesUrl: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));

const test = base.extend<{ server: E2EServer }>({
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
    const exited = new Promise((r) => child.once('exit', r));
    child.stdin?.end();
    child.kill('SIGTERM');
    await exited;
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
async function createStandardAgent(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Makes small web pages.');
  await pickBrain(page, 'fake');
  await openMoreOptions(page);
  await page.getByLabel('How often it asks you').selectOption('standard');
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

/** The site's own script: tries the cookie, credentialed /api calls and the /ws socket, and prints what happened. */
const probeScript = (app: string) => `
const out = {};
const done = () => { document.getElementById('out').textContent = JSON.stringify(out); };
try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked:' + e.name; }
const api = (path, init) => fetch(${JSON.stringify(app)} + path, { credentials: 'include', ...init })
  .then((r) => r.status).catch((e) => 'blocked:' + e.name);
Promise.all([
  api('/api/v1/chats'),
  api('/api/m/sites/sites'),
  api('/api/m/sites/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"publicBaseUrl":"https://evil.example"}' }),
  new Promise((res) => {
    let ws;
    try { ws = new WebSocket(${JSON.stringify(app.replace(/^http/, 'ws'))} + '/ws'); } catch (e) { return res('blocked:' + e.name); }
    const t = setTimeout(() => res('timeout'), 4000);
    ws.onopen = () => { clearTimeout(t); res('open'); };
    ws.onerror = () => { clearTimeout(t); res('error'); };
    ws.onclose = (ev) => { clearTimeout(t); res('closed:' + ev.code); };
  }),
]).then(([chats, sites, settings, ws]) => { Object.assign(out, { chats, sites, settings, ws }); done(); });
`;

test('an agent publishes a 3-file site; the owner opens, renews, makes public and removes it', async ({
  page,
  server,
  context,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createStandardAgent(page, 'Tala');
  const host = new URL(server.url).hostname;
  expect((await context.cookies()).some((c) => c.domain === host && c.httpOnly)).toBe(true);

  const files = [
    {
      path: 'index.html',
      content:
        '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="style.css"><h1>Tanghalian</h1><pre id="out">running</pre><script src="app.js"></script>',
    },
    { path: 'style.css', content: 'h1 { color: rgb(0, 128, 128); }' },
    { path: 'app.js', content: probeScript(server.url) },
  ];
  await send(page, probe('sites_publish', { title: 'Lunch menu', files, days: 1 }));
  // publishing is tier 2: a standard agent asks the owner first
  const card = page.getByTestId('approval-card');
  await expect(card).toContainText('Needs your OK', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
  const reply = page.getByTestId('msg-agent').filter({ hasText: 'tool said' }).first();
  await expect(reply).toContainText('"url":', { timeout: 15_000 });
  const url = /"url":"([^"]+)"/.exec((await reply.textContent()) ?? '')![1]!;
  expect(new URL(url).origin).toBe(new URL(server.sitesUrl).origin);
  expect(new URL(url).origin).not.toBe(new URL(server.url).origin);

  // the 21st file is refused
  const many = Array.from({ length: 21 }, (_, i) => ({ path: i ? `p${i}.txt` : 'index.html', content: 'x' }));
  await send(page, probe('sites_publish', { title: 'Too many', files: many }));
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'at most 20 files' })).toBeVisible({
    timeout: 15_000,
  });

  // the owner reaches Sites through Settings › Skills & tools
  await page.goto(`${server.url}/#/settings/tools`);
  await page.getByTestId('feature-sites').getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Sites', level: 1 })).toBeVisible();
  const site = page.locator('[data-site]').filter({ hasText: 'Lunch menu' });
  await expect(site.locator('[data-site-agent]')).toHaveText('Published by Tala');
  await expect(site).toContainText('3 files');
  await expect(site.locator('[data-site-visibility]')).toHaveText('Private');
  await noSideScroll(page);
  if (phone)
    for (const b of await site.locator('button, a.bk-btn').all())
      expect((await b.boundingBox())!.height, await b.textContent()).toBeGreaterThanOrEqual(44);

  // open it: a new tab on the sites origin; every response there is sandboxed
  const siteResponses: Response[] = [];
  context.on('response', (r) => {
    if (r.url().startsWith(server.sitesUrl)) siteResponses.push(r);
  });
  const [tab] = await Promise.all([context.waitForEvent('page'), site.locator('[data-site-open]').click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe(url);
  await expect(tab.getByRole('heading', { name: 'Tanghalian' })).toHaveCSS('color', 'rgb(0, 128, 128)');
  const out = tab.locator('#out');
  await expect(out).not.toHaveText('running', { timeout: 15_000 });
  const r = JSON.parse((await out.textContent()) ?? '{}') as Record<string, unknown>;
  test.info().annotations.push({ type: 'site probe', description: JSON.stringify(r) });
  expect(String(r.cookie)).toMatch(/^blocked:/);
  for (const k of ['chats', 'sites', 'settings'])
    expect(String(r[k]), `${k}: ${JSON.stringify(r)}`).toMatch(/^(blocked:|401$|403$)/);
  expect(String(r.ws), JSON.stringify(r)).not.toBe('open');
  const paths = siteResponses.map((x) => new URL(x.url()).pathname.split('/').pop());
  expect(paths).toEqual(expect.arrayContaining(['index.html', 'style.css', 'app.js']));
  for (const x of siteResponses) {
    const h = await x.allHeaders();
    expect(h['content-security-policy'], x.url()).toBe('sandbox allow-scripts');
    expect(h['x-content-type-options'], x.url()).toBe('nosniff');
  }
  await tab.close();

  // renew: one day becomes seven
  const expires = site.locator('[data-site-expires]');
  const before = await expires.textContent();
  await site.getByRole('button', { name: 'Keep 7 more days' }).click();
  await expect(expires).not.toHaveText(before ?? '');

  // public needs a tunnel address; then the public address shows
  await expect(site.getByRole('button', { name: 'Make public' })).toBeDisabled();
  await page.getByLabel('Tunnel address for sites').fill('https://sites.example.test/');
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page.locator('[data-sites-page]').getByRole('status')).toHaveText('Saved.');
  await site.getByRole('button', { name: 'Make public' }).click();
  await expect(site.locator('[data-site-visibility]')).toHaveText('Public');
  const slug = new URL(url).pathname.split('/')[2]!;
  await expect(site.locator('[data-site-public-url]')).toHaveAttribute(
    'href',
    `https://sites.example.test/sites/${slug}/index.html`,
  );
  await noSideScroll(page);

  // Taglish follows the EN/FIL choice
  await page.evaluate(() => localStorage.setItem('pasabot.lang', 'fil'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mga site', level: 1 })).toBeVisible();
  await expect(site.locator('[data-site-agent]')).toHaveText('Inilathala ni Tala');
  await noSideScroll(page);
  await page.evaluate(() => localStorage.setItem('pasabot.lang', 'en'));
  await page.reload();

  // remove: the address stops working at once
  page.once('dialog', (d) => void d.accept());
  await site.getByRole('button', { name: 'Remove' }).click();
  await expect(site).toHaveCount(0);
  await expect(page.getByText('No sites yet.')).toBeVisible();
  expect((await page.request.get(url)).status()).toBe(404);
});
