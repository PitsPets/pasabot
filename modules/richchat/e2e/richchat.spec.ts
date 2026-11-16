import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type W7Server = { url: string; sitesUrl: string; setupLink: string };
const root = fileURLToPath(new URL('..', import.meta.url));

const test = base.extend<{ server: W7Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
    });
    await use(JSON.parse(line) as W7Server);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
});

const PASSWORD = 'correct horse battery';
/** Setup link -> owner account -> a Fake (probe) agent -> its chat. */
async function ownerWithAgent(page: Page, server: W7Server) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await page.getByLabel('Name', { exact: true }).fill('Tala');
  await page.getByLabel('What should it help with?').fill('Answers questions.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });
/** No horizontal page scroll (390 px phone rule). */
async function noSideScroll(page: Page) {
  const w = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(w.scroll).toBeLessThanOrEqual(w.view);
}

test('the agent asks a 3-option question, the owner taps one, the answer returns to the run', async ({
  page,
  server,
}) => {
  await ownerWithAgent(page, server);
  await send(page, probe('richchat_ask', { question: 'Which plan?', options: ['Basic', 'Plus', 'Max'] }));
  const card = page.getByTestId('ask-card');
  await expect(card).toContainText('Which plan?');
  await noSideScroll(page);
  const plus = card.getByRole('button', { name: 'Plus' });
  const box = await plus.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await plus.click();
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'tool said' })).toContainText(
    '"choices":["Plus"]',
  );
  await expect(card).toContainText('Plus');
});

test('a form is filled in the browser and its values return to the run as untrusted data', async ({
  page,
  server,
}) => {
  await ownerWithAgent(page, server);
  await send(
    page,
    probe('richchat_form', {
      title: 'Trip',
      fields: [{ name: 'city', label: 'City', type: 'text', required: true }],
    }),
  );
  const form = page.getByTestId('form-card');
  await expect(form).toContainText('Trip');
  await noSideScroll(page);
  await form.getByLabel('City').fill('Cebu');
  await form.getByRole('button').last().click();
  const reply = page.getByTestId('msg-agent').filter({ hasText: 'tool said' });
  await expect(reply).toContainText('"values":{"city":"Cebu"}');
  await expect(reply).toContainText('"untrusted":true');
});

test('script in an HTML block cannot read cookies or use the credentialed /api and /ws', async ({
  page,
  server,
  context,
}) => {
  await ownerWithAgent(page, server);
  // the app itself is signed in: there is a session cookie the frame could try to use
  const host = new URL(server.url).hostname;
  expect((await context.cookies()).some((c) => c.domain === host && c.httpOnly)).toBe(true);
  const app = server.url;
  const wsUrl = app.replace(/^http/, 'ws');
  const html = `<!doctype html><pre id="out">running</pre><script>
const out = {};
const done = () => { document.getElementById('out').textContent = JSON.stringify(out); };
try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked:' + e.name; }
const api = (path, init) => fetch(${JSON.stringify(app)} + path, { credentials: 'include', ...init })
  .then((r) => r.status).catch((e) => 'blocked:' + e.name);
Promise.all([
  api('/api/v1/chats'),
  api('/api/v1/agents'),
  api('/api/v1/auth/me'),
  new Promise((res) => {
    let ws;
    try { ws = new WebSocket(${JSON.stringify(wsUrl)} + '/ws'); } catch (e) { return res('blocked:' + e.name); }
    const t = setTimeout(() => res('timeout'), 4000);
    ws.onopen = () => { clearTimeout(t); res('open'); };
    ws.onerror = () => { clearTimeout(t); res('error'); };
    ws.onclose = (ev) => { clearTimeout(t); res('closed:' + ev.code); };
  }),
]).then(([chats, agents, me, ws]) => { Object.assign(out, { chats, agents, me, ws }); done(); });
</script>`;
  await send(page, probe('richchat_html', { title: 'Probe', html }));
  const block = page.getByTestId('html-block');
  await expect(block).toBeVisible();
  await noSideScroll(page);
  const frame = page.frameLocator('[data-testid="html-block"] iframe');
  const out = frame.locator('#out');
  await expect(out).not.toHaveText('running', { timeout: 15_000 });
  const r = JSON.parse((await out.textContent()) ?? '{}') as Record<string, unknown>;
  test.info().annotations.push({ type: 'frame probe', description: JSON.stringify(r) });
  // the frame runs on an opaque origin: no cookie access at all
  expect(String(r.cookie)).toMatch(/^blocked:/);
  // credentialed calls never succeed: refused by the browser (CORS) or by the server (401/403)
  for (const k of ['chats', 'agents', 'me'])
    expect(String(r[k]), `${k}: ${JSON.stringify(r)}`).toMatch(/^(blocked:|401$|403$)/);
  expect(String(r.ws), JSON.stringify(r)).not.toBe('open');
  // and the frame's own origin is the sites origin, never the app's
  const src = await page.locator('[data-testid="html-block"] iframe').getAttribute('src');
  expect(new URL(src!).origin).toBe(new URL(server.sitesUrl).origin);
  expect(await page.locator('[data-testid="html-block"] iframe').getAttribute('sandbox')).toBe(
    'allow-scripts',
  );
});
