/**
 * The real-Chromium tests need Playwright's Chromium headless shell, which `pnpm install` does not download (a
 * developer machine usually has it in its Playwright cache; a fresh CI runner does not). Called first in a test file's
 * beforeAll: when the browser is missing or cannot start, every test of the file fails with this one plain message
 * instead of each failing on a different assertion. It starts the browser without its sandbox, so a sandbox that
 * cannot start is still reported by the tests that ask for it.
 */
import { chromium } from 'playwright-core';

export async function requireChromium(): Promise<void> {
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    throw new Error(
      `Playwright's Chromium headless shell cannot start (${first}). Install it once with: ` +
        'npx pnpm@12.18.0 --filter @pasabot/mod-browser exec playwright-core install --only-shell chromium ' +
        '(on Linux add --with-deps for its system libraries)',
    );
  }
}
