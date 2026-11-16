/**
 * Regenerates the brand marks for BrandTile from the `simple-icons` package (a dev dependency; nothing of it is
 * bundled): `src/icons/brand-data.gen.ts` (path data, colours, lettermarks), the brand SVGs in `assets/icons/` and
 * `assets/icons/manifest.json`. Own glyphs (kind "own") are hand-drawn and kept as they are.
 *
 *   npx tsx packages/ui/scripts/gen-brands.ts && npx biome format --write packages/ui
 *
 * To add a brand: add a line to BRANDS (a Simple Icons slug) or, when Simple Icons does not ship the brand, to
 * LETTERS (a lettermark; never draw an imitation), run the command above, then list it in docs/BRANDS.md.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as icons from 'simple-icons';

type Group = 'brain' | 'connector' | 'channel' | 'store' | 'plugin';
interface SiIcon {
  title: string;
  slug: string;
  svg: string;
  path: string;
  source: string;
  hex: string;
  guidelines?: string;
  license?: { type: string; url?: string };
}

/** our id -> Simple Icons slug */
const BRANDS: [id: string, slug: string, label: string, group: Group][] = [
  ['claude', 'claude', 'Claude', 'brain'],
  ['gemini', 'googlegemini', 'Gemini', 'brain'],
  ['opencode', 'opencode', 'OpenCode (free starter)', 'brain'],
  ['ollama', 'ollama', 'Ollama (local model)', 'brain'],
  ['lmstudio', 'lmstudio', 'LM Studio (local model)', 'brain'],
  ['github', 'github', 'GitHub / GitHub (hosted)', 'connector'],
  ['git', 'git', 'Git repository', 'connector'],
  ['google', 'google', 'Google', 'connector'],
  ['google-calendar', 'googlecalendar', 'Google Calendar', 'connector'],
  ['gmail', 'gmail', 'Gmail', 'connector'],
  ['icloud', 'icloud', 'iCloud Mail', 'connector'],
  ['notion', 'notion', 'Notion', 'connector'],
  ['atlassian', 'atlassian', 'Jira and Confluence (Atlassian)', 'connector'],
  ['trello', 'trello', 'Trello', 'connector'],
  ['clickup', 'clickup', 'ClickUp', 'connector'],
  ['intercom', 'intercom', 'Intercom', 'connector'],
  ['stripe', 'stripe', 'Stripe', 'connector'],
  ['telegram', 'telegram', 'Telegram', 'channel'],
  ['whatsapp', 'whatsapp', 'WhatsApp', 'channel'],
  ['discord', 'discord', 'Discord', 'channel'],
  ['messenger', 'messenger', 'Messenger', 'channel'],
  ['shopee', 'shopee', 'Shopee', 'store'],
  ['tiktok', 'tiktok', 'TikTok Shop', 'store'],
  ['ebay', 'ebay', 'eBay', 'store'],
  ['rakuten', 'rakuten', 'Rakuten', 'store'],
  ['target', 'target', 'Target', 'store'],
  ['argos', 'argos', 'Argos', 'store'],
  ['fnac', 'fnac', 'Fnac', 'store'],
  ['naver', 'naver', 'Naver Shopping', 'store'],
  ['otto', 'otto', 'Otto', 'store'],
];

/** brands Simple Icons does not ship (checked against the installed version): a neutral lettermark */
const LETTERS: [id: string, letters: string, label: string, group: Group][] = [
  ['codex', 'C', 'Codex (OpenAI)', 'brain'],
  ['openai', 'O', 'OpenAI', 'brain'],
  ['grok', 'G', 'Grok (xAI)', 'brain'],
  ['slack', 'S', 'Slack', 'channel'],
  ['outlook', 'O', 'Outlook (Microsoft)', 'connector'],
  ['amazon', 'A', 'Amazon', 'store'],
  ['walmart', 'W', 'Walmart', 'store'],
  ['lazada', 'L', 'Lazada', 'store'],
  ['flipkart', 'F', 'Flipkart', 'store'],
  ['coupang', 'C', 'Coupang', 'store'],
  ['mercado', 'M', 'Mercado Libre / Mercado Livre', 'store'],
  ['tokopedia', 'T', 'Tokopedia', 'store'],
  ['meesho', 'M', 'Meesho', 'store'],
  ['kmart', 'K', 'Kmart', 'store'],
  ['noon', 'N', 'noon', 'store'],
  ['gmarket', 'G', 'Gmarket', 'store'],
  ['yahoo', 'Y', 'Yahoo! Shopping', 'store'],
  ['magalu', 'M', 'Magalu', 'store'],
  ['tiki', 'T', 'Tiki', 'store'],
  ['momo', 'M', 'momo', 'store'],
  ['pchome', 'P', 'PChome', 'store'],
  ['cdiscount', 'C', 'Cdiscount', 'store'],
  ['el-corte-ingles', 'E', 'El Corte Inglés', 'store'],
];

/** the tile behind a mark: `--bk-panel` in the light and the dark theme (packages/ui/src/styles.css) */
const TILE = { light: '#ffffff', dark: '#15211b' } as const;

