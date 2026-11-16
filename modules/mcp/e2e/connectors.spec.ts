/**
 * W18 Connectors in the browser, in English and Filipino at 1200 and 390 px: each card shows one plain state
 * (Added, Ready to add, Needs sign-in or key, Not on this computer), "Ready to add" with nothing to type is one tap,
 * a key is asked for alone in a password field, and a tool server set up in another app is offered by name and
 * imported with its key moved to the vault (never shown). Detection runs against a fake PATH (`uvx`, `docker` that
 * would leave a mark if anything ran them), an empty apps folder and a fake home, never this machine's own.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type E2EServer = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ECHO = fileURLToPath(new URL('../src/__fixtures__/echo-mcp.mjs', import.meta.url));
const SECRET = 'sk-e2e-NOTES-key-0123456789abcdef';
const PASSWORD = 'correct horse battery';

type Strings = Record<string, any>;
const strings = (lng: string) =>
  JSON.parse(
    readFileSync(new URL(`../../connectors/locales/${lng}.json`, import.meta.url), 'utf8'),
  ) as Strings;
const fill = (s: string, v: Record<string, string>) =>
  s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => v[k] ?? '');

/** a fake PATH, apps folder and home for detection; the fake commands write `ran` if anything runs them */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'pasabot-w18-'));
  const bin = join(root, 'bin');
  const apps = join(root, 'Applications');
  const home = join(root, 'home');
  for (const d of [bin, apps, home]) mkdirSync(d, { recursive: true });
  const marker = join(root, 'ran');
  for (const name of ['uvx', 'docker']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        notes: { command: process.execPath, args: [ECHO], env: { NOTES_API_KEY: SECRET } },
        keyed: { command: 'node', args: ['server.js', `--api-key=${SECRET}`] },
        // no keys: one tap; its tile is the GitHub mark (its own name), not the Claude app's
        github: { command: process.execPath, args: [ECHO] },
        // a shell is never brought over, whatever it is called
        sneaky: { command: 'sh', args: ['-c', 'echo hi'] },
      },
    }),
  );
  return {
    root,
    marker,
    env: {
      PASABOT_CONNECTORS_PATH: bin,
      PASABOT_CONNECTORS_APPS: apps,
      PASABOT_CONNECTORS_SCAN_HOME: home,
    },
  };
}

const test = base.extend<{ m: ReturnType<typeof machine>; server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  m: async ({}, use) => {
    const m = machine();
    await use(m);
    rmSync(m.root, { recursive: true, force: true });
  },
  server: async ({ m }, use) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...m.env },
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
    });
    await use(JSON.parse(line) as E2EServer);
    child.stdin?.end();
    child.kill('SIGTERM');
  },
});

async function claim(page: Page, server: E2EServer) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
}

