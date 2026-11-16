/**
 * W12 in a real browser, on the shared e2e server (apps/web/e2e/server.ts discovers this module; the brain is the
 * FakeProvider, which calls gateway tools for `{"probe": {"name", "args"}}`). Needs a built apps/web (dist).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

// The shared server is started as a process (modules never import apps/*), the same way apps/web's fixtures do.
type Server = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const test = base.extend<{ server: Server }>({
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
    await use(JSON.parse(line) as Server);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
});
const PASSWORD = 'correct horse battery';
async function claimServer(page: Page, server: Server) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
}
async function createFakeAgent(page: Page, name: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Keeps the shop running.');
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
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

test('owner writes a skill, switches it on for an agent, edits it (revision 2), rolls back, and the agent reads it', async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chat = page.url();

  await page.goto(`${server.url}/#/skills`);
  await expect(page.getByRole('heading', { name: "Your helpers' abilities", level: 1 })).toBeVisible();
  // the managed built-in skills are there from the start
  for (const name of ['datastore-guide', 'skill-author', 'site-publisher'])
    await expect(page.locator(`[data-skill="${name}"]`)).toBeVisible();
  await noSideScroll(page);

  // the add form opens from its card
  await page.getByTestId('skills-add-open').click();
  // the skill-creator form
  await page.getByLabel('Name', { exact: true }).fill('pricing');
  await page.getByLabel('When to use it').fill('Use when quoting a job');
  await page.getByLabel('Instructions').fill('Version one: add 12% VAT.');
  await page.getByRole('button', { name: 'Make this ability' }).click();
  const detail = page.locator('[data-skill-detail="pricing"]');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Revision 1', { exact: true })).toBeVisible();

  // switch it on for Tala only
  const tala = detail.getByLabel('Tala', { exact: true });
  // the box follows the server's answer (a controlled input), so click and wait rather than check()
  await tala.click();
  await expect(tala).toBeChecked();
  await expect(detail.getByText('On for 1 helper')).toBeVisible();

  // edit SKILL.md: revision 2
  const editor = detail.getByLabel('Its text');
  await expect(editor).toHaveValue(/Version one/);
  await editor.fill(
    (await editor.inputValue()).replace('Version one: add 12% VAT.', 'Version two: add 15% VAT.'),
  );
  await detail.getByRole('button', { name: 'Save as new revision' }).click();
  await expect(detail.getByRole('status')).toHaveText('Saved as a new revision.');
  await expect(detail.locator('[data-skill-rev="2"]')).toContainText('current');
  await noSideScroll(page);

  // roll back to revision 1: a new revision 3 with revision 1's text
  await detail.getByRole('button', { name: 'Roll back to 1' }).click();
  await expect(detail.locator('[data-skill-rev="3"]')).toContainText('rollback to 1');
  await expect(detail.locator('[data-skill-rev="3"]')).toContainText('current');
  await expect(editor).toHaveValue(/Version one/);
  await noSideScroll(page);

  // the agent sees the current revision through its tools
  await page.goto(chat);
  await expect(page.getByTestId('composer')).toBeVisible();
  await send(page, probe('skills_read', { name: 'pricing' }));
  const reply = page.getByTestId('msg-agent').filter({ hasText: 'tool said' });
  await expect(reply).toHaveCount(1, { timeout: 15_000 });
  await expect(reply).toContainText('Version one: add 12% VAT.');
  await expect(reply).toContainText('"rev":3');
});

test('a skill made by an agent shows as agent-made, starts on for that agent only, and the owner can uninstall it', async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Ligaya');
  await send(
    page,
    probe('skills_create', {
      name: 'stock-count',
      description: 'Use when counting stock',
      instructions: 'Count twice.',
    }),
  );
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'tool said' })).toContainText(
    '"createdTrust":"trusted"',
    { timeout: 15_000 },
  );

  await page.goto(`${server.url}/#/skills`);
  const card = page.locator('[data-skill="stock-count"]');
  await expect(card).toContainText('Made by a helper (trusted)');
  await expect(card).toContainText('On for 1 helper');
  await card.getByRole('button', { name: 'Open stock-count' }).click();
  const detail = page.locator('[data-skill-detail="stock-count"]');
  await expect(detail.getByLabel('Ligaya', { exact: true })).toBeChecked();
  await expect(detail).toContainText('A helper wrote or changed this');
  await noSideScroll(page);
  await detail.getByRole('button', { name: 'Uninstall' }).click();
  await detail.getByRole('button', { name: 'Yes, uninstall with all revisions' }).click();
  await expect(page.locator('[data-skill="stock-count"]')).toHaveCount(0);
  await expect(page.locator('[data-skill="skill-author"]')).toBeVisible();
});

for (const vp of [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]) {
  test(`W39 at ${vp.name}: the permissions a skill gets show before install and on the installed skill`, async ({
    page,
    server,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'the viewport is set by the test itself');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await page.goto(`${server.url}/#/skills`);
    await expect(page.getByRole('heading', { name: "Your helpers' abilities", level: 1 })).toBeVisible();

    await page.getByTestId('skills-add-open').click();
    // before install: the plain summary follows what the owner picks
    const wants = page.getByTestId('skill-wants-summary');
    await expect(wants.locator('[data-perm="files"]')).toContainText('Only its helper’s own folder');
    await expect(wants.locator('[data-perm="network"]')).toContainText('No websites');
    await expect(wants.locator('[data-perm="messaging"]')).toContainText('No');
    await page.getByLabel('Websites it may reach').fill('api.example.test\n*.shop.example.test');
    const msg = page.getByLabel(/^May send messages to other people/);
    await msg.check();
    await expect(wants.locator('[data-perm="network"]')).toContainText(
      'api.example.test, *.shop.example.test',
    );
    await expect(wants.locator('[data-perm="messaging"]')).toContainText('each one asks you first');
    if (vp.width <= 600) {
      const box = await page.locator('label', { has: msg }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await noSideScroll(page);
    await page.screenshot({ path: info.outputPath(`skill-wants-${vp.name}.png`), fullPage: true });

    await page.getByLabel('Name', { exact: true }).fill('quotes');
    await page.getByLabel('When to use it').fill('Use when quoting a job');
    await page.getByLabel('Instructions').fill('Add 12% VAT.');
    await page.getByRole('button', { name: 'Make this ability' }).click();
    await expect(page.locator('[data-skill-detail="quotes"]')).toBeVisible();
    await page.getByRole('button', { name: 'Back to the list' }).click();

    // the installed skill shows the same permissions; one never set up says it may use nothing
    const perms = page.locator('[data-skill="quotes"]').getByTestId('skill-permissions');
    await expect(perms.locator('[data-perm="network"]')).toContainText(
      'api.example.test, *.shop.example.test',
    );
    await expect(perms.locator('[data-perm="messaging"]')).toContainText('each one asks you first');
    await expect(perms.locator('[data-perm="files"]')).toContainText('Only its helper’s own folder');
    await expect(
      page.locator('[data-skill="datastore-guide"]').getByTestId('skill-permissions'),
    ).toHaveAttribute('data-perms', 'none');
    await noSideScroll(page);
  });
}

// W39 review fixes: tools are shown, a bad list never installs, a failed permission save is reported (not swallowed),
// a proposal shows what it adds against the approved manifest, approve sends the version shown (409 = reload), and
// the decision bar only names the skill and links to Skills (no approve in place).
for (const vp of [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]) {
  test(`W39 fixes at ${vp.name}: tools shown, failed save reported, proposals compared and approved by version`, async ({
    page,
    server,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'the viewport is set by the test itself');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await page.goto(`${server.url}/#/skills`);
    await expect(page.getByRole('heading', { name: "Your helpers' abilities", level: 1 })).toBeVisible();

    await page.getByTestId('skills-add-open').click();
    // the summary lists tools, outside `server/tool` refs flagged; and says the limits are recorded only
    const wants = page.getByTestId('skill-wants-summary');
    await expect(wants.locator('[data-perm="tools"]')).toContainText('No tools');
    await page.getByLabel('Tools it may call').fill('memory_search\ngmail/send_draft');
    await expect(wants.locator('[data-entry="memory_search"]')).toBeVisible();
    await expect(wants.locator('[data-entry="gmail/send_draft"]')).toContainText('outside tool');
    await expect(page.getByTestId('skill-wants')).toContainText('Ordinary chats are not limited');
    await page.getByLabel('Tools it may call').fill('memory_search');

    await page.getByLabel('Name', { exact: true }).fill('quotes');
    await page.getByLabel('When to use it').fill('Use when quoting a job');
    await page.getByLabel('Instructions').fill('Add 12% VAT.');
    // a website written as a URL is refused before anything is installed
    await page.getByLabel('Websites it may reach').fill('https://docs.example.test/a');
    await page.getByRole('button', { name: 'Make this ability' }).click();
    await expect(page.getByRole('alert')).toContainText('Write each website as a name only');
    await expect(page.locator('[data-skill="quotes"]')).toHaveCount(0);
    await page.getByLabel('Websites it may reach').fill('docs.example.test');

    // the permission save fails once: reported with retry/remove, the form is kept
    let failPut = true;
    await page.route('**/api/m/safety/skills/*/manifest', async (route) => {
      if (route.request().method() === 'PUT' && failPut) {
        failPut = false;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'disk full' }),
        });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Make this ability' }).click();
    const unsaved = page.getByTestId('skill-perms-unsaved');
    await expect(unsaved).toContainText(
      'quotes is installed, but its permissions were not saved (disk full)',
    );
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('quotes');
    await expect(page.getByRole('button', { name: 'Make this ability' })).toBeDisabled();
    if (vp.width <= 600) {
      const box = await unsaved.getByRole('button', { name: 'Save permissions again' }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await noSideScroll(page);
    await unsaved.getByRole('button', { name: 'Save permissions again' }).click();
    await expect(page.locator('[data-skill-detail="quotes"]')).toBeVisible();
    await page.getByRole('button', { name: 'Back to the list' }).click();
    const perms = page.locator('[data-skill="quotes"]').getByTestId('skill-permissions');
    await expect(perms.locator('[data-entry="memory_search"]')).toBeVisible();
    await expect(perms.locator('[data-entry="docs.example.test"]')).toBeVisible();

    // an agent's proposal (served from a fixture: agents propose over run auth, covered by the safety tests)
    const id = await page.evaluate(async () => {
      const r = (await (await fetch('/api/m/skills/skills')).json()) as {
        skills: { id: string; name: string }[];
      };
      return r.skills.find((s) => s.name === 'quotes')!.id;
    });
    const current = {
      files: { workspaceOnly: true, paths: [] },
      network: { hosts: ['docs.example.test'] },
      messaging: false,
      tools: ['memory_search'],
    };
    const proposal = (version: string, hosts: string[]) => ({
      skillId: id,
      approved: true,
      current,
      manifest: {
        files: { workspaceOnly: true, paths: [] },
        network: { hosts },
        messaging: true,
        tools: ['memory_search', 'bash', 'gmail/send_draft'],
      },
      by: 'agent',
      trust: 'guarded',
      at: 1,
      version,
    });
    let served: unknown[] = [proposal('v1', ['attacker.example'])];
    await page.route('**/api/m/safety/skills/proposals', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ proposals: served }) }),
    );
    const sent: unknown[] = [];
    let conflict = true;
    await page.route(`**/api/m/safety/skills/${id}/manifest/approve`, async (route) => {
      sent.push(route.request().postDataJSON());
      if (conflict) {
        conflict = false;
        served = [proposal('v2', ['*.com'])];
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'changed' }),
        });
      }
      served = [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ approved: true }) });
    });
    await page.reload();
    const card = page.locator(`[data-proposal="${id}"]`);
    await expect(card.locator('strong')).toHaveText('quotes');
    await expect(card).toContainText('This changes the permissions you approved before.');
    const shown = card.getByTestId('proposal-permissions');
    await expect(shown.locator('[data-entry="bash"]')).toHaveAttribute('data-new', 'true');
    await expect(shown.locator('[data-entry="gmail/send_draft"]')).toHaveAttribute('data-new', 'true');
    await expect(shown.locator('[data-entry="gmail/send_draft"]')).toContainText('outside tool');
    await expect(shown.locator('[data-entry="memory_search"]')).not.toHaveAttribute('data-new', 'true');
    await expect(shown.locator('[data-entry="attacker.example"]')).toHaveAttribute('data-new', 'true');
    await expect(shown.locator('[data-perm="network"]')).toContainText('No longer: docs.example.test');
    await expect(shown.locator('[data-perm="messaging"]')).toHaveAttribute('data-new', 'true');
    await noSideScroll(page);
    await page.screenshot({ path: info.outputPath(`skill-proposal-${vp.name}.png`), fullPage: true });

    // the decision bar names the skill and only links to Skills: no approve in place
    const bar = page.getByTestId('detached-decisions');
    await expect(bar.getByTestId('decision-bar')).toContainText('1 decision waiting');
    await bar.getByRole('button', { name: 'Review' }).click();
    const sheet = page.getByRole('dialog', { name: 'Review' });
    const item = sheet.locator(`[data-decision-id="safety:proposal:${id}"]`);
    await expect(item).toContainText('Skill “quotes” asks for permissions');
    await expect(item).toContainText('It asks for more than you approved');
    await expect(item).not.toContainText(id);
    await expect(item.getByRole('button')).toHaveCount(0);
    await expect(item.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '#/skills');
    await noSideScroll(page);
    await item.getByRole('link', { name: 'Open' }).click();

    // approve sends the version shown; the agent swapped it meanwhile, so 409 and the new one is shown
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('alert')).toContainText('This request changed after you opened it');
    await expect(card).toHaveAttribute('data-version', 'v2');
    await expect(shown.locator('[data-entry="*.com"]')).toHaveAttribute('data-new', 'true');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('skills-proposed')).toHaveCount(0);
    expect(sent).toEqual([{ version: 'v1' }, { version: 'v2' }]);
  });
}

