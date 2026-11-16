/**
 * W30, at 1440 px and 390 px: every page reachable from Settings speaks plain words while "Technical words" is off,
 * in English and Filipino. The routes are not a hand-kept list: they are read from the live catalog (core features +
 * every module's nav pages and settings sections), every group page's feature links with Technical words on (so
 * the expert-only pages are in the walk too). The walk fails when it finds no routes, when a route lands nowhere
 * (no Settings feature page), or when a page's visible text says a deny-listed word. With Technical words off the
 * expert-only pages say one plain line instead; with it on, the technical names are back. Screenshots:
 * `.qa/w30-<name>-<w>.png`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

// screenshots go to the repo's `.qa/` (or `PASABOT_QA_DIR`, e.g. the main checkout's from a worktree)
const QA = process.env.PASABOT_QA_DIR
  ? `${process.env.PASABOT_QA_DIR.replace(/\/$/, '')}/`
  : fileURLToPath(new URL('../../../.qa/', import.meta.url));
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
const technical = (page: Page, value: boolean) =>
  page.evaluate(
    (v) =>
      fetch('/api/v1/me/prefs/ui.advanced', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: v }),
      }),
    value,
  );
const shot = async (page: Page, name: string, w: string, prefix = 'w30') => {
  mkdirSync(QA, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${QA}${prefix}-${name}-${w}.png` });
};

/**
 * Words a first-timer never meets with Technical words off (English, and the English words a Filipino screen would
 * borrow): a helper is "helper" / "katulong", a model or provider is a "brain", a token or API key a "secret code".
 */
const DENY =
  /\b(MCP|ACP|skills?|tokens?|vault|API|APIs|providers?|agents?|ahente|connectors?|webhooks?|CLI|servers?|models?)\b/i;
/** mail protocol names (exact case: a mail address shown in full, `imap.example.com`, is not talk) in every language */
const DENY_CASED = /\b(IMAP|SMTP)\b/;
/** a Filipino screen calls a helper "katulong", never the borrowed English word */
const DENY_FIL = /\bhelpers?\b/i;
/**
 * brand and product names that carry one of those words and are not technical talk, and a web address shown in full
 * (where something is downloaded from is what the owner agrees to, so it is never reworded)
 */
const ALLOW = [
  /AgentChat/gi,
  /Google Gemini CLI/gi,
  /OpenCode CLI/gi,
  /\bhttps?:\/\/\S+/gi,
  // the Mac app's own name (what the owner looks for in System Settings)
  /PasaBot Screen Helper/g,
  // a catalog template's own name (catalog content is English in every language, it is not a locale string)
  /Research helper/g,
];
const offenders = (text: string, lng: 'en' | 'fil' = 'en') =>
  text
    .split('\n')
    .map((l) => ALLOW.reduce((s, re) => s.replace(re, ''), l))
    .filter((l) => DENY.test(l) || DENY_CASED.test(l) || (lng === 'fil' && DENY_FIL.test(l)));

/**
 * Module pages opened from Settings whose own strings have no plain wording yet (W30 follow-up, listed in the
 * report): the walk still opens them (a route that lands nowhere fails), records what they say in the test's
 * annotations, and fails once one of them is clean, so it leaves this list the day it is done.
 */
// every page opened from Settings speaks plain words now: ws/r7 made the module pages plain, ws/computer the
// computer-use page; a page that falls back to technical words fails the walk
const PENDING = new Set<string>([]);

/**
 * The page's primary button (the first one: "Add…", "New…"), pressed the way a first-timer would: what the dialog
 * or the form it opens says is read with the page. A submit button is never pressed. A dialog is closed with
 * Escape; a form opened in the page stays until the next route.
 */
