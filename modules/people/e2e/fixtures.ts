/**
 * Runs the shared e2e server (`apps/web/e2e/server.ts`: every module discovered, Fake brain, port 0, temp home) as
 * a child process; modules may not import app code, so the small helpers the spec needs live here. The server is
 * stopped when its test ends.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

export interface E2EServer {
  url: string;
  setupLink: string;
}
const webRoot = fileURLToPath(new URL('../../../apps/web', import.meta.url));

export const test = base.extend<{ server: E2EServer }>({
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
    const j = JSON.parse(line) as E2EServer;
    await use({ url: j.url, setupLink: j.setupLink });
    child.stdin?.end();
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
  },
});
export { expect };

const PASSWORD = 'correct horse battery';

/** Setup link -> owner account -> new agent form. */
export async function claimServer(page: Page, server: E2EServer) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
}

/** On the new-agent form: create a Fake agent and land in its chat. */
export async function createFakeAgent(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Keeps the books.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}

export async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}
