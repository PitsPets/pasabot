import { expectQuiet } from '../../../packages/testkit/src/e2e.js';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

/**
 * Every page goes quiet once it has loaded: its loaders run once (plus at most a slow refresh tick), never in a loop
 * driven by a translate function or object made anew on every render. Such a loop sent about 100k requests in
 * 140 s from Settings → Machines and pinned the browser and the server.
 */
type Pg = import('@playwright/test').Page;
const PAGES: { name: string; hash: string; ready: string; act?: (page: Pg) => Promise<void> }[] = [
  { name: 'Settings home', hash: '#/settings', ready: 'settings-home-groups' },
  { name: 'inbox', hash: '#/inbox', ready: 'inbox-page' },
  {
    name: 'search',
    hash: '#/search',
    ready: 'search-page',
    // the search runs on what is typed: a typed query is searched once, not again on every render
    act: (page) => page.getByTestId('search-page').locator('input').first().fill('lapis'),
  },
  { name: 'voice settings', hash: '#/settings/look/voice', ready: '' },
  { name: 'computer', hash: '#/computer', ready: 'computer-page' },
];

test('each page goes quiet once loaded', async ({ page, server }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough: the loop is not layout-bound');
  test.setTimeout(90_000);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const chat = page.url();
  const counts: Record<string, number> = {};
  const loud: string[] = [];
  const measure = async (name: string) => {
    // the first loads settle, then the page idles
    await page.waitForTimeout(1_500);
    try {
      counts[name] = await expectQuiet(page, { label: name });
    } catch (e) {
      loud.push((e as Error).message);
    }
  };
  // the chat page first (the composer's voice buttons and the message footers live here)
  await measure('chat');
  for (const p of PAGES) {
    await page.goto(chat.replace(/#.*$/, p.hash));
    if (p.ready) await expect(page.getByTestId(p.ready)).toBeVisible();
    await p.act?.(page);
    await measure(p.name);
  }
  console.log(`quiet counts: ${JSON.stringify(counts)}`);
  // every page is measured before failing, so one run names every loud page
  expect(loud).toEqual([]);
});
