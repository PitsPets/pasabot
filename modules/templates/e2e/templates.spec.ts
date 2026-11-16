/**
 * W22 onboarding and templates in a real browser (1440 and 390): the first-run step 1 offers the free starter as one
 * tap (one plain sentence; what, where and from under Details), step 2 then the chat with a first agent that answers,
 * a failed stub install says so and creates nothing, a local model that answers on loopback is a step-1 choice, and a
 * template agent drafted from a plain request. Needs a built apps/web (dist).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type Server = { url: string; setupLink: string; catalog: string };
const modRoot = fileURLToPath(new URL('../', import.meta.url));
const boot = async (env: Record<string, string>) => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
    cwd: modRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once('line', resolve);
    child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
  });
  return { server: JSON.parse(line) as Server, child };
};
const test = base.extend<{ server: Server; failingServer: Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const { server, child } = await boot({});
    await use(server);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  failingServer: async ({}, use) => {
    const { server, child } = await boot({ TPL_E2E_INSTALL: 'fail' });
    await use(server);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
});

const PASSWORD = 'correct horse battery';
async function claim(page: Page, server: Server) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a brain' })).toBeVisible();
}
const agentCount = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/v1/agents', { credentials: 'same-origin' });
    return ((await r.json()) as { agents: unknown[] }).agents.length;
  });
async function noSideScroll(page: Page) {
  const w = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(w).toBeLessThanOrEqual(0);
}

test('onboarding: the free starter is one tap, then the first agent’s chat, where it answers', async ({
  page,
  server,
}) => {
  await claim(page, server);
  const brains = page.getByTestId('onb-brains');
  const starter = brains.getByTestId('onb-brain-starter');
  await expect(starter).toContainText('Free starter');
  await expect(starter).toContainText('No key, no sign-in, no payment');
  await noSideScroll(page);
  await starter.click();
  // one plain sentence; what, where and from wait under "Details"
  const note = page.getByTestId('onb-starter-note');
  await expect(note).toContainText('PasaBot will download a small free app so your agent can think.');
  await expect(page.getByTestId('onb-starter-details')).toBeHidden();
  await note.getByText('Details', { exact: true }).click();
  await expect(page.getByText('What: OpenCode CLI')).toBeVisible();
  await expect(page.getByText(/Where: .*opencode \(for your user only, no admin rights\)/)).toBeVisible();
  await expect(page.getByText('From: https://github.com/sst/opencode/releases')).toBeVisible();
  await expect(page.getByTestId('onb-starter-details')).toContainText('published SHA-256');
  await noSideScroll(page);
  await page.getByRole('button', { name: 'Download and continue' }).click();
  // no agent form in the first run: this server has no team builder module, so the agent's chat opens directly
  await expect(page).toHaveURL(/#\/chats\//);
  const box = page.getByRole('textbox').last();
  await box.fill('kumusta');
  await box.press('Enter');
  await expect(page.getByText('kumusta').nth(1)).toBeVisible({ timeout: 15_000 });
});

test('onboarding: a failed install says so, creates nothing and stays on step 1', async ({
  page,
  failingServer,
}) => {
  await claim(page, failingServer);
  await page.getByTestId('onb-brain-starter').click();
  await page.getByRole('button', { name: 'Download and continue' }).click();
  // one plain sentence; the raw reason only under "Details"
  const alert = page.getByTestId('onb-error');
  await expect(alert).toHaveText("The free starter didn't install. Try again, or pick another brain.");
  await expect(alert).not.toContainText('stub download failed');
  await page.getByTestId('onb-error-box').getByText('Details').click();
  await expect(page.getByTestId('onb-error-detail')).toContainText('stub download failed');
  await expect(page.getByRole('heading', { name: 'Pick a brain' })).toBeVisible();
  expect(await agentCount(page)).toBe(0);
  await skipOnboarding(page);
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
});

test('templates: "make me an agent that…" drafts for review, then creates it', async ({ page, server }) => {
  await claim(page, server);
  await page.goto(`${server.url}/#/templates`);
  await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
  await expect(page.locator('[data-template="writing-buddy"]')).toBeVisible();
  await noSideScroll(page);
  await page.getByLabel('What should the helper do?').fill('Make me an agent that drafts emails for my shop');
  await page.getByRole('button', { name: 'Make a draft' }).click();
  await expect(page.getByRole('heading', { name: 'Check the new helper' })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Writing buddy');
  await expect(page.getByLabel('Instructions')).toHaveValue(/Drafts emails for my shop/);
  await noSideScroll(page);
  await page.getByRole('button', { name: 'Make this helper' }).click();
  await expect(page).toHaveURL(/#\/chats\//);
});

/** 44 px tall at least on a phone (tap target) */
async function tall(page: Page, name: string | RegExp) {
  if ((page.viewportSize()?.width ?? 1440) >= 768) return;
  const box = await page.getByRole('button', { name }).first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
/** the free starter set up through the API, as the onboarding does it: install, an agent on a free model */
async function starterAgent(page: Page) {
  return page.evaluate(async () => {
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
    return a.agent.id as string;
  });
}

test('onboarding: a local model that answers on loopback is a step-1 choice; choosing it adds it', async ({
  page,
  server,
}) => {
  await claim(page, server);
  const local = page.getByTestId('onb-brains').locator('.brain-card', { hasText: 'Ollama' });
  await expect(local).toContainText('On this computer. Private, works offline');
  await local.click();
  await tall(page, 'Next');
  await noSideScroll(page);
  await page.getByRole('button', { name: 'Next' }).click();
  // no agent form in the first run: the agent's chat opens directly
  await expect(page).toHaveURL(/#\/chats\//);
  await page.goto(`${server.url}/#/agents/new`);
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
  // the Brain picker names the endpoint, never its raw id
  const brain = page.getByTestId('brain-picker');
  await expect(brain.getByRole('radio', { name: /Ollama/ })).toHaveCount(1);
  expect(await brain.locator('.brain-card').allTextContents()).not.toContainEqual(
    expect.stringMatching(/local:/),
  );
  await noSideScroll(page);
});

test('free starter: a model that is no longer free shows the notice with one way out', async ({
  page,
  server,
}) => {
  await claim(page, server);
  const agentId = await starterAgent(page);
  const file = join(server.catalog, 'free-models.json');
  const list = JSON.parse(readFileSync(file, 'utf8'));
  list.models[0].free = false;
  writeFileSync(file, JSON.stringify(list));
  await page.goto(`${server.url}/#/starter`);
  const notice = page.getByTestId('starter-notice');
  await expect(notice).toContainText('The free model is no longer free');
  await expect(notice).toContainText('Big Pickle is no longer free.');
  await expect(notice).not.toContainText('opencode/');
  await tall(page, 'Pick another brain');
  await noSideScroll(page);
  await notice.getByRole('button', { name: 'Pick another brain' }).click();
  await expect(page).toHaveURL(new RegExp(`#/agents/${agentId}/edit`));
});
