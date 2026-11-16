/**
 * W30 store packs: data only. One JSON file per country (`packs/<CC>.json`), validated by `packSchema` and found by
 * discovery (every `*.json` in the packs dirs), so a new country needs no code change. No logos or brand art, no
 * affiliate or tracking parameters, no scraping service, never a regex or code in a pack: parsing hints are
 * structured-data preferences and plain CSS selector strings. Every check here is a linear character walk.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** the packs that ship with PasaBot */
export const SHIPPED_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

/**
 * Query parameters that carry affiliate or tracking ids; no URL field of a pack may contain one (lower case;
 * an entry ending in `*` is a prefix).
 */
export const TRACKING_PARAMS: readonly string[] = [
  'utm_*',
  'tag',
  'ascsubtag',
  'linkcode',
  'linkid',
  'camp',
  'creative',
  'creativeasin',
  'aff*',
  'affiliate*',
  'ref',
  'ref_',
  'referrer',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'twclid',
  'yclid',
  'irclickid',
  'irgwc',
  'clickid',
  'click_id',
  'af_*',
  'mkcid',
  'mkevt',
  'mkrid',
  'campid',
  'customid',
  'toolid',
  'smtt',
  'sub_id',
  'subid',
  'mc_cid',
  'mc_eid',
  'spm',
  'scm',
  'pvid',
  'trk*',
  'tracking*',
  'partner*',
  'pid',
  'clkid',
  'srsltid',
];

const isTrackingParam = (name: string) => {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.some((p) => (p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p));
};

/** printable plain text: no C0/C1 controls, no bidi overrides or zero-width characters, no line breaks */
export function isPlainText(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      return false;
    if (c === 0x2028 || c === 0x2029 || c === 0xfeff) return false;
  }
  return true;
}

const lowerAlnum = (c: string) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
/** a stable lowercase id: a–z, 0–9 and inner dashes, 1–40 characters */
export function isStoreId(s: string): boolean {
  if (s.length < 1 || s.length > 40 || !lowerAlnum(s[0]!) || !lowerAlnum(s[s.length - 1]!)) return false;
  for (const c of s) if (!lowerAlnum(c) && c !== '-') return false;
  return true;
}

const hostChar = (c: string) => lowerAlnum(c) || c === '-' || c === '.';
/** `shop.example` or `*.example` (lower case, at least one dot or a single label like `localhost`/`127.0.0.1`) */
export function isHostPattern(s: string): boolean {
  const h = s.startsWith('*.') ? s.slice(2) : s;
  if (h.length < 1 || h.length > 253 || h.startsWith('.') || h.endsWith('.') || h.includes('..'))
    return false;
  for (const c of h) if (!hostChar(c)) return false;
  return true;
}

// one host matcher for every allow-list (store packs, the browser port, the Shop page): `@pasabot/protocol`
export { hostAllowed, urlAllowed } from '@pasabot/protocol';

import { urlAllowed } from '@pasabot/protocol';

/** names of the tracking/affiliate query parameters in `url` (a `{query}` placeholder is not one) */
export function trackingParamsIn(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url.split('{query}').join('q'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const k of u.searchParams.keys()) if (isTrackingParam(k)) out.push(k);
  // a fragment can carry them too (`#tag=x`)
  if (u.hash.length > 1) {
    for (const part of u.hash.slice(1).split('&')) {
      const k = part.split('=')[0] ?? '';
      if (k && isTrackingParam(k)) out.push(k);
    }
  }
  return out;
}

const countPlaceholders = (t: string) => t.split('{query}').length - 1;

/** A plain CSS selector string (data, never code): ≤ 200 printable characters, no markup or script URLs. */
const selector = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => isPlainText(s) && !s.includes('<') && !s.toLowerCase().includes('javascript:'), {
    message: 'a selector is plain CSS text',
  });

const httpUrl = z
  .string()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'an absolute http(s) URL');

