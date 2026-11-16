/**
 * Brand logos (ws/r6-logos): every BrandTile in light and dark, at 1440 px and 390 px. Brands show their real mark
 * (Simple Icons) in the brand colour, or in ink where that colour is under 3:1 on the tile; brands Simple Icons does
 * not ship show a neutral lettermark. Every id a screen passes resolves to a mark, never to the generic fallback: the
 * ids come from the real registries (the Brains catalogue, the provider packages, the local apps found by
 * themselves, the connector catalogue, the store packs) and from the literal ids the BrandTile call sites pass, all
 * read from the source, never typed here. Then the real app: the "Thinks with" picker, chat details and the Brains
 * page with Claude, Codex, Gemini, Grok, OpenCode, Ollama and LM Studio. Screenshots go to `.qa/w22-logos-*.png`.
 */
import { type Dirent, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRAND_MARKS, BrandTile, resolveMark } from '@pasabot/ui';
import type { Page } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

const ROOT = new URL('../../../', import.meta.url);
const QA = fileURLToPath(new URL('.qa/', ROOT));
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const CSS = read('packages/ui/src/styles.css');

const dirs = (path: string) =>
  readdirSync(new URL(path, ROOT), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name);
/** the `id: '...'` entries of one exported array (`export const NAME ... ];`) in a source file */
const idsOf = (path: string, name: string) => {
  const src = read(path);
  const from = src.indexOf(`export const ${name}`);
  if (from < 0) throw new Error(`no export const ${name} in ${path}`);
  return [...src.slice(from, src.indexOf('];', from)).matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]!);
};
/** the brains on the Brains page (its catalogue; `local` and `acp` are the `local:*` and `acp:*` groups) */
const catalogBrains = idsOf('modules/provider-ops/src/brains.ts', 'CATALOG');
/** Ollama and LM Studio register themselves as `local:<id>` (providers/local FOUND_APPS) */
const foundLocal = idsOf('providers/local/src/server.ts', 'FOUND_APPS').map((id) => `local:${id}`);
/** each provider package's adapter id (`readonly id = 'x'` or `id: 'x'`); `fake` is the test-only brain */
const adapterIds = dirs('providers/')
  .flatMap((d) => {
    let src: string;
    try {
      src = read(`providers/${d}/src/index.ts`);
    } catch {
      return [];
    }
    const m = src.match(/readonly id = '([^']+)'/) ?? src.match(/^\s*id: '([^']+)',/m);
    return m ? [m[1]!] : [];
  })
  .filter((id) => id !== 'fake');
const storeIds = [
  ...new Set(
    readdirSync(new URL('packages/store-packs/packs/', ROOT))
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) =>
        [...read(`packages/store-packs/packs/${f}`).matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]!),
      ),
  ),
];
/** every .tsx under a folder (tests left out); a folder that does not exist has none */
const walk = (path: string): string[] => {
  let entries: Dirent[];
  try {
    entries = readdirSync(new URL(path, ROOT), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) =>
    e.isDirectory()
      ? walk(`${path}${e.name}/`)
      : e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')
        ? [`${path}${e.name}`]
        : [],
  );
};
/** every screen that draws a BrandTile: the web app and each module, provider, channel or plugin `web` folder */
const callSites = [
  'apps/web/src/',
  ...['modules', 'providers', 'channels', 'plugins'].flatMap((r) =>
    dirs(`${r}/`).map((d) => `${r}/${d}/web/`),
  ),
]
  .flatMap(walk)
  .filter((f) => read(f).includes('<BrandTile'));