async function primaryDialog(page: Page, route: string): Promise<{ text: string; dialog: boolean }> {
  const none = { text: '', dialog: false };
  const main = page.locator('.set-page[data-feature]').first();
  if (!(await main.count())) return none;
  const btn = main.locator('button.bk-btn--primary[type="button"]:not([disabled])').first();
  if (!(await btn.count()) || !(await btn.isVisible())) return none;
  // a button that sends a form already on the page (Skills' "Make this ability") is not pressed: it would act
  const sends = await btn.evaluate(
    (b) => !!b.closest('form, section, .bk-card')?.querySelector('input:not([type="hidden"]), textarea'),
  );
  if (sends) return none;
  const at = page.url();
  await btn.click();
  const dialog = page.locator('dialog.bk-sheet[open]').last();
  const opened = await dialog
    .waitFor({ state: 'visible', timeout: 800 })
    .then(() => true)
    .catch(() => false);
  await settle(page);
  // a button that opens another page (the helper form, a chat) is walked on its own route, not here
  if (page.url() !== at) return none;
  if (!opened)
    return { text: (await main.count()) ? await main.innerText({ timeout: 5_000 }) : '', dialog: false };
  const text = await dialog.innerText();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.bk-sheet[open]'), `${route}: its dialog closes on Escape`).toHaveCount(0);
  return { text, dialog: true };
}

