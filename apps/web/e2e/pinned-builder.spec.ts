/**
 * The main helper (the built-in team builder) is pinned at the top of the chat list (owner ask), at 1440 px and
 * 390 px, in English and Filipino: first whatever the activity order (a helper just answered) and first while a search
 * is typed, with a small pin mark read out as "Pinned" / "Naka-pin"; nothing on the row unpins it. Screenshots go to
 * `.qa/w23-pin-*.png`.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { skipTeamSetup, startTeamSetup } from '../../../packages/testkit/src/e2e.js';
import { expect, PASSWORD, send, test } from './fixtures.js';

const QA = fileURLToPath(new URL('../../../.qa/', import.meta.url));
const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );
const HELPERS = ['Ligaya', 'Dalisay', 'Amihan', 'Bayani', 'Diwata', 'Malaya'];
const PINNED = { en: 'Pinned', fil: 'Naka-pin' } as const;

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
});

for (const lng of ['en', 'fil'] as const)
  test.describe(`pinned team builder (${lng})`, () => {
    test.use({ locale: lng === 'fil' ? 'fil-PH' : 'en-US' });
    test(`${lng}: the team builder stays first, with a pin mark, after activity and in a search`, async ({
      page,
      server,
    }, info) => {
      const phone = info.project.name === 'phone';
      const w = phone ? '390' : '1440';
      const shot = async (name: string) => {
        mkdirSync(QA, { recursive: true });
        await page.screenshot({ path: `${QA}w23-pin-${name}-${w}-${lng}.png` });
      };
      await page.goto(server.setupLink);
      await page.locator('input[autocomplete="name"]').fill('Liza');
      await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
      await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
      await page.locator('form button[type="submit"]').click();
      await startTeamSetup(page);
      await skipTeamSetup(page);

      // six more helpers, each with its own chat (all newer than the team builder's chat)
      const made = await page.evaluate(async (names) => {
        const out: string[] = [];
        for (const name of names) {
          const r = await fetch('/api/v1/agents', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, providerId: 'fake' }),
          });
          out.push(((await r.json()) as { chatId: string }).chatId);
        }
        return out;
      }, HELPERS);
      // the newest activity: the last helper answers
      await page.goto(`${server.url}/#/chats/${made.at(-1)}`);
      await page.reload();
      await send(page, 'kumusta');
      await expect(page.getByTestId('msg-agent').last()).toContainText('echo: kumusta');

      if (phone) await page.goto(`${server.url}/#/`);
      const list = page.locator('[data-testid="chats-list"]:visible');
      const rows = list.getByTestId('roster-agent');
      await expect(rows).toHaveCount(7);
      const first = rows.first();
      await expect(first).toContainText('Tala');
      await expect(first).toHaveAttribute('data-pinned', 'true');
      // the pin mark: one, on the team builder's row only, with an accessible name
      const mark = first.getByRole('img', { name: PINNED[lng], exact: true });
      await expect(mark).toBeVisible();
      await expect(list.getByRole('img', { name: PINNED[lng], exact: true })).toHaveCount(1);
      await expect(first).toHaveAccessibleName(new RegExp(PINNED[lng]));
      // the helper that just answered is right under it (activity order for everyone else)
      await expect(rows.nth(1)).toContainText(HELPERS.at(-1)!);
      // nothing on the row unpins it: a plain link, no menu or button inside
      await expect(first.locator('button, [role="menu"]')).toHaveCount(0);
      const box = (await first.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await noSideScroll(page)).toBe(true);
      await shot('list');

      // a search keeps it first (it matches "a" like most of the helpers)
      const search = list.getByRole('searchbox');
      await search.fill('a');
      await expect(rows.first()).toContainText('Tala');
      await expect(rows.first()).toHaveAttribute('data-pinned', 'true');
      await expect(rows.nth(1)).toContainText(HELPERS.at(-1)!);
      expect(await noSideScroll(page)).toBe(true);
      await shot('search');
      // a search that does not match it simply hides it; clearing brings it back first
      await search.fill('Ligaya');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).not.toHaveAttribute('data-pinned', 'true');
      await search.fill('');
      await expect(rows.first()).toContainText('Tala');

      // still first after a reload
      await page.reload();
      await expect(
        page.locator('[data-testid="chats-list"]:visible').getByTestId('roster-agent').first(),
      ).toHaveAttribute('data-pinned', 'true');
    });
  });
