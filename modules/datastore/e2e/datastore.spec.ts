// W11 in a real browser on the shared e2e server (apps/web/e2e/server.ts: every module, Fake brain that calls
// gateway tools for `{"probe": {"name", "args"}}`). An agent makes a table and writes rows through its tools; the
// owner reaches the Data screen from the nav, sees the table (creator, row count, CREATE statement), opens its
// rows and runs a read-only query; a write typed into the query box is refused.
// The server is spawned by path (modules never import app code, dependency-cruiser rule).
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
/** Setup link -> owner account -> a Fake agent -> its chat. */
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
  await page.getByLabel('What should it help with?').fill('Keeps the order list.');
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

test('an agent keeps a shared table and the owner browses and queries it on the Data screen', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');

  await send(
    page,
    probe('datastore_create_table', {
      sql: 'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, qty INTEGER)',
    }),
  );
  const replies = page.getByTestId('msg-agent').filter({ hasText: 'tool said' });
  await expect(replies.first()).toContainText('"created":true', { timeout: 15_000 });
  await send(
    page,
    probe('datastore_write', {
      sql: 'INSERT INTO orders (item, qty) VALUES (?, ?)',
      rows: [
        ['lapis', 12],
        ['papel', 3],
        ['pambura', 7],
      ],
    }),
  );
  await expect(replies.nth(1)).toContainText('"changes":3', { timeout: 15_000 });
  // the gate answers the agent plainly: no PRAGMA, no second statement
  await send(page, probe('datastore_query', { sql: 'PRAGMA table_list' }));
  await expect(replies.nth(2)).toContainText('PRAGMA is not allowed', { timeout: 15_000 });

  // the owner reaches it through Settings › Memory & data
  await page.goto(`${server.url}/#/settings/memory`);
  await page.getByTestId('feature-datastore').getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Shared data' })).toBeVisible();

  const card = page.locator('[data-datastore-table="orders"]');
  await expect(card).toContainText('3 rows');
  await expect(card.locator('[data-datastore-creator]')).toHaveText('Made by Tala');
  await card.getByText('How it is defined').click();
  await expect(card.locator('[data-datastore-ddl]')).toContainText('CREATE TABLE orders');
  await card.getByRole('button', { name: 'Show rows' }).click();
  const grid = card.locator('[data-datastore-grid]');
  await expect(grid).toContainText('lapis');
  await expect(grid).toContainText('pambura');
  await noSideScroll(page);

  // R7 review: a short intro with the rules folded under "Learn more", and no query box with Technical words off
  const more = page.locator('[data-datastore-more]');
  await expect(more.getByText('Learn more')).toBeVisible();
  await expect(more.getByText(/Only the maker can reshape/)).toBeHidden();
  await more.getByText('Learn more').click();
  await expect(more.getByText(/Only the maker can reshape/)).toBeVisible();
  await expect(page.getByLabel('Query (read only)')).toHaveCount(0);
  await expect(page.getByText('Look something up')).toHaveCount(0);
  // with Technical words on, the read-only query is there
  await page.evaluate(() =>
    fetch('/api/v1/me/prefs/ui.advanced', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true }),
    }),
  );
  await page.reload();
  await expect(card).toContainText('3 rows');
  const box = page.getByLabel('Query (read only)');
  await box.fill('SELECT item, qty FROM orders WHERE qty > 5 ORDER BY qty DESC');
  const run = page.getByRole('button', { name: 'Run query' });
  if (phone) expect((await run.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await run.click();
  const result = page.getByRole('region', { name: 'Query result' }).locator('[data-datastore-grid]');
  await expect(result).toContainText('lapis');
  await expect(result).toContainText('pambura');
  await expect(result).not.toContainText('papel');
  await expect(result.locator('tbody tr')).toHaveCount(2);

  // the screen never writes, and the gate refuses a second statement
  await box.fill('DELETE FROM orders');
  await run.click();
  await expect(page.getByRole('alert')).toContainText('read-only queries only');
  await box.fill('SELECT 1; DROP TABLE orders');
  await run.click();
  await expect(page.getByRole('alert')).toContainText('only one SQL statement');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(card).toContainText('3 rows');
  await noSideScroll(page);

  // Taglish follows the EN/FIL choice
  await page.evaluate(() => localStorage.setItem('pasabot.lang', 'fil'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pinagsasaluhang data' })).toBeVisible();
  await expect(card.locator('[data-datastore-creator]')).toHaveText('Gawa ni Tala');
  await noSideScroll(page);
});
