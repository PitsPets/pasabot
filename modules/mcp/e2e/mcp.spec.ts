/**
 * W13 in the browser, at 1440 and 390 px: the owner installs the GitHub connector (token write-only) and sees it
 * become an MCP server; adds a local stdio MCP server, tests it, turns it on and lets Tala use it; Tala (Fake
 * brain) finds the tool with `tools_find` and invokes it; a hidden agent finds nothing. No horizontal scroll, no
 * text under 12 px, 44 px tap targets on the phone.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type E2EServer = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const ECHO = fileURLToPath(new URL('../src/__fixtures__/echo-mcp.mjs', import.meta.url));

/** W18: connector detection looks at a fake PATH with `docker` (GitHub then only needs its token), never this machine's */
const fakeMachine = () => {
  const root = mkdtempSync(join(tmpdir(), 'pasabot-mcp-e2e-'));
  writeFileSync(join(root, 'docker'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(root, 'docker'), 0o755);
  return { PASABOT_CONNECTORS_PATH: root, PASABOT_CONNECTORS_APPS: '', PASABOT_CONNECTORS_SCAN_HOME: root };
};

const test = base.extend<{ server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...fakeMachine() },
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

const PASSWORD = 'correct horse battery';
const probe = (name: string, args: unknown) => JSON.stringify({ probe: { name, args } });

async function claim(page: Page, server: E2EServer) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
}
async function createAgent(page: Page, name: string) {
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Helps with the shop.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}

async function layoutOk(page: Page, testId: string) {
  await expect(page.getByTestId(testId)).toBeVisible();
  const o = await page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`)!;
    const phone = window.innerWidth <= 600;
    return {
      doc: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      tiny: [...root.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return (
          [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
          s.display !== 'none' &&
          Number.parseFloat(s.fontSize) < 12
        );
      }).length,
      smallTaps: phone
        ? [...root.querySelectorAll('button, select, input, a')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height < 44)
            .map(({ el, r }) => `${el.tagName}:${el.textContent?.slice(0, 20)}:${Math.round(r.height)}`)
        : [],
    };
  }, testId);
  expect(o.doc, `horizontal overflow at ${o.vw}px`).toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
  expect(o.smallTaps, 'tap targets under 44px').toEqual([]);
}

test('connectors + MCP servers: install GitHub, add a stdio server, grant Tala, Tala finds and uses the tool', async ({
  page,
  server,
}, info) => {
  await claim(page, server);
  await createAgent(page, 'Tala');
  const talaChat = page.url();
  await page.goto(`${server.url}/#/agents/new`);
  await createAgent(page, 'Ligaya');
  const ligayaChat = page.url();

  // the catalogue: GitHub with a write-only token
  await page.goto(`${server.url}/#/connectors`);
  const gh = page.locator('[data-connector="github"]');
  await expect(gh.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible();
  // a search narrows the list; the catalogue sits in sections of what people do (GitHub under "Other"), with the
  // custom tool server link at its end
  await expect(
    page.getByTestId('connectors-group-other').getByRole('heading', { name: 'Other' }),
  ).toBeVisible();
  await expect(page.getByTestId('connectors-custom')).toHaveAttribute('href', '#/mcp');
  await page.getByTestId('connectors-search').fill('calendar');
  await expect(gh).toHaveCount(0);
  await expect(page.locator('[data-connector="google-calendar"]')).toBeVisible();
  await page.getByTestId('connectors-search').fill('');
  // the owner's wording: a connector is added, never installed or downloaded
  await expect(gh.getByRole('button', { name: /install|download/i })).toHaveCount(0);
  await expect(gh.getByTestId('connector-state')).toHaveText('Needs sign-in or key');
  await expect(gh.getByTestId('connector-action')).toHaveText('Needs a code');
  await gh.getByTestId('connector-action').click();
  const token = gh.getByLabel('Personal access token');
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('ghp_e2eFakeToken000');
  await gh.getByRole('button', { name: 'Add', exact: true }).click();
  const installed = page.locator('[data-connector-install="github"]');
  await expect(installed.locator('[data-install-status="ready"]')).toBeVisible();
  await expect(page.getByText('ghp_e2eFakeToken000')).toHaveCount(0);
  await layoutOk(page, 'connectors-page');

  // MCP servers: the connector is there; add a local stdio server, test it, turn it on, let Tala use it
  // Technical words off: no MCP words or key names on the Connectors page, the plain link instead
  await expect(installed).not.toContainText(/MCP|GITHUB_PERSONAL_ACCESS_TOKEN/);
  await installed.getByRole('link', { name: 'Apps and tools helpers can use' }).click();
  await expect(page.locator('[data-mcp-server="github"]')).toBeVisible();
  await page.getByRole('button', { name: 'Add an app or tool' }).click();
  const form = page.getByTestId('mcp-add-form');
  await form.getByLabel('Name').first().fill('Echo');
  // R7 review: the form asks in plain words; the program name and the shell are technical-words talk only
  await expect(form).not.toContainText(/\bCommand\b|Arguments|npx|docker|shell/);
  await form.getByLabel('How to open it', { exact: true }).fill(process.execPath);
  await form.getByLabel('Extra details').fill(ECHO);
  await form.getByRole('button', { name: 'Add it' }).click();
  const echo = page.locator('[data-mcp-server="echo"]');
  await expect(echo).toBeVisible();
  // and no command line or transport on the card while Technical words is off
  await expect(echo).not.toContainText(ECHO);
  await expect(echo).not.toContainText('Command on this machine');
  await expect(echo).not.toContainText('A program on this computer');
  await echo.getByRole('button', { name: 'Test' }).click();
  await expect(echo.locator('[data-mcp-test="ok"]')).toHaveText('3 tools');
  await echo.getByRole('button', { name: 'Turn on' }).click();
  await expect(echo.getByText('On', { exact: true })).toBeVisible();
  await echo.getByTestId('mcp-level-echo-Tala').selectOption('use');
  await expect(echo.getByTestId('mcp-level-echo-Tala')).toHaveValue('use');
  await layoutOk(page, 'mcp-page');

  // Tala (Fake brain) finds the tool through the gateway meta-tool and invokes it
  await page.goto(talaChat);
  await send(page, probe('tools_find', { query: 'echo' }));
  const found = page.getByTestId('msg-agent').filter({ hasText: 'tool said' }).first();
  await expect(found).toContainText('echo/echo_text');
  await send(page, probe('tools_invoke', { tool: 'echo/echo_text', arguments: { text: 'mabuhay' } }));
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'MABUHAY' })).toHaveCount(1);

  // Ligaya was never granted: the server is hidden from her
  await page.goto(ligayaChat);
  await send(page, probe('tools_find', { query: 'echo' }));
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'tool said' }).first()).toContainText(
    '"tools":[]',
  );

  // the same screens on the other viewport of this project
  await page.setViewportSize(
    info.project.name === 'phone' ? { width: 1440, height: 900 } : { width: 390, height: 844 },
  );
  await page.goto(`${server.url}/#/mcp`);
  await layoutOk(page, 'mcp-page');
  await page.goto(`${server.url}/#/connectors`);
  await layoutOk(page, 'connectors-page');
});
