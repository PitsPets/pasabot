/**
 * W21: Settings → Automation at 1440 and 390 px, on the shared e2e server (apps/web/e2e/server.ts: every module,
 * FakeProvider). The owner turns automation on for a Fake agent, creates a token (shown once), a script (Node fetch,
 * no Origin) starts a run with it and gets the Fake reply, the token shows as used, a browser page cannot use it,
 * and after Revoke it gets 401. The panel has no horizontal scroll, no text under 12 px and 44 px tap targets.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type Server = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web', import.meta.url));
const PASSWORD = 'correct horse battery';

const test = base.extend<{ server: Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'],
      { cwd: webRoot, stdio: ['pipe', 'pipe', 'inherit'] },
    );
    try {
      const line = await new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once('line', resolve);
        child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
      });
      await use(JSON.parse(line) as Server);
    } finally {
      child.stdin?.end();
      child.kill('SIGTERM');
    }
  },
});

async function claimAndCreateAgent(page: Page, server: Server) {
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

async function panelChecks(page: Page, phone: boolean) {
  const o = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="automation-settings"]')!;
    const targets = [...root.querySelectorAll('button, select, input:not([type="checkbox"])')].concat(
      [...root.querySelectorAll('input[type="checkbox"]')].map((el) => el.closest('label') ?? el),
    );
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...root.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return el.childNodes.length > 0 && el.textContent?.trim() && Number.parseFloat(s.fontSize) < 12;
      }).length,
      small: targets.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height < 44)
        .length,
    };
  });
  expect(o.doc, 'horizontal overflow').toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
  if (phone) expect(o.small, 'tap targets under 44px').toBe(0);
}

const runs = (server: Server, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/api/m/automation/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('automation: owner turns it on, creates a token, a script runs the agent, the owner revokes it', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimAndCreateAgent(page, server);
  await page.goto(page.url().replace(/#.*$/, '#/settings/automations/automation'));
  // technical setup: with Technical words off (the default) the page says so; its switch opens it in place
  await page.getByTestId('settings-technical-only').getByTestId('settings-advanced').click();
  const panel = page.getByTestId('automation-settings');
  await expect(panel).toContainText('pasabot run');
  const card = panel.getByTestId('automation-agent-tala');
  const sw = card.getByLabel('Allow automation for Tala');
  await expect(sw).not.toBeChecked();
  await panelChecks(page, phone);
  await sw.check();
  await expect(card.getByText('On', { exact: true })).toBeVisible();

  await card.getByLabel('Token name').fill('laptop scripts');
  await card.getByLabel('Expires').selectOption('30');
  await panelChecks(page, phone);
  await card.getByRole('button', { name: 'Create token' }).click();
  const shown = card.getByTestId('automation-new-token');
  await expect(shown).toContainText('Copy this token now');
  await expect(shown).toContainText('pasabot run tala "sum 2+2" --wait');
  const token = (await card.getByTestId('automation-token-value').textContent())!.trim();
  expect(token.length).toBeGreaterThan(30);
  await panelChecks(page, phone);
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(card.getByTestId('automation-token-value')).toHaveCount(0);
  const tokenRow = card.getByTestId('automation-token-row').filter({ hasText: 'laptop scripts' });
  await expect(tokenRow).toContainText('Never used');
  await expect(tokenRow).toContainText('This computer only');

  // a local script (no Origin) starts a run and gets the Fake reply
  const started = await runs(server, token, { text: 'sum 2+2' });
  expect(started.status).toBe(202);
  const { run } = (await started.json()) as { run: { id: string } };
  const polled = await fetch(`${server.url}/api/m/automation/runs/${run.id}?wait=15000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(((await polled.json()) as { run: { state: string; reply: string } }).run).toMatchObject({
    state: 'done',
    reply: 'echo: sum 2+2',
  });
  // the same token from a browser page is refused: a page's POST always carries Origin (the run is not started)
  const fromPage = await page.evaluate(
    async ([url, t]) =>
      (
        await fetch(`${url}/api/m/automation/runs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'from a page' }),
        })
      ).status,
    [server.url, token] as const,
  );
  expect(fromPage).toBe(401);

  await page.reload();
  await expect(tokenRow).toContainText('Last used');
  await tokenRow.getByRole('button', { name: 'Revoke' }).click();
  await expect(tokenRow).toContainText('Revoked');
  await expect(tokenRow.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  expect((await runs(server, token, { text: 'again' })).status).toBe(401);
  await panelChecks(page, phone);

  // the switch off: the agent shows Off and offers no new token
  await sw.uncheck();
  await expect(card.getByText('Off', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Create token' })).toHaveCount(0);
});
