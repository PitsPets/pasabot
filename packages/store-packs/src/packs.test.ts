/**
 * W30 store packs: every shipped pack validates and every country and store of the roadmap list is present; a pack
 * dropped into a temp dir loads with no code change; no logo/image field, no affiliate/tracking parameter, no URL
 * outside `allowedHosts`; a hostile query fills the search template without adding a parameter; the country comes
 * from the locale/region alone (no network call).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fillSearch,
  hostAllowed,
  loadPacks,
  packFor,
  packSchema,
  regionFor,
  SHIPPED_PACKS_DIR,
  storeSchema,
  trackingParamsIn,
  urlAllowed,
} from './index.js';

/** the roadmap's list (W30 "Packs shipped"); UK is the ISO code GB */
const EXPECTED: Record<string, string[]> = {
  PH: ['Shopee', 'Lazada', 'TikTok Shop'],
  ID: ['Tokopedia', 'Shopee', 'Lazada', 'TikTok Shop'],
  VN: ['Shopee', 'Lazada', 'Tiki'],
  TH: ['Shopee', 'Lazada'],
  MY: ['Shopee', 'Lazada'],
  SG: ['Shopee', 'Lazada', 'Amazon'],
  US: ['Amazon', 'Walmart', 'eBay', 'Target'],
  CA: ['Amazon', 'Walmart'],
  GB: ['Amazon', 'eBay', 'Argos'],
  DE: ['Amazon', 'eBay', 'Otto'],
  FR: ['Amazon', 'Cdiscount', 'Fnac'],
  ES: ['Amazon', 'El Corte Inglés'],
  BR: ['Mercado Livre', 'Amazon', 'Shopee', 'Magalu'],
  MX: ['Mercado Libre', 'Amazon'],
  IN: ['Amazon', 'Flipkart', 'Meesho'],
  JP: ['Amazon', 'Rakuten', 'Yahoo! Shopping'],
  KR: ['Coupang', 'Naver Shopping', 'Gmarket'],
  TW: ['Shopee', 'momo', 'PChome'],
  AU: ['Amazon', 'eBay', 'Kmart'],
  AE: ['Amazon', 'noon'],
  SA: ['Amazon', 'noon'],
};

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const testStore = {
  id: 'fixture-mart',
  name: 'Fixture Mart',
  homeUrl: 'https://shop.fixture.test/',
  searchUrl: 'https://shop.fixture.test/search?q={query}',
  allowedHosts: ['shop.fixture.test', '*.img.fixture.test'],
  currency: 'PHP',
  parsingHints: { prefer: ['json-ld'] },
};

describe('shipped packs', () => {
  const { packs, errors } = loadPacks();
  it('all validate, and every listed country and store is present', () => {
    expect(errors).toEqual([]);
    expect([...packs.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [cc, names] of Object.entries(EXPECTED)) {
      expect(packs.get(cc)!.stores.map((s) => s.name)).toEqual(names);
    }
  });
  it('no logo or image field, no tracking parameter, no URL outside allowedHosts, https only', () => {
    const banned = ['logo', 'image', 'icon', 'brand', 'art', 'affiliate', 'tracking'];
    const keysOf = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) for (const x of v) keysOf(x, out);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          out.push(k.toLowerCase());
          keysOf(x, out);
        }
      return out;
    };
    for (const f of readdirSync(SHIPPED_PACKS_DIR)) {
      const raw = JSON.parse(readFileSync(join(SHIPPED_PACKS_DIR, f), 'utf8'));
      for (const k of keysOf(raw)) for (const b of banned) expect(k.includes(b), `${f}: ${k}`).toBe(false);
    }
    for (const pack of packs.values())
      for (const s of pack.stores) {
        for (const u of [s.homeUrl, s.searchUrl]) {
          expect(u.startsWith('https://'), u).toBe(true);
          expect(trackingParamsIn(u), u).toEqual([]);
          expect(urlAllowed(u.replace('{query}', 'x'), s.allowedHosts), u).toBe(true);
        }
      }
  });
});

