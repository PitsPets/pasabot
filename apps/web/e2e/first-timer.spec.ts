/**
 * First run with the Settings "Technical words" switch off. The first run itself (claim -> "Pick a brain" -> the
 * team builder's chat, its interview, the plan card and the team) is walked in `team-setup.spec.ts`.
 *
 * Then the first-timer path with the Settings "Technical words" switch off (the default), at 1200 px and 390 px, in
 * English, Filipino and Arabic: claim (two short lines, a one-line trust note with the full note one tap away) ->
 * first agent -> a first reply -> Settings shows every group in three sections, nothing folded, and Technical words
 * on hides and adds nothing (it only changes wording). No sideways scroll on any of these screens.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  claimServer,
  createFakeAgent,
  delta,
  done,
  expect,
  expectAllSettingsGroups,
  final,
  script,
  send,
  test,
} from './fixtures.js';

type Web = {
  settings: { advancedSwitch: string; moreOptions: string };
  setup: { trustLine: string; trustHow: string };
  onboarding: {
    step: string;
    brainTitle: string;
    meetTitle: string;
    start: string;
    defaultName: string;
    next: string;
  };
  agents: {
    name: string;
    moreOptions: string;
    helpWith: string;
    trustShort: string;
    trustWarning: string;
    helpIdeas: Record<string, string>;
    helpFill: Record<string, string>;
  };
  chat: { starters: Record<'can' | 'week' | 'message' | 'dinner', string> };
};
const web = (lng: string) =>
  JSON.parse(readFileSync(new URL(`../locales/${lng}.json`, import.meta.url), 'utf8')) as Web;

const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1200, height: 800 });
});

const PASSWORD = 'correct horse battery';

for (const lng of ['en', 'fil', 'ar'] as const)
  test(`${lng}: first-timer path: every Settings group, Technical words hides no group`, async ({
    page,
    server,
  }) => {
    const w = web(lng);
    // claim: the trust note is one friendly line; the full note is folded behind "How it asks you"
    await page.goto(server.setupLink);
    await expect(page.getByTestId('trust-warning')).toContainText(web('en').setup.trustLine);
    expect(await noSideScroll(page)).toBe(true);
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await send(page, script([delta('Hi! '), final('Hi! How can I help?'), done]));
    await expect(page.getByText('How can I help?').locator('visible=true').first()).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);

    if (lng !== 'en') {
      await page.goto(`${server.url}/#/settings/look/language`);
      await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
      await expect(page.locator('html')).toHaveAttribute('lang', lng);
    }

    // Settings: every group from the start, in three sections; "Technical words" is off and hides no group
    await page.goto(`${server.url}/#/settings`);
    const adv = page.getByTestId('settings-advanced');
    await expect(adv).toHaveAttribute('aria-checked', 'false');
    await expect(adv).toHaveAccessibleName(w.settings.advancedSwitch);
    const home = page.getByTestId('settings-home-groups');
    await expectAllSettingsGroups(home);
    await expect(home.getByTestId('settings-group-safety')).toBeVisible();
    await expect(home.getByTestId('settings-group-tools')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);

    // Agents & brains: every everyday feature in one list, nothing folded away; the technical-setup ones (ACP
    // agents) wait behind Technical words, and Advanced says so in one plain line (W30)
    await page.goto(`${server.url}/#/settings/agents`);
    await expect(page.locator('[data-testid="feature-brains"]:visible')).toBeVisible();
    await expect(page.locator('[data-testid="feature-acp-agents"]')).toHaveCount(0);
    await page.goto(`${server.url}/#/settings/advanced`);
    await expect(page.getByTestId('settings-technical-note')).toBeVisible();
    await page.goto(`${server.url}/#/settings/agents`);
    await expect(page.getByTestId('settings-more')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);

    // Technical words on: the same groups (it only changes wording)
    await page.goto(`${server.url}/#/settings`);
    await page.getByTestId('settings-advanced').click();
    await expect(adv).toHaveAttribute('aria-checked', 'true');
    await expectAllSettingsGroups(page.getByTestId('settings-home-groups'));
    expect(await noSideScroll(page)).toBe(true);
    // and the technical-setup features are listed in their own groups again
    await page.goto(`${server.url}/#/settings/agents`);
    await expect(page.locator('[data-testid="feature-acp-agents"]:visible')).toBeVisible();
  });

// "Pick a brain" waits for the brain list. The starter answers at once and the list (real brains, not the test brain)
// comes 1.5 s later: the best ready brain is ticked, signed-in first; the starter is a second choice only, and a tap
// is never undone by data that lands later.
const STARTER_OFFER = {
  available: true,
  models: [{ id: 'opencode/test-free', name: 'Test free' }],
  consent: { what: 'OpenCode 1.0.0', where: 'inside PasaBot', from: 'github.com' },
};
const brain = (id: string, displayName: string, installed: boolean, signedIn: boolean | 'unknown') => ({
  id,
  displayName,
  status: { installed, signedIn },
});
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function slowBrains(page: Page, opencodeReady: boolean) {
  await page.route('**/api/m/templates/starter', (r) => r.fulfill({ json: STARTER_OFFER }));
  await page.route('**/api/v1/providers', async (r) => {
    await later(1500);
    await r.fulfill({
      json: {
        providers: [
          brain('fake', 'Fake', true, true),
          brain('claude', 'Claude', true, 'unknown'),
          brain('codex', 'Codex', true, true),
          brain('opencode', 'OpenCode', opencodeReady, opencodeReady ? 'unknown' : false),
        ],
      },
    });
  });
}
async function claimOnly(page: Page, setupLink: string) {
  await page.goto(setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByTestId('onb-brain')).toBeVisible();
}
const ticked = (page: Page, id: string) => page.getByTestId(`onb-brain-${id}`).locator('input');

