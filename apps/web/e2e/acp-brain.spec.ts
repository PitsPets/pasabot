import { fileURLToPath } from 'node:url';
import { pickBrain } from '../../../packages/testkit/src/e2e.js';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

const INDEX = fileURLToPath(
  new URL('../../../modules/acp-registry/fixtures/local-index.json', import.meta.url),
);

test('an ACP agent installed from the registry is a brain in the agent form, without a reload', async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page);

  // Settings -> ACP agents: point at the local test index and install the echo agent. The stored index answers
  // late on purpose (a busy server did this under a full run): what the owner typed meanwhile must stay
  let release!: () => void;
  const late = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/m/acp-registry/settings', async (route) => {
    if (route.request().method() === 'GET') await late;
    await route.continue();
  });
  await page.evaluate(() => {
    location.hash = '#/settings/agents/acp-agents';
  });
  // ACP agents are technical setup: with Technical words off the page says so, and its switch opens it in place
  await expect(page.getByTestId('settings-technical-only')).toBeVisible();
  await page.getByTestId('settings-advanced').click();
  const acp = page.getByTestId('acp-registry');
  await acp.getByLabel('Registry index').fill(INDEX);
  // the section asks for the installed list right after it applied the stored index
  const loaded = page.waitForResponse((r) => r.url().endsWith('/api/m/acp-registry/installed'));
  release();
  await loaded;
  await expect(acp.getByLabel('Registry index')).toHaveValue(INDEX);
  await acp.getByRole('button', { name: 'Save' }).click();
  await acp.getByRole('button', { name: /Install ACP echo agent/ }).click();
  // the index card stays listed, so wait for the installed card itself
  await expect(
    acp.getByRole('article').filter({ hasText: 'ACP echo agent' }).filter({ hasText: 'Installed' }),
  ).toBeVisible({ timeout: 15_000 });

  // the agent form offers it at once (same page, no reload)
  await page.evaluate(() => {
    location.hash = '#/agents/new';
  });
  const brain = page.getByTestId('brain-picker').getByTestId('brain-option-acp:echo');
  await expect(brain).toHaveCount(1);
  await pickBrain(page, 'acp:echo');
  await expect(brain.getByRole('radio')).toBeChecked();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});
