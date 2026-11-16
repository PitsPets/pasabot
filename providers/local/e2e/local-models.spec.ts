/**
 * W34 in a real browser (1440 and 390 px): Settings → Local models finds the (stub) Ollama on its loopback port, the
 * owner checks and adds it, the card lists its models (one with tools, one chat only); an agent on that brain answers
 * from the local model; the routine form offers "Run even offline". No horizontal scroll, no text under 12 px, tap
 * targets at least 44 px on these screens.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

type LocalServer = { url: string; setupLink: string; ollama: string };
const root = fileURLToPath(new URL('..', import.meta.url));

const test = base.extend<{ server: LocalServer }>({
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
    await use(JSON.parse(line) as LocalServer);
    const exited = new Promise((r) => child.once('exit', r));
    child.stdin?.end();
    child.kill('SIGTERM');
    await exited;
  },
});

async function fits(page: Page, scope: string) {
  const o = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const all = root ? [...root.querySelectorAll('*')] : [];
    return {
      over: document.documentElement.scrollWidth - window.innerWidth,
      tiny: root
        ? all.filter((el) => {
            const s = getComputedStyle(el);
            return (
              el.childNodes.length > 0 &&
              el.textContent?.trim() &&
              s.visibility !== 'hidden' &&
              el.getClientRects().length > 0 &&
              Number.parseFloat(s.fontSize) < 12
            );
          }).length
        : -1,
      small: all
        .filter((el) => el.matches('button, select, input:not([type=checkbox])'))
        .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().height < 44)
        .map((el) => el.outerHTML.slice(0, 80)),
    };
  }, scope);
  expect(o.over, 'horizontal scroll').toBeLessThanOrEqual(0);
  expect(o.tiny, 'text under 12px').toBe(0);
  // 44 px tap targets are the phone rule (the shared desktop controls are denser by design)
  if ((page.viewportSize()?.width ?? 0) <= 600) expect(o.small, 'tap targets under 44px').toEqual([]);
}

async function claim(page: Page, server: LocalServer) {
  const password = 'correct horse battery';
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password again').fill(password);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByTestId('onb-brain')).toBeVisible();
}

test('find, check and add a local model; an agent answers from it; routines offer run even offline', async ({
  page,
  server,
}) => {
  test.setTimeout(90_000);
  await claim(page, server);
  await page.goto(`${server.url}/#/settings/agents/local`);
  const local = page.locator('[data-local-settings]');
  await expect(local).toBeVisible();
  // found on its usual loopback port
  const found = local.getByTestId('local-found');
  await expect(found).toContainText(`Found Ollama at ${server.ollama} (2 models).`);
  await found.getByRole('button', { name: 'Add it' }).click();
  await expect(local.getByLabel('Address')).toHaveValue(server.ollama);
  await local.getByRole('button', { name: 'Check' }).click();
  await expect(local.getByTestId('local-check')).toContainText('Answering: 2 models.');
  await fits(page, '[data-local-settings]');
  await local.getByRole('button', { name: 'Add', exact: true }).click();
  const card = local.locator('[data-local-endpoint="Ollama"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-local-model="chatty:latest"]')).toContainText('Tools');
  await expect(card.locator('[data-local-model="plain:latest"]')).toContainText('Chat only: tools off');
  await expect(card).toContainText('This computer');
  await expect(local.getByTestId('local-found')).toHaveCount(0);
  await fits(page, '[data-local-settings]');

  // a new agent on that brain answers from the local model
  await page.goto(`${server.url}/#/agents/new`);
  await page.reload();
  await page.getByLabel('Name', { exact: true }).fill('Lokal');
  await page.getByLabel('What should it help with?').fill('Answers offline.');
  await page.getByTestId('brain-picker').locator('.brain-card', { hasText: 'Ollama' }).click();
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
  await page.getByTestId('composer').fill('hello from the browser');
  await page.getByTestId('composer').press('Enter');
  await expect(page.getByTestId('chat-log').getByText('local: hello from the browser')).toBeVisible();

  // the routine form offers "Run even offline"
  await page.goto(`${server.url}/#/routines`);
  const offline = page.getByTestId('routine-run-offline');
  await expect(offline).toBeVisible();
  await expect(page.getByText('Run even offline', { exact: true })).toBeVisible();
  await offline.check();
  await expect(offline).toBeChecked();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'horizontal scroll on routines').toBeLessThanOrEqual(0);

  // remove asks first, then the endpoint is gone
  await page.goto(`${server.url}/#/settings/agents/local`);
  await card.getByRole('button', { name: 'Remove' }).click();
  await card.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(local.locator('[data-local-endpoint="Ollama"]')).toHaveCount(0);
});

test('the Brain picker names a local endpoint that is down and reads it "not reachable"', async ({
  page,
  server,
}) => {
  await claim(page, server);
  // a loopback port nobody listens on (a stub opened on port 0, then closed)
  const dead = await new Promise<string>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  const status = await page.evaluate(async (url) => {
    const r = await fetch('/api/m/local/endpoints', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Box at home', api: 'ollama', url, tools: 'auto' }),
    });
    return r.status;
  }, dead);
  expect(status).toBe(200);
  await page.goto(`${server.url}/#/agents/new`);
  await page.reload();
  const options = page.getByTestId('brain-picker').locator('.brain-card');
  await expect(options.filter({ hasText: 'Box at home' })).toContainText('not reachable');
  const texts = await options.allTextContents();
  expect(texts.filter((x) => x.includes('Box at home') && x.includes('not installed'))).toEqual([]);
  expect(texts.some((x) => x.includes('local:'))).toBe(false);
  // the agent form (the shell's own skip link is out of scope here)
  await fits(page, 'form');
});

test('routines: a fire on the rate-limited free model reads Skipped (rate limited), never Running', async ({
  page,
  server,
}) => {
  await claim(page, server);
  // the free starter set up as onboarding does it (stub installer; the Fake "OpenCode" here always answers 429)
  await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    };
    const model = 'opencode/big-pickle';
    await post('/api/m/templates/starter/install', { consent: true });
    const a = await post('/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    await post('/api/m/templates/starter/agents', { agentId: a.agent.id, model });
    await post('/api/m/routines/routines', {
      agentId: a.agent.id,
      name: 'Morning check',
      prompt: 'Check things.',
      trigger: { kind: 'manual', spec: {} },
    });
  });
  await page.goto(`${server.url}/#/routines`);
  // the Routines page reads the feed when it opens and after an action (no live refresh): reload until it is in
  const why = page.getByTestId('routine-fire-why');
  const settled = async (n: number) =>
    expect(async () => {
      await page.reload();
      await expect(why).toHaveCount(n, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Run now' }).click();
  await settled(1);
  // the routines page speaks plain words with Technical words off (the default)
  await expect(why).toHaveText(
    'Skipped: the free brain is busy or used up for now. The next one runs as usual.',
  );
  // a second fire while the model is closed is skipped as well, never stacked as Running or Held
  await page.getByRole('button', { name: 'Run now' }).click();
  await settled(2);
  const activity = page.getByRole('heading', { name: 'Activity' }).locator('..');
  await expect(activity.getByText('Skipped', { exact: true })).toHaveCount(2);
  await expect(activity.getByText('Running', { exact: true })).toHaveCount(0);
  await expect(activity.getByText('Held', { exact: true })).toHaveCount(0);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'horizontal scroll on routines').toBeLessThanOrEqual(0);
  if ((page.viewportSize()?.width ?? 0) <= 600) {
    const box = await page.getByRole('button', { name: 'Run now' }).first().boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
