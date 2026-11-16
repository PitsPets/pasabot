/**
 * W24 languages: a browser set to ja / ar / de opens in that language, the picker overrides it and is remembered,
 * the unreviewed marker shows, Arabic mirrors the layout, and long German words never cause a sideways scroll.
 * Each case runs at 1440 px and 390 px (once, in the desktop project).
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, send, test } from './fixtures.js';

const web = (lng: string) =>
  JSON.parse(readFileSync(new URL(`../locales/${lng}.json`, import.meta.url), 'utf8')) as {
    setup: { title: string };
    settings: { title: string; language: string };
    lang: { helpImprove: string };
  };

const noSideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );

/** the smallest font size of any visible element that holds text */
const smallestText = (page: Page) =>
  page.evaluate(() => {
    let min = 99;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!own || !el.offsetParent) continue;
      min = Math.min(min, Number.parseFloat(getComputedStyle(el).fontSize));
    }
    return min;
  });

const CASES = [
  { lng: 'ja', browser: 'ja-JP', dir: 'ltr' },
  { lng: 'ar', browser: 'ar-EG', dir: 'rtl' },
  { lng: 'de', browser: 'de-DE', dir: 'ltr' },
] as const;
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

for (const c of CASES)
  for (const size of WIDTHS)
    test(`${c.lng} at ${size.width} px: browser language, picker, marker, layout`, async ({
      browser,
      server,
    }, info) => {
      test.skip(info.project.name !== 'desktop', 'runs both widths itself');
      const ctx = await browser.newContext({ locale: c.browser, viewport: size, hasTouch: size.width < 600 });
      const page = await ctx.newPage();
      const shot = (name: string) =>
        page.screenshot({ path: info.outputPath(`${c.lng}-${size.width}-${name}.png`), fullPage: true });
      const t = web(c.lng);

      // 1. the browser's language decides the first screen
      await page.goto(server.setupLink);
      await expect(page.locator('html')).toHaveAttribute('lang', c.lng);
      await expect(page.locator('html')).toHaveAttribute('dir', c.dir);
      await expect(page.getByRole('heading', { name: t.setup.title })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
      await shot('setup');

      // 2. the picker overrides it (English to claim the server with the shared helpers)
      await page.locator('[data-testid="lang-select"]:visible').first().selectOption('en');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await claimServer(page, server);
      await createFakeAgent(page, 'Tala');
      await send(page, 'Gumagana ba?');
      await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-status', 'final');
      const chatUrl = page.url();

      // 3. Settings: pick the language; it shows its own name, the unreviewed marker and a help link
      await page.goto(`${server.url}/#/settings/look/language`);
      const picker = page.locator('.lang-pick--detail [data-testid="lang-select"]');
      await expect(picker.locator(`option[value="${c.lng}"]`)).toHaveAttribute('lang', c.lng);
      await picker.selectOption(c.lng);
      await expect(page.locator('html')).toHaveAttribute('lang', c.lng);
      await expect(page.locator('html')).toHaveAttribute('dir', c.dir);
      await expect(page.getByRole('heading', { name: t.settings.language, level: 1 })).toBeVisible();
      const note = page.getByTestId('lang-unreviewed');
      await expect(note).toBeVisible();
      await expect(note.getByRole('link', { name: t.lang.helpImprove })).toHaveAttribute(
        'href',
        /CONTRIBUTING/,
      );
      expect(await noSideScroll(page)).toBe(true);
      expect(await smallestText(page)).toBeGreaterThanOrEqual(12);
      await shot('settings');

      // 4. remembered after a reload
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', c.lng);
      await expect(page.getByRole('heading', { name: t.settings.language, level: 1 })).toBeVisible();

      // 5. the chat: bubbles sit on the mirrored sides in Arabic, nothing scrolls sideways
      await page.goto(chatUrl);
      await expect(page.getByTestId('msg-agent').last().locator('.bub')).toBeVisible();
      await expect(page.getByTestId('msg-me').last().locator('.me')).toBeVisible();
      const log = await page.getByTestId('chat-log').boundingBox();
      const me = await page.getByTestId('msg-me').last().locator('.me').boundingBox();
      const avatar = await page.getByTestId('msg-agent').last().locator('.bub').boundingBox();
      expect(log && me && avatar).toBeTruthy();
      const mid = log!.x + log!.width / 2;
      const centre = (b: { x: number; width: number }) => b.x + b.width / 2;
      // own bubble at the inline end, the agent's bubble at the inline start: right/left in LTR, mirrored in RTL
      if (c.dir === 'rtl') {
        expect(centre(me!)).toBeLessThan(mid);
        expect(centre(avatar!)).toBeGreaterThan(mid);
      } else {
        expect(centre(me!)).toBeGreaterThan(mid);
        expect(centre(avatar!)).toBeLessThan(mid);
      }
      expect(await noSideScroll(page)).toBe(true);
      await shot('chat');

      // 6. the other main screens at this width
      for (const path of ['#/agents/new', '#/devices', '#/menu', '#/welcome']) {
        await page.goto(`${server.url}/${path}`);
        await page.waitForLoadState('networkidle');
        expect(await noSideScroll(page), path).toBe(true);
      }
      await shot('welcome');
      await ctx.close();
    });

test('the Brain picker names the test brain in the app language, never in English (ja, ar, hi)', async ({
  page,
  server,
}, info) => {
  test.skip(info.project.name === 'phone', 'one run is enough');
  await claimServer(page, server);
  const core = (lng: string) =>
    JSON.parse(
      readFileSync(new URL(`../../../packages/i18n/locales/${lng}.json`, import.meta.url), 'utf8'),
    ) as {
      provider: { fakeName: string };
    };
  for (const lng of ['ja', 'ar', 'hi']) {
    await page.goto(`${server.url}/#/settings/look/language`);
    await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
    await expect(page.locator('html')).toHaveAttribute('lang', lng);
    await page.goto(`${server.url}/#/agents/new`);
    const fake = page.getByTestId('brain-option-fake').locator('.brain-card__name');
    await expect(fake).toHaveText(core(lng).provider.fakeName);
    await expect(fake).not.toHaveText(/Fake|tests/);
  }
});
