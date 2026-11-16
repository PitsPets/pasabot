import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import {
  claimWithLink,
  expectQuiet as expectQuietPage,
  pickBrain,
  skipOnboarding,
} from '../../../packages/testkit/src/e2e.js';

type One = { url: string; setupLink: string };
type Pair = { alpha: One; beta: One };
const root = fileURLToPath(new URL('..', import.meta.url));

const test = base.extend<{ servers: Pair }>({
  // two servers from source (tsx) take long to boot when the whole e2e run loads the machine: the boot has a timeout
  // of its own (Playwright fixture timeout), so it never eats the test's own time
  servers: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
    async ({}, use) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const line = await new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once('line', resolve);
        child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
      });
      await use(JSON.parse(line) as Pair);
      child.stdin?.end();
      child.kill('SIGTERM');
    },
    { timeout: 180_000 },
  ],
});

const PASSWORD = 'correct horse battery';
async function claim(page: Page, s: One, name: string) {
  await claimWithLink(page, s.setupLink, name, PASSWORD);
}
const noSideScroll = async (page: Page) => {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(sw).toBeLessThanOrEqual(cw!);
};
// at most one refresh tick per page part (status, peers, intros, the switcher's peers); the loop made thousands
const expectQuiet = (page: Page) =>
  expectQuietPage(page, { match: '/api/m/link/', ms: 1_500, label: 'link page' });

test('link two machines from Settings, then chat with an agent on the other machine', async ({
  browser,
  servers,
}) => {
  // two owners, two browsers (cookies are per host, not per port)
  const alpha = await (await browser.newContext()).newPage();
  const beta = await (await browser.newContext()).newPage();

  await claim(alpha, servers.alpha, 'Ana');
  await skipOnboarding(alpha);
  await alpha.getByLabel('Name', { exact: true }).fill('Tala');
  await alpha.getByLabel('What should it help with?').fill('Answers questions.');
  await pickBrain(alpha, 'fake');
  await alpha.getByTestId('agent-submit').click();
  await expect(alpha.getByTestId('composer')).toBeVisible();

  await alpha.goto(`${servers.alpha.url}/#/settings/machines/machines`);
  const aSettings = alpha.getByTestId('link-settings');
  await expect(aSettings.getByText('This machine: alpha')).toBeVisible();
  // a loaded page stays quiet: its loaders run once, not in a loop that pins the browser and the server
  await expectQuiet(alpha);
  await aSettings.getByRole('button', { name: 'Show a link code' }).click();
  await expect(aSettings.getByRole('img', { name: 'Link code as a QR picture' })).toBeVisible();
  const code = (await aSettings.getByTestId('link-code-text').textContent())!.trim();
  expect(code.startsWith('bkl1.')).toBe(true);
  await noSideScroll(alpha);

  // beta's owner enters the code, picks what alpha may do on beta, and confirms with the password
  await claim(beta, servers.beta, 'Ben');
  await expect(beta.getByTestId('onb-brain')).toBeVisible();
  await beta.goto(`${servers.beta.url}/#/settings/machines/machines`);
  const bSettings = beta.getByTestId('link-settings');
  await bSettings.getByLabel('Link code').fill(code);
  await bSettings.getByLabel('Your password (to confirm it is you)').fill(PASSWORD);
  await bSettings.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(bSettings.getByText('Sent. The other owner confirms on their machine.')).toBeVisible();
  await expect(bSettings.getByTestId('link-peer')).toContainText('Waiting for the other owner');

  // alpha's owner sees the request, grants Chat and confirms with the password
  await alpha.reload();
  const req = alpha.getByTestId('link-peer');
  await expect(req).toContainText('beta');
  await expect(req).toContainText('Wants to link');
  await req.getByRole('button', { name: 'Chat', exact: true }).click();
  await req.getByLabel('Your password (to confirm it is you)').fill(PASSWORD);
  await req.getByRole('button', { name: 'Confirm link' }).click();
  await expect(req).toContainText('Linked');
  await noSideScroll(alpha);

  // beta: the machine switcher lists alpha, its agents, and a proxied chat whose answer comes from alpha
  await beta.goto(`${servers.beta.url}/#/machines`);
  const pageB = beta.getByTestId('link-page');
  const machine = pageB.getByTestId('link-machine').filter({ hasText: 'alpha' });
  await expect(machine).toBeVisible();
  await expectQuiet(beta);
  await machine.getByRole('button', { name: 'Open' }).click();
  await pageB.getByRole('button', { name: 'Tala' }).click();
  const chat = pageB.getByTestId('link-chat');
  await chat.getByLabel('Message Tala').fill('kumusta from beta');
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(chat.getByTestId('link-msg-me')).toContainText('kumusta from beta');
  await expect(chat.getByTestId('link-msg-agent')).toContainText('kumusta from beta');
  await noSideScroll(beta);

  // unlink from beta's settings: the machine disappears from the switcher
  await beta.goto(`${servers.beta.url}/#/settings/machines/machines`);
  beta.once('dialog', (d) => void d.accept());
  await beta.getByTestId('link-peer').getByRole('button', { name: 'Unlink' }).click();
  await expect(beta.getByTestId('link-peer')).toHaveCount(0);
  // the machines page and its settings are one Settings feature: load it fresh to read the list again
  await beta.goto(`${servers.beta.url}/#/machines`);
  await beta.reload();
  await expect(beta.getByText('No linked machines yet.', { exact: false })).toBeVisible();
});
