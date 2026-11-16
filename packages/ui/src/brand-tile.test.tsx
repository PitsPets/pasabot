import { readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import * as si from 'simple-icons';
import { describe, expect, it } from 'vitest';
import { BrandTile, brainTone, resolveMark } from './brand-tile.js';
import { BRAND_ICONS, LETTER_MARKS, SIMPLE_ICONS_VERSION } from './icons/brand-data.gen.js';
import { BRAND_MARKS } from './icons/brands.js';

const ASSETS = new URL('../assets/icons/', import.meta.url);
const bySlug = new Map(
  Object.values(si as unknown as Record<string, { slug: string; path: string; hex: string }>)
    .filter((i) => i && typeof i === 'object' && 'slug' in i)
    .map((i) => [i.slug, i]),
);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', ASSETS), 'utf8')) as {
  id: string;
  kind: string;
  slug?: string;
  license: string;
}[];
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as number[];
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe('BrandTile', () => {
  it('draws brands with their real mark, never a monogram', () => {
    expect(resolveMark('claude-code')).toEqual({ kind: 'brand', id: 'claude' });
    expect(resolveMark('gemini-cli')).toEqual({ kind: 'brand', id: 'gemini' });
    expect(resolveMark('opencode')).toEqual({ kind: 'brand', id: 'opencode' });
    expect(resolveMark('local:ollama')).toEqual({ kind: 'brand', id: 'ollama' });
    expect(resolveMark('local:lmstudio')).toEqual({ kind: 'brand', id: 'lmstudio' });
    expect(resolveMark('local')).toEqual({ kind: 'own', id: 'local' });
    expect(resolveMark('acp:anything')).toEqual({ kind: 'own', id: 'acp' });
    expect(resolveMark('fake').kind).toBe('line');
    for (const id of ['telegram', 'whatsapp', 'discord', 'messenger', 'gmail', 'github', 'notion', 'google'])
      expect(resolveMark(id).kind).toBe('brand');
    expect(resolveMark('google-calendar')).toEqual({ kind: 'brand', id: 'google-calendar' });
    expect(resolveMark('github-remote')).toEqual({ kind: 'brand', id: 'github' });
    expect(resolveMark('tiktok-shop')).toEqual({ kind: 'brand', id: 'tiktok' });
    const html = renderToStaticMarkup(<BrandTile id="claude-code" size={40} />);
    expect(html).toContain('data-mark="claude"');
    expect(html).toContain(`<path d="${BRAND_ICONS.claude!.path}"`);
    expect(html).toContain('--tile-brand-light:#D97757');
    expect(html).not.toMatch(/>Cl</);
  });

  it('gives brands Simple Icons does not ship a neutral lettermark, never an imitation', () => {
    expect(resolveMark('codex')).toEqual({ kind: 'letter', id: 'codex' });
    expect(resolveMark('grok')).toEqual({ kind: 'letter', id: 'grok' });
    expect(resolveMark('slack')).toEqual({ kind: 'letter', id: 'slack' });
    expect(resolveMark('outlook')).toEqual({ kind: 'letter', id: 'outlook' });
    expect(resolveMark('amazon')).toEqual({ kind: 'letter', id: 'amazon' });
    expect(resolveMark('mercado-libre')).toEqual({ kind: 'letter', id: 'mercado' });
    const html = renderToStaticMarkup(<BrandTile id="slack" size={24} />);
    expect(html).toContain('data-kind="letter"');
    expect(html).toContain('>S</span>');
    expect(html).toContain('--tile-letter:12px'); // never under 12 px, even on the smallest tile
    expect(html).not.toContain('<path');
    for (const id of Object.keys(LETTER_MARKS)) expect(bySlug.has(id)).toBe(false);
  });

  it('brand data is Simple Icons as installed: same path, same colour, nothing drawn by hand', () => {
    expect(SIMPLE_ICONS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [id, b] of Object.entries(BRAND_ICONS)) {
      const slug = manifest.find((m) => m.id === id)?.slug;
      const icon = bySlug.get(slug ?? '');
      expect(icon, `${id} -> ${slug}`).toBeTruthy();
      expect(b.path).toBe(icon!.path);
      expect(b.hex).toBe(`#${icon!.hex}`);
    }
  });

  it('a brand colour is used only where it keeps 3:1 on the tile (light #fff, dark #15211b), else ink', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/--bk-panel: #ffffff/);
    expect(css).toMatch(/--bk-panel: #15211b/);
    for (const b of Object.values(BRAND_ICONS)) {
      expect(b.light).toBe(ratio(b.hex, '#ffffff') >= 3 ? b.hex : null);
      expect(b.dark).toBe(ratio(b.hex, '#15211b') >= 3 ? b.hex : null);
    }
    expect(BRAND_ICONS.whatsapp!.light).toBeNull();
    expect(BRAND_ICONS.github!.dark).toBeNull();
    expect(renderToStaticMarkup(<BrandTile id="github" />)).not.toContain('--tile-brand-dark');
  });

  it('tints own glyphs and lettermarks of brains with our tone; brand marks keep the brand colour', () => {
    expect(brainTone('claude-code')).toBe('claude');
    expect(brainTone('github')).toBeNull();
    expect(renderToStaticMarkup(<BrandTile id="github" />)).not.toContain('--tile-mark');
    expect(renderToStaticMarkup(<BrandTile id="codex" />)).toContain('--bk-brain-codex');
    expect(renderToStaticMarkup(<BrandTile id="claude" />)).not.toContain('--bk-brain-claude');
  });

  it('every mark is in the manifest with a licence; brand and own marks have their SVG; Git carries its credit', () => {
    const files = readdirSync(ASSETS).filter((f) => f.endsWith('.svg'));
    for (const [id, m] of Object.entries(BRAND_MARKS)) {
      if (m.kind !== 'letter') expect(files).toContain(`${id}.svg`);
      expect(manifest.find((x) => x.id === id)?.license, id).toBeTruthy();
    }
    for (const f of files) expect(Object.hasOwn(BRAND_MARKS, f.replace(/\.svg$/, ''))).toBe(true);
    const notice = readFileSync(new URL('NOTICE.md', ASSETS), 'utf8');
    expect(notice).toContain('Git Logo by Jason Long');
    expect(notice).toContain('CC BY 3.0');
    const doc = readFileSync(new URL('../../../docs/BRANDS.md', import.meta.url), 'utf8');
    for (const id of Object.keys(BRAND_MARKS).filter((k) => BRAND_MARKS[k]!.kind !== 'own'))
      expect(doc, `docs/BRANDS.md lists ${id}`).toContain(`\`${id}\``);
  });
});