/** the literal ids those call sites pass: `id="bridge"`, `id={x ? 'mcp-server' : y}`, a section's `tile="..."` */
const literalIds = [
  ...new Set(
    callSites.flatMap((f) => {
      const src = read(f);
      const ids = [...src.matchAll(/<BrandTile\s[^>]*?\bid=(\{[^}]*\}|"[^"]+")/gs)].flatMap((m) =>
        // a quoted value the id can take, not a call's argument (`s.source?.startsWith('connector:')`)
        [...m[1]!.matchAll(/(\(?)(?:'([^']*)'|"([^"]*)")/g)].filter((q) => !q[1]).map((q) => (q[2] ?? q[3])!),
      );
      return [...ids, ...[...src.matchAll(/\btile="([^"]+)"/g)].map((m) => m[1]!)];
    }),
  ),
];
const SCREEN_IDS = {
  /** the Brains page, the agent form and onboarding (BrainPicker), the "Thinks with" picker, chat details */
  brains: [
    ...new Set([...catalogBrains, ...adapterIds, ...foundLocal, 'local:my-endpoint', 'acp:some-agent']),
  ],
  /** Settings › Connectors (catalogue slugs) and the tool servers made from them */
  connectors: dirs('catalog/connectors/'),
  /** Shop settings: every store of every country pack */
  stores: storeIds,
  /** the literal ids the call sites pass */
  literals: literalIds,
};
// Chat apps (Telegram, WhatsApp, Discord, Slack) have marks, but no screen draws them yet: the chat header and the
// chat apps settings still use the generic channels glyph (docs/BRANDS.md, "Not wired yet").

const label = (id: string) => {
  const m = BRAND_MARKS[id];
  return m && m.kind !== 'own' ? m.title : id;
};
const tile = (id: string, size: number) => renderToStaticMarkup(createElement(BrandTile, { id, size }));
const card = (id: string) =>
  `<li class="g-card" data-id="${id}">${tile(id, 40)}${tile(id, 24)}<span class="g-name">${label(id)}</span></li>`;
const section = (title: string, ids: string[]) =>
  `<section><h2>${title}</h2><ul class="g-grid">${ids.map(card).join('')}</ul></section>`;

const kinds = (k: string) => Object.keys(BRAND_MARKS).filter((id) => BRAND_MARKS[id]!.kind === k);
const page = (theme: 'light' | 'dark') => `<!doctype html><html data-theme="${theme}" lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}
body { margin: 0; padding: 16px; background: var(--bk-bg); color: var(--bk-ink); font: 14px/1.4 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 8px; } h2 { font-size: 16px; margin: 20px 0 8px; }
.g-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
.g-card { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 12px;
  background: var(--bk-bg-2, transparent); min-width: 0; }
.g-name { font-size: 13px; overflow-wrap: anywhere; min-width: 0; }
</style></head><body><h1>Brand tiles (${theme})</h1>
${section('Real marks (Simple Icons)', kinds('brand'))}
${section('Lettermarks (not in Simple Icons)', kinds('letter'))}
${section('PasaBot glyphs (not brands)', kinds('own'))}
${section('Brains, as the screens pass them', SCREEN_IDS.brains)}
</body></html>`;

test('every id a screen passes resolves to a real mark, a lettermark or an own glyph (no generic fallback)', () => {
  // the lists are read from the source: a parse that silently finds nothing fails here
  expect(catalogBrains).toEqual(
    expect.arrayContaining(['claude', 'codex', 'gemini', 'grok', 'opencode', 'local']),
  );
  expect(foundLocal).toEqual(['local:ollama', 'local:lmstudio']);
  expect(adapterIds).toEqual(expect.arrayContaining(['claude', 'codex', 'gemini', 'grok', 'opencode']));
  // every provider package is a brain the Brains page lists
  for (const id of adapterIds) expect(catalogBrains, `providers/${id} on the Brains page`).toContain(id);
  expect(SCREEN_IDS.connectors).toEqual(expect.arrayContaining(['github', 'git', 'google-calendar']));
  expect(SCREEN_IDS.stores.length).toBeGreaterThan(20);
  for (const f of [
    'apps/web/src/chat/ModelPicker.tsx',
    'apps/web/src/chat/Details.tsx',
    'apps/web/src/agents/BrainPicker.tsx',
    'modules/provider-ops/web/brains.tsx',
    'modules/connectors/web/index.tsx',
    'modules/mcp/web/index.tsx',
    'modules/shop/web/index.tsx',
    'modules/inbox/web/index.tsx',
  ])
    expect(callSites, 'BrandTile call sites').toContain(f);
  expect(SCREEN_IDS.literals).toEqual(
    expect.arrayContaining(['bridge', 'mcp-server', 'store', 'inbox-imap']),
  );
  for (const [where, ids] of Object.entries(SCREEN_IDS))
    for (const id of ids) expect(resolveMark(id).kind, `${where}: ${id}`).not.toBe('line');
});

for (const theme of ['light', 'dark'] as const) {
  test(`gallery of every brand tile, ${theme}`, async ({ page: p }, info) => {
    const w = info.project.name === 'phone' ? 390 : 1440;
    await p.setViewportSize({ width: w, height: 900 });
    await p.setContent(page(theme));

    // a brand mark wears its colour, or ink where the colour is under 3:1 on this theme's tile
    const colour = (id: string) =>
      p
        .locator(`.g-card[data-id="${id}"] .bk-brand-tile`)
        .first()
        .evaluate((e) => getComputedStyle(e).color);
    const ink = await p.evaluate(() => {
      const e = document.createElement('span');
      e.style.color = 'var(--bk-ink)';
      document.body.append(e);
      const c = getComputedStyle(e).color;
      e.remove();
      return c;
    });
    expect(await colour('discord')).toBe('rgb(88, 101, 242)');
    expect(await colour('claude')).toBe('rgb(217, 119, 87)');
    if (theme === 'light') {
      expect(await colour('whatsapp')).toBe(ink);
      expect(await colour('github')).toBe('rgb(24, 23, 23)');
    } else {
      expect(await colour('whatsapp')).toBe('rgb(37, 211, 102)');
      expect(await colour('github')).toBe(ink);
    }
    // the lettermark is real text of 12 px or more, never an imitation path
    const letters = p.locator('.g-card[data-id="slack"] .bk-brand-tile').last();
    await expect(letters).toHaveText('S');
    expect(await letters.locator('svg').count()).toBe(0);
    const px = await letters.locator('.bk-brand-tile__letters').evaluate((e) => getComputedStyle(e).fontSize);
    expect(Number.parseFloat(px)).toBeGreaterThanOrEqual(12);
    // every tile is drawn and the page does not scroll sideways
    const tiles = p.locator('.bk-brand-tile');
    expect(await tiles.count()).toBeGreaterThan(100);
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    mkdirSync(QA, { recursive: true });
    await p.screenshot({ path: `${QA}w22-logos-gallery-${theme}-${w}.png`, fullPage: true });
  });
}

/** the brains the real app shows, as the server names them, and the mark each one's tile draws */
const SEEDED: { id: string; displayName: string; mark: string; kind: 'brand' | 'letter' }[] = [
  { id: 'claude', displayName: 'Claude', mark: 'claude', kind: 'brand' },
  { id: 'codex', displayName: 'Codex', mark: 'codex', kind: 'letter' },
  { id: 'gemini', displayName: 'Gemini', mark: 'gemini', kind: 'brand' },
  { id: 'grok', displayName: 'Grok', mark: 'grok', kind: 'letter' },
  { id: 'opencode', displayName: 'OpenCode', mark: 'opencode', kind: 'brand' },
  { id: 'local:ollama', displayName: 'Ollama', mark: 'ollama', kind: 'brand' },
  { id: 'local:lmstudio', displayName: 'LM Studio', mark: 'lmstudio', kind: 'brand' },
];
/** the e2e server only runs the Fake brain: the list the app reads also reports the others, all ready */
async function seedBrains(page: Page) {
  await page.route('**/api/v1/providers', async (r) => {
    const res = await r.fetch();
    const body = (await res.json()) as { providers: { id: string }[] };
    body.providers.push(
      ...SEEDED.map((b) => ({
        id: b.id,
        displayName: b.displayName,
        status: { installed: true, signedIn: true as const },
      })),
    );
    await r.fulfill({ response: res, json: body });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`the real app: the "Thinks with" picker and the Brains page show each brain's mark, ${theme}`, async ({
    page,
    server,
  }, info) => {
    const w = info.project.name === 'phone' ? 390 : 1440;
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await page.addInitScript((look) => {
      try {
        localStorage.setItem('pasabot.look', look);
      } catch {
        // storage unavailable: the test then fails on the theme check below
      }
    }, theme);
    await seedBrains(page);
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    // the "Thinks with" picker: one row per ready brain, each with its mark on a 24 px tile beside its name
    await page.locator('[data-testid="model-pill"]:visible').click();
    const pop = page.getByTestId('model-popover');
    await expect(pop).toBeVisible();
    for (const b of SEEDED) {
      const row = pop.getByTestId(`model-brain-${b.id}`);
      await expect(row).toContainText(b.displayName);
      const t = row.locator('.bk-brand-tile');
      await expect(t).toHaveAttribute('data-mark', b.mark);
      await expect(t).toHaveAttribute('data-kind', b.kind);
      const box = (await t.boundingBox())!;
      expect(Math.round(box.width), `${b.id} tile size`).toBe(24);
      if (b.kind === 'brand') await expect(t.locator('svg path')).toHaveCount(1);
    }
    // inside the popover the brand colour holds (Claude is readable on both tiles); GitHub-style black marks go ink
    const colour = (id: string) =>
      pop
        .getByTestId(`model-brain-${id}`)
        .locator('.bk-brand-tile')
        .evaluate((e) => getComputedStyle(e).color);
    expect(await colour('claude')).toBe('rgb(217, 119, 87)');
    const ink = await pop.evaluate((e) => {
      const s = document.createElement('span');
      s.style.color = 'var(--bk-ink)';
      e.append(s);
      const c = getComputedStyle(s).color;
      s.remove();
      return c;
    });
    if (theme === 'dark') expect(await colour('opencode')).toBe(ink);
    else expect(await colour('opencode')).toBe('rgb(0, 0, 0)');
    expect(await noSideScroll()).toBe(true);
    mkdirSync(QA, { recursive: true });
    await page.screenshot({ path: `${QA}w22-logos-real-${theme}-${w}-picker.png` });
    await page.keyboard.press('Escape');

    // the Brains page: every catalogue brain with its mark
    await page.goto(`${server.url}/#/settings/agents/brains`);
    for (const b of SEEDED.filter((s) => !s.id.startsWith('local:')))
      await expect(
        page.locator(`[data-testid="brain-tile"][data-brain="${b.id}"] .bk-brand-tile`).first(),
      ).toHaveAttribute('data-mark', b.mark);
    await expect(
      page.locator('[data-testid="brain-tile"][data-brain="local"] .bk-brand-tile').first(),
    ).toHaveAttribute('data-kind', 'own');
    expect(await noSideScroll()).toBe(true);
    await page.screenshot({ path: `${QA}w22-logos-real-${theme}-${w}-brains.png`, fullPage: true });
  });
}