describe('discovery and schema', () => {
  it('a pack file dropped into a packs dir loads with no code change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pasabot-packs-'));
    tmp.push(dir);
    writeFileSync(
      join(dir, 'NZ.json'),
      JSON.stringify({ country: 'NZ', name: 'New Zealand', stores: [testStore] }),
    );
    const { packs, errors } = loadPacks([SHIPPED_PACKS_DIR, dir]);
    expect(errors).toEqual([]);
    expect(packs.get('NZ')!.stores[0]!.name).toBe('Fixture Mart');
    expect(packs.has('PH')).toBe(true);
  });
  it('a broken file is skipped and reported, never half-loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pasabot-packs-'));
    tmp.push(dir);
    writeFileSync(join(dir, 'NZ.json'), JSON.stringify({ country: 'AU', name: 'x', stores: [testStore] }));
    writeFileSync(join(dir, 'XX.json'), '{ not json');
    const { packs, errors } = loadPacks([dir]);
    expect(packs.size).toBe(0);
    expect(errors).toHaveLength(2);
  });
  it('refuses a logo field, a tracking parameter, a URL off allowedHosts and a regex-looking hint', () => {
    expect(storeSchema.safeParse(testStore).success).toBe(true);
    expect(storeSchema.safeParse({ ...testStore, logo: 'https://shop.fixture.test/l.png' }).success).toBe(
      false,
    );
    expect(
      storeSchema.safeParse({
        ...testStore,
        searchUrl: 'https://shop.fixture.test/s?q={query}&tag=pasabot-20',
      }).success,
    ).toBe(false);
    expect(
      storeSchema.safeParse({ ...testStore, homeUrl: 'https://shop.fixture.test/?utm_source=x' }).success,
    ).toBe(false);
    expect(storeSchema.safeParse({ ...testStore, homeUrl: 'https://evil.example/' }).success).toBe(false);
    expect(
      storeSchema.safeParse({ ...testStore, searchUrl: 'https://shop.fixture.test/search' }).success,
    ).toBe(false);
    expect(
      storeSchema.safeParse({ ...testStore, parsingHints: { prefer: ['json-ld'], regex: '.*' } }).success,
    ).toBe(false);
    expect(
      storeSchema.safeParse({
        ...testStore,
        parsingHints: { prefer: ['json-ld'], selectors: { price: '<script>x</script>' } },
      }).success,
    ).toBe(false);
    expect(storeSchema.safeParse({ ...testStore, name: 'Mart‮evil' }).success).toBe(false);
    expect(packSchema.safeParse({ country: 'NZ', name: 'x', stores: [testStore, testStore] }).success).toBe(
      false,
    );
  });
});

describe('search template and hosts', () => {
  it('a hostile query fills the template without adding a parameter', () => {
    const u = fillSearch(testStore.searchUrl, '"&tag=x#');
    const p = new URL(u);
    expect([...p.searchParams.keys()]).toEqual(['q']);
    expect(p.searchParams.get('q')).toBe('"&tag=x#');
    expect(p.hash).toBe('');
    expect(u).not.toContain('&tag=');
    const path = fillSearch('https://www.argos.co.uk/search/{query}/', '../../admin?x=1');
    expect(new URL(path).pathname.startsWith('/search/')).toBe(true);
    expect([...new URL(path).searchParams.keys()]).toEqual([]);
  });
  it('hosts: exact and *. suffix only', () => {
    expect(hostAllowed('shop.fixture.test', testStore.allowedHosts)).toBe(true);
    expect(hostAllowed('a.img.fixture.test', testStore.allowedHosts)).toBe(true);
    expect(hostAllowed('img.fixture.test', testStore.allowedHosts)).toBe(true);
    expect(hostAllowed('evilshop.fixture.test', testStore.allowedHosts)).toBe(false);
    expect(hostAllowed('shop.fixture.test.evil.example', testStore.allowedHosts)).toBe(false);
    expect(urlAllowed('javascript:alert(1)', testStore.allowedHosts)).toBe(false);
    expect(urlAllowed('https://user:pw@shop.fixture.test/', testStore.allowedHosts)).toBe(false);
  });
});

describe('country from locale/region (no network)', () => {
  it('fil-PH → PH, en-US → US, a region without a pack → web-search fallback, no fetch', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { packs } = loadPacks();
    expect(packFor(packs, { locale: 'fil-PH' }).country).toBe('PH');
    expect(packFor(packs, { locale: 'fil-PH' }).pack!.country).toBe('PH');
    expect(packFor(packs, { locale: 'en-US' }).pack!.country).toBe('US');
    expect(packFor(packs, { locale: 'fil' }).country).toBe('PH');
    expect(packFor(packs, { region: 'gb', locale: 'en-US' }).country).toBe('GB');
    expect(packFor(packs, { region: 'UK' }).country).toBe('GB');
    const nz = packFor(packs, { locale: 'en-NZ' });
    expect(nz).toEqual({ country: 'NZ', pack: null, fallback: true });
    expect(packFor(packs, { locale: 'en' }).fallback).toBe(true);
    expect(regionFor({})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('one host matcher', () => {
  it('store packs use the protocol matcher, not a copy', async () => {
    const protocol = await import('@pasabot/protocol');
    expect(hostAllowed).toBe(protocol.hostAllowed);
    expect(urlAllowed).toBe(protocol.urlAllowed);
  });
});