test('pick a brain: a slow brain list still ticks the best ready brain, never the starter', async ({
  page,
  server,
}) => {
  await slowBrains(page, true);
  await claimOnly(page, server.setupLink);
  await expect(ticked(page, 'codex')).toBeChecked();
  await expect(page.getByTestId('onb-next')).toHaveText(web('en').onboarding.next);
  // OpenCode itself is ready, so the starter is not offered, and its note never shows
  await expect(page.getByTestId('onb-brain-starter')).toHaveCount(0);
  await expect(page.getByTestId('onb-starter-note')).toHaveCount(0);
  await expect(page.locator('[data-testid="onb-brains"] input:checked')).toHaveCount(1);
});

test('pick a brain: the starter stays a second choice while a brain is ready; a tap sticks', async ({
  page,
  server,
}) => {
  await slowBrains(page, false);
  // a local model server that answers late, after the owner already tapped
  await page.route('**/api/m/local/detect', async (r) => {
    await later(3000);
    await r.fulfill({
      json: { found: [{ name: 'Ollama', api: 'ollama', url: 'http://127.0.0.1:11434', models: 0 }] },
    });
  });
  await claimOnly(page, server.setupLink);
  await expect(ticked(page, 'codex')).toBeChecked();
  await expect(ticked(page, 'starter')).not.toBeChecked();
  await expect(page.getByTestId('onb-next')).toHaveText(web('en').onboarding.next);
  await page.getByTestId('onb-brain-starter').click();
  await expect(ticked(page, 'starter')).toBeChecked();
  await expect(page.getByTestId('onb-next')).toHaveText('Download and continue');
  await expect(page.getByTestId('onb-brain-found:http://127.0.0.1:11434')).toBeVisible({ timeout: 6000 });
  await expect(ticked(page, 'starter')).toBeChecked();
  await page.getByTestId('onb-brain-claude').click();
  await expect(ticked(page, 'claude')).toBeChecked();
  await expect(page.getByTestId('onb-next')).toHaveText(web('en').onboarding.next);
});

// a free-starter download that fails says so in one plain sentence; the raw reason waits under "Details"
test('a failed free-starter install: one plain sentence, the raw error under Details', async ({
  page,
  server,
}) => {
  await page.route('**/api/m/templates/starter', (r) =>
    r.fulfill({
      json: {
        available: true,
        models: [{ id: 'opencode/test-free', name: 'Test free' }],
        consent: { what: 'OpenCode 1.0.0', where: 'inside PasaBot', from: 'github.com' },
      },
    }),
  );
  await page.route('**/api/m/templates/starter/install', (r) =>
    r.fulfill({
      status: 502,
      json: { error: 'download_failed', message: 'sha256 mismatch for opencode-1.0.0.tgz' },
    }),
  );
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await page.getByTestId('onb-brain-starter').click();
  await page.getByTestId('onb-next').click();
  const box = page.getByTestId('onb-error-box');
  await expect(box.getByTestId('onb-error')).toHaveText(
    "The free starter didn't install. Try again, or pick another brain.",
  );
  await expect(box.getByTestId('onb-error')).not.toContainText('sha256');
  await expect(box.getByTestId('onb-error-detail')).toBeHidden();
  await box.getByText('Details').click();
  await expect(box.getByTestId('onb-error-detail')).toHaveText('sha256 mismatch for opencode-1.0.0.tgz');
  // nothing was made: no agent in the list
  await expect(page.locator('[data-testid="chats-list"] li:not(.pin-row)')).toHaveCount(0);
});
