/**
 * Runs the shared e2e server (`apps/web/e2e/server.ts`: every module discovered, Fake brain, port 0, temp home) as
 * a child process, next to the in-repo fake IMAP/SMTP server (src/testing, 127.0.0.1 port 0). The server process
 * trusts the fake's throwaway certificate through NODE_EXTRA_CA_CERTS and may reach 127.0.0.1 for mail through
 * PASABOT_INBOX_PRIVATE_HOSTS (operator config); the named services of the guided email setup are pointed at the
 * same fake through PASABOT_INBOX_TEST_MAIL_SERVER (loopback only). Both stop when the test ends. No network.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';
import { type FakeMail, startFakeMail } from '../src/testing/fake-mail.js';

export interface E2EServer {
  url: string;
  setupLink: string;
}
export const MAIL_USER = 'bot@mail.test';
export const MAIL_PASS = 'e2e-app-pass-not-real';
const webRoot = fileURLToPath(new URL('../../../apps/web', import.meta.url));

/** W43: the fake sign-up page (names, an address, then the owner's password, phone and code, and Next) */
export const SIGNUP_PAGE = `<!doctype html><html lang="en"><title>Create your account</title>
<style>body{font:16px system-ui;margin:24px;max-width:420px}label,input,button{display:block;margin:6px 0}input{width:100%;padding:8px}</style>
<h1>Create your account</h1><form>
<label for="fn">First name</label><input id="fn" name="firstName" autocomplete="given-name">
<label for="ln">Last name</label><input id="ln" name="lastName" autocomplete="family-name">
<label for="un">Username</label><input id="un" name="Username">
<label for="pw">Create a password</label><input id="pw" type="password" name="Passwd" autocomplete="new-password">
<label for="ph">Phone number</label><input id="ph" type="tel" name="phoneNumber">
<button type="button" onclick="fetch('/created')">Next</button></form></html>`;
export let signupSubmits = 0;

export const test = base.extend<{ mail: FakeMail; server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  mail: async ({}, use) => {
    const m = await startFakeMail({ user: MAIL_USER, pass: MAIL_PASS, tls: 'implicit' });
    await use(m);
    await m.close();
  },
  server: async ({ mail }, use) => {
    // W43: a fake sign-up page on 127.0.0.1 stands in for the service's own (test-only, loopback, no network);
    // `created` counts a submit that must never come from PasaBot
    const signup = createServer((q, r) => {
      if (q.url === '/created') {
        signupSubmits++;
        return void r.end('ok');
      }
      r.writeHead(200, { 'content-type': 'text/html' }).end(SIGNUP_PAGE);
    });
    await new Promise<void>((r) => signup.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'inbox-e2e-'));
    const ca = join(dir, 'ca.pem');
    writeFileSync(ca, mail.cert.cert);
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: ca,
        PASABOT_INBOX_PRIVATE_HOSTS: '127.0.0.1',
        // the named services (Gmail, Outlook, ...) go to the fake mail server too (test-only operator config)
        PASABOT_INBOX_TEST_MAIL_SERVER: `127.0.0.1:${mail.imapPort}:${mail.smtpPort}`,
        PASABOT_INBOX_TEST_SIGNUP_URL: `http://127.0.0.1:${(signup.address() as { port: number }).port}/signup`,
      },
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
    signup.closeAllConnections();
    await new Promise((r) => signup.close(r));
    rmSync(dir, { recursive: true, force: true });
  },
});
export { expect };

export const PASSWORD = 'correct horse battery';

/** Setup link -> owner account -> new agent form. */
export async function claimServer(page: Page, server: E2EServer) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('PitsPets');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
}

/** On the new-agent form: create a Fake agent and land in its chat. */
export async function createFakeAgent(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Answers the bot inbox.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}

export async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}

/** No sideways scroll, and no visible text under 12 px inside `scope`. */
export async function fits(page: Page, scope: string) {
  const o = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    return {
      over: document.documentElement.scrollWidth - window.innerWidth,
      tiny: root
        ? [...root.querySelectorAll('*')].filter((el) => {
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
    };
  }, scope);
  expect(o.over, 'horizontal scroll').toBeLessThanOrEqual(0);
  expect(o.tiny, 'text under 12px').toBe(0);
}
