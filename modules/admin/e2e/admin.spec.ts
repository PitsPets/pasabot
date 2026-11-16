/**
 * W19 in the browser (1440 + 390 px): the owner reaches Admin, renames the server, checks machine health, adds an
 * alert rule that fires, sets an agent's limits, exports the agent and imports it back, downloads diagnostics and
 * sees it all in the audit log. No side scroll, no text under 12 px, 44 px tap targets on the phone.
 */
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, send, test } from './fixtures.js';

const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

test('the owner runs the server from the Admin page', async ({ page, server }, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  await send(page, 'Kumusta ka?');
  await expect(page.getByTestId('msg-agent').first()).toBeVisible({ timeout: 15_000 });

  // reachable through Settings › Advanced (nothing is pinned to the sidebar by default), as technical setup: with
  // Technical words off it waits behind one plain line, so the switch goes on first
  await page.goto(`${server.url}/#/admin`);
  await expect(page.getByTestId('settings-technical-only')).toBeVisible();
  await page.evaluate(() =>
    fetch('/api/v1/me/prefs/ui.advanced', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true }),
    }),
  );
  await page.goto(`${server.url}/#/settings/advanced`);
  await page.reload();
  await page.getByTestId('feature-admin').getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Server admin' })).toBeVisible();

  // host identity
  const host = page.getByTestId('admin-host');
  await expect(host.getByText('Server ID')).toBeVisible();
  await host.getByLabel('Server name').fill('Bahay server');
  await host.getByRole('button', { name: 'Save name' }).click();
  await expect(host.getByLabel('Server name')).toHaveValue('Bahay server');

  // health + an alert rule that fires (disk use is always above 0 %)
  const alerts = page.getByTestId('admin-alerts');
  await alerts.getByLabel('Rule name').fill('Disk check');
  await alerts.getByLabel('Reading').selectOption('disk');
  await alerts.getByLabel('Alert above').fill('0');
  await alerts.getByRole('button', { name: 'Add rule' }).click();
  await expect(alerts.getByTestId('alert-rule')).toContainText('Never alerted');
  await page.getByTestId('admin-metrics').getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByTestId('metric-disk')).toContainText('%');
  await page.reload();
  await expect(page.getByTestId('admin-alerts').getByTestId('alert-rule')).toContainText('Last alert');

  // limits
  const limits = page.getByTestId('admin-limits');
  const tala = limits.getByTestId('limit-row').filter({ hasText: 'Tala' });
  await tala.getByLabel('Memory (MB)').fill('512');
  await tala.getByLabel('CPU (%)').fill('50');
  await tala.getByRole('button', { name: 'Save limits' }).click();
  await expect(tala.getByRole('status')).toHaveText('Saved');

  // export the agent, then import the file back as a second agent with its chat
  const bundle = page.getByTestId('admin-bundle');
  const [exported] = await Promise.all([
    page.waitForEvent('download'),
    bundle.getByRole('link', { name: 'Export Tala' }).click(),
  ]);
  expect(exported.suggestedFilename()).toBe('tala.pasabot-agent.json');
  const file = await exported.path();
  await bundle.getByLabel('Import an agent file').setInputFiles(file);
  await expect(bundle.getByRole('status')).toContainText('Imported');
  await expect(page.getByTestId('admin-limits').getByTestId('limit-row')).toHaveCount(2);

  // diagnostics download
  const [diag] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('admin-diag').getByRole('link', { name: 'Download diagnostics' }).click(),
  ]);
  expect(diag.suggestedFilename()).toMatch(/^pasabot-diagnostics-.*\.zip$/);

  // the audit log shows what happened
  await page.reload();
  const audit = page.getByTestId('admin-audit');
  await audit.getByLabel('Filter by action').fill('admin.');
  await expect(audit.getByTestId('audit-entry').filter({ hasText: 'admin.agent.imported' })).toHaveCount(1);
  await expect(
    audit.getByTestId('audit-entry').filter({ hasText: 'admin.diagnostics.exported' }),
  ).toHaveCount(1);

  // layout rules
  await noSideScroll(page);
  const tiny = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="route"] *')]
      .filter(
        (el) =>
          el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()),
      )
      .map((el) => Number.parseFloat(getComputedStyle(el).fontSize))
      .filter((px) => px < 12),
  );
  expect(tiny).toEqual([]);
  if (phone) {
    const small = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll(
            '[data-slot="route"] button, [data-slot="route"] a, [data-slot="route"] input, [data-slot="route"] select',
          ),
        ]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height < 44).length,
    );
    expect(small).toBe(0);
  }

  // the imported agent's chat opens with the old conversation in it
  const chats = await page.evaluate(async () => {
    const r = await fetch('/api/v1/chats', { credentials: 'same-origin' });
    return ((await r.json()) as { chats: { id: string; title: string }[] }).chats;
  });
  const talas = chats.filter((c) => c.title === 'Tala');
  expect(talas).toHaveLength(2);
  // only the original chat shows the line as the owner's own; in the imported copy it is outside text
  let mine = 0;
  for (const c of talas) {
    await page.goto(`${server.url}/#/chats/${c.id}`);
    await expect(page.getByText('Kumusta ka?', { exact: true })).toBeVisible();
    // the messages' words come back, not only the chat's title: the agent's reply is there too
    await expect(page.getByTestId('msg-agent').filter({ hasText: 'echo: Kumusta ka?' })).toHaveCount(1);
    mine += await page.getByTestId('msg-me').filter({ hasText: 'Kumusta ka?' }).count();
  }
  expect(mine).toBe(1);
});