// R7 review (high): the page opens on the abilities the helpers already have, not on a blank form; adding one is a
// card with a clear button, and an empty field is said next to that field in plain words (nothing is sent).
test('Skills opens on the list, the add form waits behind its card, and an empty field is told in plain words', async ({
  page,
  server,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'the viewport is set by the test itself');
  await page.setViewportSize({ width: 390, height: 844 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  await page.goto(`${server.url}/#/skills`);
  await expect(page.getByRole('heading', { name: "Your helpers' abilities", level: 1 })).toBeVisible();
  const first = page.locator('[data-skill="datastore-guide"]');
  const card = page.getByTestId('skills-add-card');
  await expect(first).toBeVisible();
  await expect(card).toBeVisible();
  // no form before the owner asks for one, and the abilities she has come before the add card
  await expect(page.getByTestId('skills-add-form')).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);
  expect((await first.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
  const open = card.getByRole('button', { name: 'Add', exact: true });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('skills-list-first-390.png'), fullPage: true });

  // pressing the main button with nothing filled in: a plain line next to each empty field, no request, no raw error
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/m/skills/skills') posts++;
  });
  await open.click();
  const form = page.getByTestId('skills-add-form');
  await expect(form).toBeVisible();
  await expect(card).toHaveCount(0);
  await form.getByRole('button', { name: 'Make this ability' }).click();
  await expect(form.getByText('Give it a name first', { exact: true })).toBeVisible();
  await expect(form.getByText('Say when to use it first', { exact: true })).toBeVisible();
  await expect(form.getByText('Write its instructions first', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText(/Something went wrong/)).toHaveCount(0);
  expect(posts).toBe(0);
  // a filled field drops its line at once
  await page.getByLabel('Name', { exact: true }).fill('quotes');
  await expect(form.getByText('Give it a name first', { exact: true })).toHaveCount(0);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('skills-empty-fields-390.png'), fullPage: true });

  // Cancel folds the form back into its card
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('skills-add-form')).toHaveCount(0);
  await expect(page.getByTestId('skills-add-card')).toBeVisible();
});