const lum = (hex: string) => {
  const c = [0, 2, 4].map((i) => Number.parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #rrggbb colours */
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** the brand colour when it reaches 3:1 on the tile, else null (the tile then draws the mark in ink) */
const onTile = (hex: string, tile: string) => (contrast(`#${hex}`, tile) >= 3 ? `#${hex}` : null);

const ROOT = new URL('../', import.meta.url);
const ASSETS = new URL('assets/icons/', ROOT);
const siEntry = createRequire(import.meta.url).resolve('simple-icons');
const version = (
  JSON.parse(readFileSync(new URL('package.json', pathToFileURL(siEntry)), 'utf8')) as { version: string }
).version;
const bySlug = new Map(
  Object.values(icons as unknown as Record<string, SiIcon>)
    .filter((i) => i && typeof i === 'object' && 'slug' in i)
    .map((i) => [i.slug, i]),
);

type Manifest = Record<string, string>[];
const old = JSON.parse(readFileSync(new URL('manifest.json', ASSETS), 'utf8')) as Manifest;
/** own glyphs the real marks or lettermarks replace */
const RETIRED = new Set([
  'codex-own',
  'sparkle-own',
  'calendar-own',
  ...BRANDS.map((b) => b[0]),
  ...LETTERS.map((l) => l[0]),
]);
const own = old.filter((m) => m.kind === 'own' && !RETIRED.has(m.id!));

// brand SVGs are regenerated; stale ones (a brand Simple Icons dropped) are removed
const ownFiles = new Set(own.map((m) => `${m.id}.svg`));
for (const f of readdirSync(ASSETS)) if (f.endsWith('.svg') && !ownFiles.has(f)) rmSync(new URL(f, ASSETS));

const brandData: Record<
  string,
  { title: string; hex: string; light: string | null; dark: string | null; path: string }
> = {};
const manifest: Manifest = [];
for (const [id, slug, label, group] of BRANDS) {
  const i = bySlug.get(slug);
  if (!i) throw new Error(`simple-icons ${version} has no "${slug}": move ${id} to LETTERS`);
  writeFileSync(new URL(`${id}.svg`, ASSETS), `${i.svg}\n`);
  brandData[id] = {
    title: i.title,
    hex: `#${i.hex}`,
    light: onTile(i.hex, TILE.light),
    dark: onTile(i.hex, TILE.dark),
    path: i.path,
  };
  manifest.push({
    id,
    label,
    group,
    kind: 'brand',
    slug,
    title: i.title,
    hex: `#${i.hex}`,
    license: i.license?.type ?? 'CC0-1.0',
    source: `https://cdn.jsdelivr.net/npm/simple-icons@${version}/icons/${slug}.svg`,
    brandSource: i.source,
    guidelines: i.guidelines ?? '',
    note:
      slug === 'git'
        ? 'Git logo by Jason Long is CC BY 3.0, not CC0: credit "Git Logo by Jason Long" in NOTICE.'
        : '',
  });
}
const letterData: Record<string, { title: string; letters: string }> = {};
for (const [id, letters, label, group] of LETTERS) {
  if (bySlug.has(id)) throw new Error(`simple-icons ${version} ships "${id}": move it to BRANDS`);
  letterData[id] = { title: label, letters };
  manifest.push({
    id,
    label,
    group,
    kind: 'letter',
    letters,
    license: 'Apache-2.0',
    source: 'own lettermark (not in Simple Icons)',
    note: `Simple Icons ${version} does not ship this brand; the owner decides later whether to add a mark.`,
  });
}
manifest.push(...own);
writeFileSync(new URL('manifest.json', ASSETS), `${JSON.stringify(manifest, null, 2)}\n`);

const out = `/**
 * GENERATED by packages/ui/scripts/gen-brands.ts from simple-icons ${version}; do not edit by hand.
 * Brand marks: Simple Icons (CC0-1.0; Git: CC BY 3.0, "Git Logo by Jason Long"). Trademarks belong to their owners
 * and are used only to name the service (docs/BRANDS.md). \`light\` / \`dark\`: the brand colour when it keeps 3:1 on
 * the tile in that theme, else null (the mark is drawn in ink).
 */
export const SIMPLE_ICONS_VERSION = '${version}';

export interface BrandIcon {
  title: string;
  hex: string;
  light: string | null;
  dark: string | null;
  path: string;
}
export const BRAND_ICONS: Record<string, BrandIcon> = ${JSON.stringify(brandData, null, 2)};

/** brands Simple Icons does not ship: a neutral lettermark, never an imitation of the mark */
export const LETTER_MARKS: Record<string, { title: string; letters: string }> = ${JSON.stringify(letterData, null, 2)};
`;
writeFileSync(new URL('src/icons/brand-data.gen.ts', ROOT), out);
console.log(`simple-icons ${version}: ${BRANDS.length} brand marks, ${LETTERS.length} lettermarks`);
for (const [id] of BRANDS) {
  const b = brandData[id]!;
  console.log(
    `${id.padEnd(16)} ${b.hex}  light ${contrast(b.hex, TILE.light).toFixed(2)} ${b.light ? 'brand' : 'ink'}  dark ${contrast(b.hex, TILE.dark).toFixed(2)} ${b.dark ? 'brand' : 'ink'}`,
  );
}
