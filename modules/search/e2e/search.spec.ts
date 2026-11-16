import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type SearchServer = { url: string; setupLink: string };
const root = fileURLToPath(new URL('..', import.meta.url));

const test = base.extend<{ server: SearchServer }>({
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
    await use(JSON.parse(line) as SearchServer);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
});

test('search finds a message and opens its chat', async ({ page, server }) => {
  const password = 'correct horse battery';
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password again').fill(password);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await page.getByLabel('Name', { exact: true }).fill('Tala');
  await page.getByLabel('What should it help with?').fill('Answers questions.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await page.getByTestId('composer').fill('kalamansi juice for everyone');
  await page.getByTestId('composer').press('Enter');
  await expect(page.getByTestId('msg-agent').last()).toContainText('echo: kalamansi');

  await page.goto(`${server.url}/#/search`);
  const box = page.getByTestId('search-page').getByRole('searchbox');
  await box.fill('kalaman');
  await box.press('Enter');
  const hit = page.getByTestId('search-hit').first();
  await expect(hit).toContainText('kalamansi');
  // no horizontal page scroll (390 px phone rule)
  const w = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(w[0]).toBeLessThanOrEqual(w[1]!);
  await hit.click();
  await expect(page.getByTestId('composer')).toBeVisible();
});
