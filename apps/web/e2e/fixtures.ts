import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import {
  claimWithLink,
  openMoreOptions,
  pickBrain,
  skipOnboarding,
} from '../../../packages/testkit/src/e2e.js';

export interface E2EServer {
  url: string;
  /** same server on `localhost` (WebAuthn needs a domain, not an IP) */
  localUrl: string;
  setupLink: string;
  /** loopback control port of the FakeChannel platform (e2e/server.ts) */
  channelControl: string;
}

const webRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Starts one e2e server. Each server leads its own process group (`detached`), so a signal sent to the test
 * runner's group (Ctrl-C, a group kill from another process) never takes down every live server at once, and
 * `stop` ends the server and anything it started (browser, MCP children) as one group. A server that dies says how.
 */
export async function boot(
  env: Record<string, string> = {},
): Promise<{ server: E2EServer; child: ChildProcess }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
    cwd: webRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
    detached: true,
  });
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once('line', resolve);
    child.once('exit', (code, signal) =>
      reject(new Error(`e2e server exited while starting (code ${code}, signal ${signal})`)),
    );
  });
  const j = JSON.parse(line) as { url: string; setupLink: string; channelControl: string };
  return {
    server: {
      url: j.url,
      localUrl: j.url.replace('127.0.0.1', 'localhost'),
      setupLink: j.setupLink,
      channelControl: j.channelControl,
    },
    child,
  };
}

/** Stops a server from `boot` and waits until it is gone (SIGKILL to its group after the grace). */
export async function stop(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((r) => child.once('exit', () => r()));
  const group = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  child.stdin?.end();
  group('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([gone, new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    group('SIGKILL');
    await gone;
  }
}

export const test = base.extend<{ server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const { server, child } = await boot();
    await use(server);
    // waited for: the next test's server never boots while this one is still shutting down
    await stop(child);
  },
});
export { expect };

export const PASSWORD = 'correct horse battery';

/** Every Settings group, in the order the owner sees them (polish B 3: all 12, always, in three sections). */
export const SETTINGS_GROUPS = [
  'agents',
  'safety',
  'people',
  'look',
  'tools',
  'inbox',
  'shopping',
  'memory',
  'automations',
  'spending',
  'machines',
  'advanced',
] as const;

/** The owner's Settings home lists exactly the 12 groups, each by its own row, in order. */
export async function expectAllSettingsGroups(home: import('@playwright/test').Locator) {
  await expect(home.locator('.bk-row')).toHaveCount(SETTINGS_GROUPS.length);
  for (const g of SETTINGS_GROUPS) await expect(home.getByTestId(`settings-group-${g}`)).toHaveCount(1);
  const order = await home
    .locator('[data-testid^="settings-group-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('settings-group-'.length)));
  expect(order).toEqual([...SETTINGS_GROUPS]);
}

/**
 * Setup link -> owner account -> the first-run step 1 shows -> straight to the full new-agent form (specs make their
 * own agents; `first-timer.spec.ts` walks the two first-run steps themselves).
 */
export async function claimServer(page: Page, server: E2EServer, base = server.url) {
  // first run says in one line that agents ask before dangerous things; the full note (the permissive default for
  // new agents and how to make it stricter) is one tap away
  await page.goto(server.setupLink.replace(server.url, base));
  await page.getByTestId('trust-how').click();
  await expect(page.getByTestId('trust-warning')).toContainText('New agents start at Trusted');
  // the link carries the setup code: no "Setup code" field (claimWithLink throws if there is one)
  await claimWithLink(page, server.setupLink.replace(server.url, base), 'Diwa', PASSWORD);
  await skipOnboarding(page);
  await expect(page.getByRole('heading', { name: 'New helper' })).toBeVisible();
}

/**
 * On the new-agent form: create a Fake agent and land in its chat. New agents start at `trusted` (tier 2 runs
 * without asking); specs about approval cards pass `standard`.
 */
export async function createFakeAgent(
  page: Page,
  name = 'Tala',
  trust: 'guarded' | 'standard' | 'trusted' = 'trusted',
) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('What should it help with?').fill('Handles purchasing. Asks before ordering.');
  await pickBrain(page, 'fake');
  // the trust level and the computer-commands switch sit under the closed "More options"
  await openMoreOptions(page);
  const level = page.getByLabel('How often it asks you');
  await expect(level).toHaveValue('trusted');
  await expect(page.getByTestId('trust-warning')).toBeVisible();
  // "Ask before terminal and raw web commands" follows the level until the owner sets it: off at trusted, on below
  await expect(page.getByTestId('ask-shell-web')).not.toBeChecked();
  if (trust !== 'trusted') {
    await level.selectOption(trust);
    await expect(page.getByTestId('trust-warning')).toHaveCount(0);
    await expect(page.getByTestId('ask-shell-web')).toBeChecked();
  }
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}

export async function send(page: Page, text: string) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Enter');
}

type Step = Record<string, unknown>;
/** A FakeProvider script sent as the message text (`{"fakeScript": [...]}`). */
export const script = (steps: Step[]) => JSON.stringify({ fakeScript: steps });
export const delta = (text: string, after = 0): Step => ({ after, event: { type: 'text.delta', text } });
export const final = (text: string): Step => ({ event: { type: 'text.final', text } });
export const done: Step = { event: { type: 'done', stop: 'end' } };