const GROUPS = [
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

/** Every Settings feature route, from the group pages' own links (the live catalog), with Technical words on. */
async function enumerate(page: Page, base: string): Promise<string[]> {
  await technical(page, true);
  const out = new Set<string>();
  for (const g of GROUPS) {
    await page.goto(`${base}#/settings/${g}`);
    await page.reload();
    const p = page.getByTestId(`settings-page-${g}`);
    await expect(p).toBeVisible();
    for (const href of await p
      .locator('[data-testid^="feature-"] a.bk-row__main')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')))
      if (href.startsWith('#/')) out.add(href);
  }
  await technical(page, false);
  // the prefs are read at load: a reload makes the switch's new state the page's
  await page.reload();
  return [...out];
}

/** The visible text of the page under the top bar (the feature page, or a module page opened inside Settings). */
async function pageText(page: Page, route: string): Promise<string> {
  const main = page.locator('.set-page[data-feature], [data-testid="settings-technical-only"]').first();
  await expect(main, `${route} opens a Settings feature page`).toBeVisible();
  // module pages load their data after the first paint: wait for the loading dots to go
  await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
  await settle(page);
  // the top bar is part of what a person reads on that page: its visible text only (a closed dialog is not read)
  const top = await page
    .locator('header.top, header.ptop')
    .first()
    .evaluate((root) => {
      const out: string[] = [];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const el = n.parentElement;
        const text = n.textContent?.trim();
        if (text && el?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) out.push(text);
      }
      return out.join('\n');
    });
  return `${top}\n${await main.innerText()}`;
}

test('Technical words off: every page reachable from Settings speaks plain words, in English and Filipino', async ({
  page,
  server,
}, info) => {
  test.setTimeout(420_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const base = page.url().replace(/#.*$/, '');
  const routes = await enumerate(page, base);
  // nothing works or waits: Stop all is calm (not red) in the top bar, on the phone as on the desktop
  await page.goto(`${base}#/settings`);
  await expect(page.getByTestId('stop-all').first()).toHaveAttribute('data-calm', '1');
  expect(routes.length, 'the catalog lists Settings routes').toBeGreaterThan(20);
  const found: string[] = [];
  const pending: string[] = [];
  const pendingClean = new Set(PENDING);
  // the primary dialogs read on each language's walk (the same ones in Filipino as in English, at every width)
  const dialogs: Record<'en' | 'fil', string[]> = { en: [], fil: [] };
  for (const lng of ['en', 'fil'] as const) {
    await page.goto(`${base}#/settings/look/language`);
    await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
    await expect(page.locator('html')).toHaveAttribute('lang', lng);
    // Settings itself and the group pages (their rows' names and hints), as a first-timer sees them
    await page.goto(`${base}#/settings`);
    for (const l of offenders(await page.getByTestId('settings-home').innerText(), lng))
      found.push(`${lng} #/settings: ${l}`);
    for (const g of GROUPS) {
      await page.goto(`${base}#/settings/${g}`);
      const p = page.getByTestId(`settings-page-${g}`);
      await expect(p).toBeVisible();
      for (const l of offenders(await p.innerText(), lng)) found.push(`${lng} #/settings/${g}: ${l}`);
    }
    for (const route of routes) {
      await page.goto(`${base}${route}`);
      const own = await pageText(page, route);
      const dialog = await primaryDialog(page, route);
      if (dialog.dialog) dialogs[lng].push(route);
      const text = `${own}\n${dialog.text}`;
      for (const l of offenders(text, lng)) {
        if (PENDING.has(route)) {
          pending.push(`${lng} ${route}: ${l}`);
          pendingClean.delete(route);
        } else found.push(`${lng} ${route}: ${l}`);
      }
      if (lng === 'fil' && /agents\/agents|safety\/vault|agents\/brains|people\/channels/.test(route))
        await shot(page, `plain-${route.replace(/^#\//, '').replace(/\W+/g, '-')}`, w);
      // W40: the module pages that had no plain words before, in Filipino and English
      if (/^#\/(skills|mcp|budget|memory|routines|safety|data)$/.test(route))
        await shot(page, `${lng}-${route.slice(2)}`, w, 'w40-words');
    }
  }
  // R7 review: the helper form's folded "More options" (trust level, its hint and note, the computer-commands
  // switch) in plain words at every trust level, and the plain names never promise more asking than the level keeps
  const guardedSays = {
    en: 'Asks before anything outside its own folder',
    fil: 'Nagtatanong bago ang lahat ng nasa labas ng sarili niyang folder',
  };
  for (const lng of ['en', 'fil'] as const) {
    await page.goto(`${base}#/settings/look/language`);
    await page.locator('.lang-pick--detail [data-testid="lang-select"]').selectOption(lng);
    await expect(page.locator('html')).toHaveAttribute('lang', lng);
    await page.goto(`${base}#/agents/new`);
    const more = page.getByTestId('agent-more');
    await page.getByTestId('agent-more-toggle').click();
    const trust = more.getByTestId('agent-trust');
    await expect(trust).toBeVisible();
    await expect(trust.locator('option[value="guarded"]')).toHaveText(guardedSays[lng]);
    for (const level of ['guarded', 'standard', 'trusted'] as const) {
      await trust.selectOption(level);
      // the full "how it asks you" note opens where the level shows it
      const how = more.getByTestId('trust-how');
      if ((await how.count()) && (await how.getAttribute('aria-expanded')) !== 'true') await how.click();
      for (const l of offenders(await more.innerText(), lng))
        found.push(`${lng} #/agents/new (${level}): ${l}`);
    }
    await expect(more.getByTestId('ask-shell-web')).toBeVisible();
    if (lng === 'fil') await shot(page, 'helper-more-options', w, 'r7-words');
  }
  if (process.env.W30_REPORT)
    writeFileSync(`${process.env.W30_REPORT}-${w}.txt`, [...found, ...pending].join('\n'));
  info.annotations.push({ type: 'routes walked', description: `${routes.length}` });
  info.annotations.push({ type: 'pending (not plain yet)', description: pending.join('\n') });
  info.annotations.push({ type: 'dialogs read', description: dialogs.fil.join('\n') });
  expect(dialogs.en.length, 'primary dialogs were opened and read').toBeGreaterThan(0);
  expect(dialogs.fil, 'the Filipino walk opens the same primary dialogs').toEqual(dialogs.en);
  expect(found, found.join('\n')).toEqual([]);
  // a pending page that has become plain leaves the list
  expect([...pendingClean], 'pending pages now in plain words: take them off PENDING').toEqual([]);
});

test('Technical words on: the technical names are back on the pages that have them', async ({
  page,
  server,
}, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const w = phone ? '390' : '1440';
  if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala');
  const base = page.url().replace(/#.*$/, '');
  await technical(page, true);
  const pages: [string, RegExp][] = [
    ['#/settings/agents/agents', /\bagents?\b/i],
    ['#/settings/safety/trust', /\bagents?\b/i],
    ['#/settings/agents/brains', /\bACP\b/],
    ['#/settings/tools/mcp', /\bMCP\b/],
  ];
  for (const [route, re] of pages) {
    await page.goto(`${base}${route}`);
    await page.reload();
    const text = await pageText(page, route);
    expect(text, `${route} says its technical words`).toMatch(re);
  }
  await page.goto(`${base}#/settings/agents/acp-agents`);
  await expect(page.getByTestId('settings-technical-only')).toHaveCount(0);
  await shot(page, 'technical-acp-agents', w);
  await technical(page, false);
  await page.goto(`${base}#/settings/agents/acp-agents`);
  await page.reload();
  await expect(page.getByTestId('settings-technical-only')).toBeVisible();
  await shot(page, 'plain-acp-agents', w);
});
