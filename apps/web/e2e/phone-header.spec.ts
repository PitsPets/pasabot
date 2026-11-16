/**
 * The phone headers with a decision waiting, at 390 and 360 px, in English and the longest locales (German,
 * Filipino, Arabic, Japanese, Hindi, Brazilian Portuguese). Home (the chats list): brand, the "N need you" pill
 * (hand icon + number, its full words for screen readers), Stop all as one 44 px icon button and the account button
 * (whose dot says the connection, named in its tooltip). A chat: Back, who, the pill, Stop all and More, so Stop all
 * stays one tap away. Nothing wraps or overlaps and the page never scrolls sideways; on the narrowest phones the
 * wordmark gives way to the logo mark, which stays a named 44 px link.
 */
import type { Locator, Page } from '@playwright/test';
import { claimServer, createFakeAgent, done, expect, final, script, send, test } from './fixtures.js';

const LOCALES = (process.env.PHONE_HEADER_LOCALES ?? 'en,de,fil,ar,ja,hi,pt-BR').split(',');

async function oneRow(page: Page, top: Locator, where: string, width: number) {
  const rows = await top.evaluate((el) =>
    [...el.children]
      .filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, right: r.right, h: r.height };
      }),
  );
  for (const r of rows) expect(r.h, `${where}: a header item wraps`).toBeLessThanOrEqual(48);
  const mid = rows.map((r) => (r.top + r.bottom) / 2);
  expect(Math.max(...mid) - Math.min(...mid), `${where}: header items on one row`).toBeLessThanOrEqual(4);
  expect(Math.max(...rows.map((r) => r.right)), `${where}: header overflows`).toBeLessThanOrEqual(
    width + 0.5,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function pillWhole(pill: Locator, where: string) {
  const p = await pill.evaluate((el) => ({
    text: el.textContent,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    ellipsis: getComputedStyle(el).textOverflow === 'ellipsis',
    box: el.getBoundingClientRect().toJSON() as DOMRect,
  }));
  expect(p.scrollWidth, `${where}: pill "${p.text}" is cut`).toBeLessThanOrEqual(p.clientWidth);
  expect(p.ellipsis, `${where}: pill ends in an ellipsis`).toBe(false);
  return p.box;
}

async function stopOk(stop: Locator, pillBox: DOMRect, where: string) {
  const s = (await stop.boundingBox())!;
  const overlap = !(pillBox.right <= s.x + 0.5 || s.x + s.width <= pillBox.left + 0.5);
  expect(overlap, `${where}: pill under Stop all`).toBe(false);
  expect(s.height, `${where}: Stop all height`).toBeGreaterThanOrEqual(44);
  expect(s.height, `${where}: Stop all wraps`).toBeLessThanOrEqual(48);
  expect(s.width, `${where}: Stop all width`).toBeGreaterThanOrEqual(44);
  await expect(stop).toHaveAccessibleName(/\S/);
}

test('phone headers fit with a pending decision at 390 and 360 px in en, de, fil, ar, ja, hi and pt-BR', async ({
  page,
  server,
}, info) => {
  test.skip(info.project.name === 'phone', 'this test sets its own phone widths');
  test.setTimeout(180_000);
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala', 'standard');
  const chat = page.url();
  await send(
    page,
    script([
      { expectPermission: { tool: 'Bash', input: { command: 'touch a.txt' }, decision: 'allow' } },
      final('ok'),
      done,
    ]),
  );
  await expect(page.getByTestId('approval-card')).toBeVisible();
  for (const lng of LOCALES) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${server.url}/#/settings/look/language`);
    await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
    await expect(page.locator('html')).toHaveAttribute('lang', lng);
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      const where = `${lng} @ ${width}px`;

      // home: brand, pill, Stop all, account
      await page.goto(`${server.url}/#/`);
      const home = page.locator('.ptop');
      await expect(home.getByTestId('count-needs')).toBeVisible();
      const hp = await pillWhole(home.getByTestId('count-needs'), `${where} home`);
      await stopOk(home.getByTestId('stop-all'), hp, `${where} home`);
      const acc = home.getByTestId('account-menu');
      await expect(acc).toHaveAccessibleName(/\S/);
      await expect(acc).toHaveAttribute('title', /\S/);
      await expect(home.getByTestId('conn')).toHaveAttribute('data-state', 'live');
      const a = (await acc.boundingBox())!;
      expect(a.width, `${where}: account button`).toBeGreaterThanOrEqual(44);
      const brand = home.locator('.brand');
      const b = (await brand.boundingBox())!;
      expect(b.height, `${where}: brand height`).toBeGreaterThanOrEqual(44);
      expect(b.width, `${where}: brand width`).toBeGreaterThanOrEqual(44);
      await expect(brand).toHaveAccessibleName('PasaBot');
      const word = await brand.evaluate((el) => {
        const w = el.querySelector('b')!;
        const r = w.getBoundingClientRect();
        return { shown: r.width > 2, cut: el.scrollWidth > el.clientWidth + 0.5 };
      });
      if (word.shown) expect(word.cut, `${where}: wordmark is cut`).toBe(false);
      if (width >= 390) expect(word.shown, `${where}: wordmark shown`).toBe(true);
      await oneRow(page, home, `${where} home`, width);
      await page.screenshot({ path: info.outputPath(`phone-home-${lng}-${width}.png`) });

      // the chat: Back, who, pill, Stop all, More; Stop all is still one tap away
      await page.goto(chat);
      const top = page.locator('.ptop');
      await expect(top.getByTestId('stop-all')).toBeVisible();
      const cp = await pillWhole(top.getByTestId('count-needs'), `${where} chat`);
      await stopOk(top.getByTestId('stop-all'), cp, `${where} chat`);
      await expect(top.getByTestId('phone-chat-more-btn')).toHaveAccessibleName(/\S/);
      await expect(top.locator('.ptop-back')).toHaveAccessibleName(/\S/);
      await oneRow(page, top, `${where} chat`, width);
      await page.screenshot({ path: info.outputPath(`phone-header-${lng}-${width}.png`) });
    }
  }
});