async function layoutOk(page: Page, testId: string) {
  await expect(page.getByTestId(testId)).toBeVisible();
  const o = await page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`)!;
    const phone = window.innerWidth <= 600;
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...root.querySelectorAll('*')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return (
            [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
            s.display !== 'none' &&
            Number.parseFloat(s.fontSize) < 12
          );
        })
        .map((el) => el.textContent?.slice(0, 30)),
      smallTaps: phone
        ? [...root.querySelectorAll('button, select, input, a')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height < 44)
            .map(({ el, r }) => `${el.tagName}:${el.textContent?.slice(0, 20)}:${Math.round(r.height)}`)
        : [],
    };
  }, testId);
  expect(o.doc, `horizontal overflow at ${o.vw}px`).toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toEqual([]);
  expect(o.smallTaps, 'tap targets under 44px').toEqual([]);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(repoRoot, '.qa', `w18-conn-${name}.png`), fullPage: true });

for (const lng of ['en', 'fil'] as const) {
  test(`connectors (${lng}): four plain states, one-tap Add, key-only form, found on this computer`, async ({
    page,
    server,
    m,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'covers 1200 and 390 px itself');
    const t = strings(lng);
    await page.setViewportSize({ width: 1200, height: 800 });
    await claim(page, server);
    if (lng !== 'en') {
      await page.goto(`${server.url}/#/settings/look/language`);
      await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
      await expect(page.locator('html')).toHaveAttribute('lang', lng);
    }
    await page.goto(`${server.url}/#/connectors`);
    const card = (slug: string) => page.locator(`[data-connector="${slug}"]`);
    const stateOf = (slug: string) => card(slug).getByTestId('connector-state');

    // one plain state per card, from the fake PATH: uvx and docker are here, npx is not
    await expect(stateOf('time')).toHaveText(t.state.ready);
    await expect(stateOf('git')).toHaveText(t.state.ready);
    await expect(stateOf('github')).toHaveText(t.state.needs_key);
    await expect(stateOf('google-calendar')).toHaveText(t.state.needs_key);
    await expect(stateOf('filesystem')).toHaveText(t.state.missing);
    for (const slug of ['time', 'git', 'github', 'filesystem'])
      await expect(card(slug).getByTestId('connector-state')).toHaveCount(1);
    const missing = card('filesystem').getByTestId('connector-missing');
    await expect(missing).toContainText(fill(t.missing.line, { name: 'Node.js' }));
    // not on this computer: "Get Node.js" is the main action; Add asks first
    await expect(card('filesystem').getByTestId('connector-get')).toHaveText(
      fill(t.missing.get, { name: 'Node.js' }),
    );
    await expect(card('filesystem').getByTestId('connector-get')).toHaveAttribute(
      'href',
      'https://nodejs.org/',
    );
    await expect(card('filesystem').getByTestId('connector-get')).toHaveClass(/bk-btn--primary/);
    await card('filesystem')
      .getByRole('button', { name: fill(t.catalog.install, { name: 'Files in a folder' }) })
      .click();
    const ask = card('filesystem').getByTestId('connector-missing-ask');
    await expect(ask).toContainText(fill(t.missing.ask, { name: 'Node.js' }));
    await expect(card('filesystem').getByTestId('connector-install-form')).toHaveCount(0);
    await ask.getByRole('button', { name: t.install.cancel }).click();
    await expect(ask).toHaveCount(0);
    // Technical words off: no MCP, tool server or command words on the page
    await expect(page.getByTestId('connectors-page')).toContainText(t.page.intro);
    await expect(page.getByTestId('connectors-page')).not.toContainText(/MCP|stdio/);
    // a plain line, not the catalogue summary
    await expect(card('time')).toContainText(t.describe.time);
    // the words: Add, never Install or Download
    await expect(
      page.getByTestId('connectors-page').getByRole('button', { name: /install|download/i }),
    ).toHaveCount(0);
    // W36 sections: Popular on top, Found on this computer, then one section per thing people do
    await expect(
      page.getByTestId('connectors-popular').locator('[data-connector="google-calendar"]'),
    ).toBeVisible();
    await expect(
      page.getByTestId('connectors-popular').getByRole('heading', { name: t.groups.popular }),
    ).toBeVisible();
    await expect(
      page.getByTestId('connectors-group-other').getByRole('heading', { name: t.groups.other }),
    ).toBeVisible();
    await expect(
      page.getByTestId('connectors-found').getByRole('heading', { name: t.found.title }),
    ).toBeVisible();
    await expect(
      page.getByTestId('connectors-add-more').locator('[data-connector="filesystem"]'),
    ).toBeVisible();
    // found by name only; the one with a key in its command line is left to the owner
    await expect(page.locator('[data-found="claude:notes"]')).toBeVisible();
    await expect(page.locator('[data-found="claude:keyed"]').getByTestId('found-by-hand')).toBeVisible();
    await expect(page.locator('[data-found="claude:sneaky"]').getByTestId('found-by-hand')).toBeVisible();
    // a found server's tile is its own mark (or the tool-server glyph), never the app it was found in
    await expect(page.locator('[data-found="claude:github"] .bk-brand-tile')).toHaveAttribute(
      'data-mark',
      'github',
    );
    await expect(page.locator('[data-found="claude:notes"] .bk-brand-tile')).toHaveAttribute(
      'data-mark',
      'mcp-server',
    );
    await shot(page, `${lng}-1200-states`);

    // a key is asked for alone, in a password field; Cancel closes it
    await expect(card('github').getByTestId('connector-action')).toHaveText(t.button.code);
    await card('github').getByTestId('connector-action').click();
    const form = card('github').getByTestId('connector-install-form');
    await expect(form.locator('input')).toHaveCount(1);
    await expect(form.locator('input')).toHaveAttribute('type', 'password');
    await shot(page, `${lng}-1200-key-form`);
    await form.getByRole('button', { name: t.install.cancel }).click();
    await expect(form).toHaveCount(0);

    // Ready to add with nothing to type: one tap on Add, no form in between
    await expect(card('time').getByTestId('connector-action')).toHaveText(t.button.add);
    await card('time').getByTestId('connector-action').click();
    const added = page.locator('[data-connector-install="time"]');
    await expect(added.locator('[data-install-status="ready"]')).toHaveText(t.status.ready);
    await expect(page.getByTestId('connector-install-form')).toHaveCount(0);
    await expect(card('time')).toHaveCount(0); // it shows once, under Connected
    await expect(
      page.getByTestId('connectors-connected').getByRole('heading', { name: t.installed.title }),
    ).toBeVisible();

    // found on this computer with no keys: one tap on Add, nothing in between
    await page
      .locator('[data-found="claude:github"]')
      .getByRole('button', { name: fill(t.catalog.install, { name: 'github' }) })
      .click();
    const gh = page.locator('[data-connector-install="found:claude:github"]');
    await expect(gh.locator('[data-install-status="ready"]')).toHaveText(t.status.ready);
    await expect(gh.locator('.bk-brand-tile')).toHaveAttribute('data-mark', 'github');
    await expect(gh.getByTestId('installed-use-hint')).toContainText(t.installed.foundHint);
    await expect(gh.getByRole('link', { name: t.plain.installed.appsLink })).toBeVisible();

    // with keys: one plain question (copy them into the vault?), no key names; the key never reaches the page
    const notes = page.locator('[data-found="claude:notes"]');
    await notes.getByRole('button', { name: fill(t.catalog.install, { name: 'notes' }) }).click();
    const proposal = notes.getByTestId('found-proposal');
    await expect(proposal).toContainText(t.plain.found.keysAsk);
    await expect(proposal).not.toContainText('NOTES_API_KEY');
    await shot(page, `${lng}-1200-found-proposal`);
    await proposal.getByRole('button', { name: t.found.confirm }).click();
    const imported = page.locator('[data-connector-install="found:claude:notes"]');
    await expect(imported.locator('[data-install-status="ready"]')).toHaveText(t.status.ready);
    await expect(imported).not.toContainText('NOTES_API_KEY');
    await expect(page.locator('[data-found="claude:notes"]')).toHaveCount(0);
    expect(await page.content()).not.toContain(SECRET);
    await layoutOk(page, 'connectors-page');
    await shot(page, `${lng}-1200-added`);

    // the same page on a phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(stateOf('filesystem')).toHaveText(t.state.missing);
    await layoutOk(page, 'connectors-page');
    await shot(page, `${lng}-390`);

    // the imported server is an MCP server with a placeholder where its key was
    const servers = await page.evaluate(async () => (await fetch('/api/m/mcp/servers')).text());
    expect(servers).toContain('"notes"');
    expect(servers).not.toContain(SECRET);
    // added switched off: agents cannot start it until the owner turns it on
    const list = (JSON.parse(servers) as { servers: { name: string; enabled: boolean }[] }).servers;
    expect(list.find((x) => x.name === 'notes')!.enabled).toBe(false);
    expect(list.find((x) => x.name === 'github')!.enabled).toBe(false);
    // nothing was ever run to find out what is on this computer
    expect(existsSync(m.marker)).toBe(false);
  });
}
