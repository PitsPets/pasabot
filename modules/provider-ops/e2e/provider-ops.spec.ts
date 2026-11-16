/**
 * W3 in a real browser (1440 and 390 px): the owner sets a fallback brain in Settings → Brains and fallbacks; a
 * context report of 90 % shows on the chat header gauge and posts the reseed notice; a rate limit on the primary
 * posts the switch notice and the reply comes from the fallback; the Usage page lists the agent's tokens and the
 * paused brain. No horizontal scroll and no text under 12 px on these screens.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type OpsServer = { url: string; setupLink: string };
const root = fileURLToPath(new URL('..', import.meta.url));

const test = base.extend<{ server: OpsServer }>({
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
    await use(JSON.parse(line) as OpsServer);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
});

async function fits(page: Page, scope: string) {
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

const script = (steps: unknown[]) => JSON.stringify({ fakeScript: steps });

/** Setup link → owner account → first agent (Fake brain) → its chat (the shell's own flow). */
async function claimAndCreateAgent(page: Page, server: OpsServer, name: string) {
  const password = 'correct horse battery';
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password again').fill(password);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Handles purchasing.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}

test('fallback, context gauge, compaction notice and usage page', async ({ page, server }, info) => {
  test.setTimeout(90_000);
  await claimAndCreateAgent(page, server, 'Tala');
  const chatUrl = page.url();

  // Settings › Agents & brains › Brains and fallbacks: Backup as fallback 1
  await page.goto(`${server.url}/#/settings/agents/provider-ops-settings`);
  // technical setup: with Technical words off (the default) the page says so; its switch opens it in place
  await page.getByTestId('settings-technical-only').getByTestId('settings-advanced').click();
  const settings = page.locator('[data-provider-settings]');
  await expect(settings).toBeVisible();
  // the brain reads by its display name (the shared providerDisplayName), never the raw provider id "fake"
  const card = settings.locator('[data-agent-settings]').first();
  await expect(card).toContainText('Uses Fake (tests)');
  await expect(card.getByLabel('Account for Fake (tests)')).toBeVisible();
  await expect(card).not.toContainText('Uses fake');
  await settings.getByTestId('fallback-1').selectOption('acp:backup');
  await settings.getByRole('button', { name: 'Save' }).first().click();
  await expect(settings.getByRole('status').first()).toHaveText('Saved');
  await fits(page, '[data-provider-settings]');

  // an extra account shows its sign-in folder (outside $PASABOT_HOME) and whether the CLI is signed in there
  const accounts = page.locator('[data-accounts]');
  await accounts.getByLabel('Account name').fill('Work');
  await accounts.getByRole('button', { name: 'Add account' }).click();
  await expect(accounts.locator('[data-account-signin]')).toContainText('-accounts/');
  await expect(accounts.locator('[data-account-status]')).not.toHaveText('Checking…');
  await fits(page, '[data-accounts]');

  // a turn that reports 90 % of the context: the gauge shows it and the chat says the next reply is reseeded
  await page.goto(chatUrl);
  await send(
    page,
    script([
      { event: { type: 'session', nativeRef: 'e2e-1' } },
      { event: { type: 'text.final', text: 'big answer' } },
      {
        event: {
          type: 'usage',
          inputTokens: 900,
          outputTokens: 50,
          contextUsed: 180_000,
          contextWindow: 200_000,
        },
      },
      { event: { type: 'done', stop: 'end' } },
    ]),
  );
  await expect(page.getByText('big answer', { exact: true })).toBeVisible();
  await expect(page.locator('[data-context-gauge="90"]')).toBeVisible();
  await expect(page.locator('[data-provider-notice="compacted"]')).toContainText(
    'the next reply starts a fresh session',
  );

  // a rate limit on the primary: switch notice, then the fallback answers in the same chat
  await send(
    page,
    script([
      { event: { type: 'error', kind: 'rate_limit', message: 'usage limit reached' } },
      { event: { type: 'done', stop: 'error' } },
    ]),
  );
  await expect(page.locator('[data-provider-notice="switched"]')).toContainText(
    'Switched from Fake (tests) to Backup (e2e) (rate limit)',
  );
  await expect(page.getByTestId('chat-log').getByText('echo: backup reply', { exact: true })).toBeVisible();
  await fits(page, 'body');

  // Usage page: per-agent totals and the paused primary
  await page.goto(`${server.url}/#/usage`);
  await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();
  const row = page.locator('[data-usage-row]').filter({ hasText: 'Tala' });
  await expect(row).toBeVisible();
  // 2 runs with token counts (the failed one reported none): 900 + 12 in, 50 + 3 out
  await expect(row.locator('td')).toHaveText(['Tala', '2', '912', '53', '0']);
  await expect(page.locator('[data-limits]')).toContainText('fake: rate limit');
  const check = page.locator('[data-usage-check]');
  const box = await check.boundingBox();
  // 44 px tap targets on a phone
  if (info.project.name === 'phone') expect(box!.height).toBeGreaterThanOrEqual(44);
  await fits(page, 'main');
  await page.screenshot({ path: info.outputPath(`usage-${info.project.name}.png`), fullPage: true });
});

test('below 70 % the chat header shows no context gauge; More › Context use always has it', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimAndCreateAgent(page, server, 'Tala');
  await send(
    page,
    script([
      { event: { type: 'text.final', text: 'small answer' } },
      {
        event: {
          type: 'usage',
          inputTokens: 100,
          outputTokens: 10,
          contextUsed: 40_000,
          contextWindow: 200_000,
        },
      },
      { event: { type: 'done', stop: 'end' } },
    ]),
  );
  await expect(page.getByTestId('chat-log').getByText('small answer', { exact: true })).toBeVisible();
  await page.getByTestId(phone ? 'phone-chat-more-btn' : 'chat-more-btn').click();
  await page.getByTestId('more-context-use').click();
  await expect(page.locator('[data-context-use="20"]')).toBeVisible();
  await expect(page.locator('[data-context-gauge]')).toHaveCount(0);
});

test('Brains and fallbacks name the brain in the app language after a switch, never its raw id', async ({
  page,
  server,
}, info) => {
  test.skip(info.project.name === 'phone', 'the names are the same at every width');
  await claimAndCreateAgent(page, server, 'Tala');
  await page.goto(`${server.url}/#/settings/agents/provider-ops-settings`);
  // technical setup: with Technical words off (the default) the page says so; its switch opens it in place
  await page.getByTestId('settings-technical-only').getByTestId('settings-advanced').click();
  const card = page.locator('[data-provider-settings] [data-agent-settings]').first();
  await expect(card).toContainText('Uses Fake (tests)');
  await page.goto(`${server.url}/#/settings/look/language`);
  await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption('ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.goto(`${server.url}/#/settings/agents/provider-ops-settings`);
  await expect(card).toContainText('ダミー（テスト用）を使用');
  await expect(card.getByLabel('ダミー（テスト用）のアカウント')).toBeVisible();
  await expect(card).not.toContainText('fake');
});
