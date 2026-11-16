/**
 * The Brains page in a real browser (1200 and 390 px). The e2e server registers only the Fake brain, so every other
 * brain is a "Not installed" tile with its install steps; the Fake one is Ready and its Test answers. No real CLI is
 * ever run. Also: "Use for a new agent" opens the agent form on that brain with the backup picker; the onboarding
 * brain step lists the same tiles.
 */
import { openMoreOptions } from '../../../packages/testkit/src/e2e.js';
import { claimServer, expect, test } from './fixtures.js';

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1200, height: 900 });
});

async function fits(page: import('@playwright/test').Page, scope: string) {
  const o = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    return {
      over: document.documentElement.scrollWidth - window.innerWidth,
      tiny: root
        ? [...root.querySelectorAll('*')].filter((el) => {
            const s = getComputedStyle(el);
            return (
              [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
              s.visibility !== 'hidden' &&
              el.getClientRects().length > 0 &&
              Number.parseFloat(s.fontSize) < 12
            );
          }).length
        : -1,
      smallButtons: root
        ? [...root.querySelectorAll('button')].filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height < 44;
          }).length
        : -1,
    };
  }, scope);
  expect(o.over, 'horizontal scroll').toBeLessThanOrEqual(0);
  expect(o.tiny, 'text under 12px').toBe(0);
  return o;
}