export const parsingHintsSchema = z
  .object({
    /** which structured data to read first */
    prefer: z
      .array(z.enum(['json-ld', 'opengraph', 'microdata']))
      .min(1)
      .max(3),
    /** optional CSS selectors (plain strings) for facts the structured data lacks */
    selectors: z
      .object({
        name: selector.optional(),
        price: selector.optional(),
        currency: selector.optional(),
        image: selector.optional(),
        rating: selector.optional(),
        ratingCount: selector.optional(),
      })
      .strict()
      .optional(),
    /** optional cart steps: the quantity field, the add-to-cart control and the cart/checkout page */
    cart: z
      .object({
        quantity: selector.optional(),
        addToCart: selector.optional(),
        checkoutUrl: httpUrl.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const storeSchema = z
  .object({
    id: z.string().refine(isStoreId, 'a lowercase id (a-z, 0-9, dashes)'),
    name: z.string().min(1).max(60).refine(isPlainText, 'plain text'),
    homeUrl: httpUrl,
    searchUrl: httpUrl.refine((t) => countPlaceholders(t) === 1, 'exactly one {query} placeholder'),
    allowedHosts: z.array(z.string().refine(isHostPattern, 'a host or *.suffix')).min(1).max(20),
    currency: z
      .string()
      .length(3)
      .refine((c) => [...c].every((x) => x >= 'A' && x <= 'Z'), 'an ISO 4217 code'),
    parsingHints: parsingHintsSchema,
  })
  .strict()
  .superRefine((s, ctx) => {
    const urls: [string, string][] = [
      ['homeUrl', s.homeUrl],
      ['searchUrl', s.searchUrl],
    ];
    if (s.parsingHints.cart?.checkoutUrl) urls.push(['checkoutUrl', s.parsingHints.cart.checkoutUrl]);
    for (const [k, u] of urls) {
      const probe = u.split('{query}').join('q');
      if (!urlAllowed(probe, s.allowedHosts))
        ctx.addIssue({ code: 'custom', path: [k], message: `${k} is outside allowedHosts` });
      const bad = trackingParamsIn(u);
      if (bad.length)
        ctx.addIssue({
          code: 'custom',
          path: [k],
          message: `tracking/affiliate parameter: ${bad.join(', ')}`,
        });
    }
  });
export type Store = z.infer<typeof storeSchema>;

export const packSchema = z
  .object({
    /** ISO 3166-1 alpha-2, upper case; equals the file name */
    country: z
      .string()
      .length(2)
      .refine((c) => [...c].every((x) => x >= 'A' && x <= 'Z'), 'an ISO 3166 code'),
    name: z.string().min(1).max(60).refine(isPlainText, 'plain text'),
    stores: z.array(storeSchema).min(1).max(30),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const s of p.stores) {
      if (seen.has(s.id))
        ctx.addIssue({ code: 'custom', path: ['stores'], message: `duplicate store id ${s.id}` });
      seen.add(s.id);
    }
  });
export type StorePack = z.infer<typeof packSchema>;

export interface LoadedPacks {
  /** by country code */
  packs: Map<string, StorePack>;
  /** files that did not validate (skipped, never half-loaded) */
  errors: { file: string; error: string }[];
}

/** Discovers and validates every `<CC>.json` in `dirs` (later dirs win for the same country). */
export function loadPacks(dirs: readonly string[] = [SHIPPED_PACKS_DIR]): LoadedPacks {
  const packs = new Map<string, StorePack>();
  const errors: LoadedPacks['errors'] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
        const pack = packSchema.parse(raw);
        if (`${pack.country}.json` !== file) throw new Error(`the file name must be ${pack.country}.json`);
        packs.set(pack.country, pack);
      } catch (e) {
        errors.push({ file: join(dir, file), error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { packs, errors };
}

/**
 * Fills a search template's one `{query}` placeholder URL-encoded. The result is checked to have exactly the
 * template's query parameters (a hostile query can never add one) and the template's host.
 */
export function fillSearch(template: string, query: string): string {
  if (countPlaceholders(template) !== 1)
    throw new Error('the template needs exactly one {query} placeholder');
  const filled = template.split('{query}').join(encodeURIComponent(query));
  const a = new URL(template.split('{query}').join('q'));
  const b = new URL(filled);
  const keys = (u: URL) => [...u.searchParams.keys()].join('&');
  if (a.host !== b.host || keys(a) !== keys(b) || (a.hash === '') !== (b.hash === ''))
    throw new Error('the query changed the search URL');
  return filled;
}

/** language → its main region when a locale has no region subtag (only languages with one clear market) */
const LANGUAGE_REGION: Record<string, string> = {
  fil: 'PH',
  tl: 'PH',
  id: 'ID',
  vi: 'VN',
  th: 'TH',
  ms: 'MY',
  ja: 'JP',
  ko: 'KR',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  hi: 'IN',
};
/** ISO region codes another code stands for here (`UK` is GB) */
const REGION_ALIAS: Record<string, string> = { UK: 'GB' };

/**
 * The owner's country from settings only, never a network call: the explicit region setting first, then the
 * locale's region subtag (`fil-PH` → PH), then the language's main market. Null when nothing names one.
 */
export function regionFor(o: { region?: string | null; locale?: string | null }): string | null {
  const norm = (r: string) => {
    const u = r.toUpperCase();
    return REGION_ALIAS[u] ?? u;
  };
  const isRegion = (r: string) =>
    r.length === 2 && [...r].every((c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
  if (o.region && isRegion(o.region)) return norm(o.region);
  const loc = (o.locale ?? '').split('_').join('-');
  if (!loc) return null;
  const parts = loc.split('-');
  for (const p of parts.slice(1)) if (isRegion(p)) return norm(p);
  return LANGUAGE_REGION[(parts[0] ?? '').toLowerCase()] ?? null;
}

/** The pack for the owner's country, or `fallback: true` (generic web search) when there is none. */
export function packFor(
  packs: ReadonlyMap<string, StorePack>,
  o: { region?: string | null; locale?: string | null },
): { country: string | null; pack: StorePack | null; fallback: boolean } {
  const country = regionFor(o);
  const pack = country ? (packs.get(country) ?? null) : null;
  return { country, pack, fallback: !pack };
}