test('Brains page: real states, install steps, Test on a ready brain, use for a new agent', async ({
  page,
  server,
}, info) => {
  await claimServer(page, server);
  // the onboarding step was passed by claimServer; the page is reachable directly
  await page.evaluate(() => {
    location.hash = '#/brains'; // older address: lands on #/settings/agents/brains
  });
  await expect(page).toHaveURL(/#\/settings\/agents\/brains$/);
  const page$ = page.getByTestId('brains-page');
  await expect(page$.getByRole('heading', { name: 'Brains', level: 1 })).toBeVisible();
  const tile = (id: string) => page.locator(`[data-testid="brain-tile"][data-brain="${id}"]`);
  await expect(page.getByTestId('brain-tile')).toHaveCount(8);
  for (const id of ['claude', 'codex', 'opencode', 'gemini', 'grok', 'local', 'acp'])
    await expect(tile(id)).toHaveAttribute('data-state', 'not_installed');
  await expect(tile('claude')).toContainText('Not on this computer');
  await expect(tile('claude')).toContainText("Anthropic's Claude Code app");
  await expect(tile('fake')).toHaveAttribute('data-state', 'ready');
  await fits(page, '[data-testid="brains-page"]');
  if (info.project.name === 'phone') {
    const o = await fits(page, '[data-testid="brains-page"]');
    expect(o.smallButtons, 'tap targets under 44 px').toBe(0);
  }

  // Not installed → the steps with the exact install command and a copy button
  await tile('claude').getByRole('button', { name: 'Install' }).click();
  const steps = page.getByTestId('brain-steps');
  await expect(steps).toBeVisible();
  await expect(steps.locator('[data-cmd]').first()).toHaveText('npm install -g @anthropic-ai/claude-code');
  await expect(steps.getByRole('button', { name: /Copy/ }).first()).toBeVisible();
  await fits(page, 'dialog[open]');
  await steps.getByRole('button', { name: 'Close' }).click();
  await expect(steps).toHaveCount(0);

  // the free starter (QA r7): with Technical words off its dialog speaks plain words (no app name, folder or download
  // address); the Terminal steps and those details show only with Technical words on
  await tile('opencode').getByRole('button', { name: 'Install' }).click();
  const starter = page.getByTestId('brain-steps');
  await expect(starter.getByTestId('brain-starter-install')).toBeVisible();
  await expect(starter).toContainText('PasaBot can install it for you in one tap');
  await expect(starter.getByTestId('brain-starter-facts')).toHaveCount(0);
  await expect(starter.locator('[data-cmd]')).toHaveCount(0);
  const plainText = (await page.locator('dialog[open]').innerText()).replace(/\s+/g, ' ');
  expect(plainText).not.toMatch(/\bCLI\b|github|https?:|\/Users\/|\/home\//i);
  await fits(page, 'dialog[open]');
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    fetch('/api/v1/me/prefs/ui.advanced', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true }),
    }),
  );
  await page.reload();
  await tile('opencode').getByRole('button', { name: 'Install' }).click();
  await expect(page.getByTestId('brain-starter-facts')).toBeVisible();
  await expect(page.getByTestId('brain-steps').locator('[data-cmd]').first()).toHaveText(
    'npm install -g opencode-ai',
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    fetch('/api/v1/me/prefs/ui.advanced', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: false }),
    }),
  );
  await page.reload();

  // Grok keeps its key in the vault, never on the page: "Add key" is right in the steps (a password field) and
  // the value goes straight to the vault's owner-only save in the brain's own scope. Only the Fake brain is
  // registered here, so the save itself is answered by the test (the vault's own route is unit-tested).
  await tile('grok').getByRole('button', { name: 'Install' }).click();
  await expect(page.getByTestId('brain-steps')).toContainText('XAI_API_KEY');
  const sent: unknown[] = [];
  await page.route('**/api/m/vault/secrets', async (r) => {
    sent.push(r.request().postDataJSON());
    await r.fulfill({ status: 201, json: { id: 'x', scope: 'brain:grok', name: 'XAI_API_KEY' } });
  });
  const keyField = page.getByTestId('brain-key-form').getByLabel('Key for Grok');
  await expect(keyField).toHaveAttribute('type', 'password');
  const testValue = 'e2e-not-a-real-key-123';
  await keyField.fill(testValue);
  await page.getByTestId('brain-key-form').getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByTestId('brain-key-status')).toHaveText('Key saved in the Vault.');
  await expect(keyField).toHaveValue('');
  expect(sent).toEqual([{ target: 'brain:grok', name: 'XAI_API_KEY', value: testValue }]);
  expect(await page.content()).not.toContain(testValue);
  await fits(page, 'dialog[open]');
  await page.unroute('**/api/m/vault/secrets');
  await page.keyboard.press('Escape');

  // Claude signed out (qa-a 1c): its sign-in steps offer the headless way too, a setup token from
  // `claude setup-token`, saved like any brain key in its own vault scope and never shown again
  await page.route('**/api/m/provider-ops/brains?*', async (r) => {
    const res = await r.fetch();
    const body = (await res.json()) as { brains: { id: string; state: string }[] };
    for (const b of body.brains)
      if (b.id === 'claude')
        Object.assign(b, { state: 'needs_sign_in', stateLabel: 'Needs sign-in', version: '2.1.0' });
    await r.fulfill({ response: res, json: body });
  });
  await page.reload();
  await expect(tile('claude')).toHaveAttribute('data-state', 'needs_sign_in');
  await expect(tile('claude')).toContainText('Needs sign-in');
  await tile('claude').getByRole('button', { name: 'Sign in' }).click();
  const tokenForm = page.locator('[data-testid="brain-key-form"][data-kind="setup-token"]');
  await expect(tokenForm).toContainText('Or paste a setup token');
  await expect(tokenForm.locator('[data-cmd]')).toHaveText('claude setup-token');
  await expect(tokenForm).not.toContainText('CLAUDE_CODE_OAUTH_TOKEN');
  const tokenSent: unknown[] = [];
  await page.route('**/api/m/vault/secrets', async (r) => {
    tokenSent.push(r.request().postDataJSON());
    await r.fulfill({
      status: 201,
      json: { id: 'y', scope: 'brain:claude', name: 'CLAUDE_CODE_OAUTH_TOKEN' },
    });
  });
  const tokenField = tokenForm.getByLabel('Setup token');
  await expect(tokenField).toHaveAttribute('type', 'password');
  const tokenValue = 'sk-ant-oat01-e2e-not-a-real-token';
  await tokenField.fill(tokenValue);
  await tokenForm.getByRole('button', { name: 'Save token' }).click();
  await expect
    .poll(() => tokenSent)
    .toEqual([{ target: 'brain:claude', name: 'CLAUDE_CODE_OAUTH_TOKEN', value: tokenValue }]);
  await expect(tokenField).toHaveValue('');
  await expect(page.getByTestId('brain-key-status')).toHaveText('Token saved. Checking Claude now…');
  expect(await page.content()).not.toContain(tokenValue);
  await page.unroute('**/api/m/vault/secrets');
  await page.unroute('**/api/m/provider-ops/brains?*');
  await page.keyboard.press('Escape');
  await page.reload();

  // Local model: its set-up opens that very section of Settings › Agents & brains
  await tile('local').getByRole('button', { name: 'Install' }).click();
  await page.getByTestId('brain-steps').locator('[data-action="setup"]').click();
  await expect(page).toHaveURL(/#\/settings\/agents\/local$/);
  await expect(page.locator('[data-settings-section="local"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings\/agents\/brains$/);

  // Test on the ready brain: the reply shows inside the tile
  await tile('fake').getByRole('button', { name: 'Test' }).click();
  const result = tile('fake').getByTestId('brain-test-result');
  await expect(result).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
  await expect(result).toContainText('Works. Reply:');
  await fits(page, '[data-testid="brains-page"]');
  // for the reviewer: the page with a test result (test-results/, not committed)
  await page.screenshot({ path: info.outputPath(`brains-${info.project.name}.png`), fullPage: true });

  // Use for a new helper (Technical words off) → the form on that brain, with a backup picker under "More options"
  await tile('fake').getByRole('button', { name: 'Use for a new helper' }).click();
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
  await expect(page.getByTestId('brain-option-fake').getByRole('radio')).toBeChecked();
  await expect(page.getByTestId('backup-picker')).toBeHidden();
  await openMoreOptions(page);
  await expect(page.getByTestId('backup-picker')).toBeVisible();
  // only the Fake brain is registered here and it is ready: nothing to fix, so no set-up link
  await expect(page.getByTestId('brains-setup-link')).toHaveCount(0);
  await fits(page, 'body');
});

test('Brains sits in Settings › Agents & brains with its icon, has no sidebar entry and can be pinned', async ({
  page,
  server,
}) => {
  await claimServer(page, server);
  const at = (hash: string) =>
    page.evaluate((h) => {
      location.hash = h;
    }, hash);
  const shown = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  // no sidebar entry of its own (the old one was at #/brains)
  await at('#/');
  await expect(page.locator('a[href="#/brains"]')).toHaveCount(0);
  await expect(page.locator('a[href="#/settings/agents/brains"]:visible')).toHaveCount(0);
  // Settings › Agents & brains lists it with the brain icon and opens the page inside Settings
  await at('#/settings/agents');
  const row = shown('feature-brains').first();
  await expect(row).toBeVisible();
  await expect(row.locator('svg[data-icon="brain"]').first()).toBeAttached();
  await row.locator('a').first().click();
  await expect(page).toHaveURL(/#\/settings\/agents\/brains$/);
  await expect(page.getByTestId('brains-page')).toBeVisible();
  await expect(page.locator('.set-crumbs')).toBeVisible();
  // never hideable; pinnable, and the pin shows on the sidebar (the home list on a phone) with the icon
  await at('#/settings/agents');
  const pin = shown('pin-brains').first();
  await expect(pin).toHaveAttribute('aria-checked', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-checked', 'true');
  await at('#/');
  const pinned = shown('pinned-brains').first();
  await expect(pinned).toBeVisible();
  await expect(pinned.locator('svg[data-icon="brain"]')).toBeAttached();
  await pinned.locator('a.room').click();
  await expect(page).toHaveURL(/#\/settings\/agents\/brains$/);
  await expect(page.getByTestId('brains-page')).toBeVisible();
});
