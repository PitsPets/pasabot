/**
 * W30 product capture: the facts of a product page from the data the managed browser read (`BrowserPageData`),
 * structured data first (JSON-LD `Product`/`Offer`, OpenGraph product tags, microdata, in the store's preferred
 * order), then the store's plain CSS selectors. Everything read is untrusted: plain text is cleaned and bounded,
 * images and links survive only on the store's `allowedHosts`, prices are normalised but never converted. Linear
 * character walks only (no regular expressions over page text).
 */
import type { BrowserPageData } from '@pasabot/core';
import { type Store, urlAllowed } from '@pasabot/store-packs';

export interface ProductFacts {
  name: string;
  /** a plain decimal string ("1299.00"), never converted */
  price: string;
  /** ISO 4217 */
  currency: string;
  image: string | null;
  url: string;
  rating: number | null;
  ratingCount: number | null;
}

/** printable text only (controls, bidi overrides and zero-width characters dropped), whitespace collapsed */
export function plainText(s: unknown, max = 200): string {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  let out = '';
  let space = false;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)!;
    const ws = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0;
    const bad =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0xfeff;
    if (ws) {
      space = out.length > 0;
      continue;
    }
    if (bad) continue;
    if (space) out += ' ';
    space = false;
    out += ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/**
 * "₱1,299.00", "1.299,00 €", 1299 → "1299.00" / "1299" (digits and one decimal separator kept). The last `.` or
 * `,` is the decimal separator when two or fewer digits follow it; every other separator is a thousands mark.
 */
export function normalizePrice(raw: unknown): string | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? String(raw) : null;
  if (typeof raw !== 'string') return null;
  const s = raw.slice(0, 60);
  let digits = '';
  let started = false;
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      digits += ch;
      started = true;
    } else if ((ch === '.' || ch === ',') && started) {
      digits += '|';
    } else if (started && ch !== ' ' && ch !== ' ' && ch !== "'") break;
  }
  if (!digits.split('|').join('')) return null;
  const sepAt = digits.lastIndexOf('|');
  let whole = digits;
  let frac = '';
  if (sepAt >= 0 && digits.length - sepAt - 1 <= 2 && digits.length - sepAt - 1 > 0) {
    whole = digits.slice(0, sepAt);
    frac = digits.slice(sepAt + 1);
  }
  whole = whole.split('|').join('');
  if (!whole) whole = '0';
  const n = Number(frac ? `${whole}.${frac}` : whole);
  if (!Number.isFinite(n) || n < 0) return null;
  let k = 0;
  while (k < whole.length - 1 && whole[k] === '0') k++;
  whole = whole.slice(k);
  return frac ? `${whole}.${frac}` : whole;
}

const isCurrency = (c: unknown): c is string =>
  typeof c === 'string' && c.length === 3 && [...c].every((x) => x >= 'A' && x <= 'Z');

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(normalizePrice(v)) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

const types = (o: Record<string, unknown>) => {
  const t = o['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
};

/** the first JSON-LD node of @type Product (top level, arrays, @graph), bounded */
function findProduct(v: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 50)) {
      const f = findProduct(x, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  if (types(o).includes('Product')) return o;
  if (o['@graph']) return findProduct(o['@graph'], depth + 1);
  return null;
}

const firstUrl = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstUrl(v[0]);
  if (v && typeof v === 'object') return firstUrl((v as Record<string, unknown>).url);
  return null;
};

type Partial = {
  name?: string;
  price?: string;
  currency?: string;
  image?: string;
  rating?: number;
  ratingCount?: number;
};

function fromJsonLd(d: BrowserPageData): Partial {
  for (const text of d.jsonLd) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const p = findProduct(parsed);
    if (!p) continue;
    const out: Partial = {};
    const name = plainText(p.name);
    if (name) out.name = name;
    const img = firstUrl(p.image);
    if (img) out.image = img;
    let offers = p.offers as unknown;
    if (Array.isArray(offers)) offers = offers[0];
    if (offers && typeof offers === 'object') {
      const o = offers as Record<string, unknown>;
      const price = normalizePrice(o.price ?? o.lowPrice);
      if (price) out.price = price;
      if (isCurrency(o.priceCurrency)) out.currency = o.priceCurrency;
    }
    const ar = p.aggregateRating as Record<string, unknown> | undefined;
    if (ar && typeof ar === 'object') {
      const r = num(ar.ratingValue);
      const c = num(ar.reviewCount ?? ar.ratingCount);
      if (r !== null) out.rating = r;
      if (c !== null) out.ratingCount = Math.round(c);
    }
    return out;
  }
  return {};
}

function fromOpenGraph(d: BrowserPageData): Partial {
  const get = (...keys: string[]) => d.meta.find((m) => keys.includes(m.key.toLowerCase()))?.value;
  const out: Partial = {};
  const name = plainText(get('og:title'));
  if (name) out.name = name;
  const img = get('og:image', 'og:image:secure_url');
  if (img) out.image = img;
  const price = normalizePrice(get('product:price:amount', 'og:price:amount'));
  if (price) out.price = price;
  const cur = get('product:price:currency', 'og:price:currency');
  if (isCurrency(cur)) out.currency = cur;
  return out;
}

function fromMicrodata(d: BrowserPageData): Partial {
  const get = (k: string) =>
    d.microdata.find((m) => m.prop === k)?.value ?? d.meta.find((m) => m.key === k)?.value;
  const out: Partial = {};
  const name = plainText(get('name'));
  if (name) out.name = name;
  const img = get('image');
  if (img) out.image = img;
  const price = normalizePrice(get('price'));
  if (price) out.price = price;
  const cur = get('priceCurrency');
  if (isCurrency(cur)) out.currency = cur;
  const r = num(get('ratingValue'));
  if (r !== null) out.rating = r;
  const c = num(get('reviewCount') ?? get('ratingCount'));
  if (c !== null) out.ratingCount = Math.round(c);
  return out;
}

function fromSelectors(d: BrowserPageData): Partial {
  const s = d.selected;
  const out: Partial = {};
  const name = plainText(s.name);
  if (name) out.name = name;
  if (s.image) out.image = s.image;
  const price = normalizePrice(s.price);
  if (price) out.price = price;
  const cur = (s.currency ?? '').trim().toUpperCase();
  if (isCurrency(cur)) out.currency = cur;
  const r = num(s.rating);
  if (r !== null) out.rating = r;
  const c = num(s.ratingCount);
  if (c !== null) out.ratingCount = Math.round(c);
  return out;
}

/** an image or link we may show: an http(s) URL (resolved against the page) on the store's hosts, else null */
export function allowedUrl(
  raw: string | null | undefined,
  base: string,
  hosts: readonly string[],
): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  return urlAllowed(u.href, hosts) ? u.href : null;
}

/** The product's facts, or null when the page names no product with a price. */
export function parseProduct(d: BrowserPageData, store: Store): ProductFacts | null {
  const parts: Partial[] = [];
  for (const p of store.parsingHints.prefer) {
    if (p === 'json-ld') parts.push(fromJsonLd(d));
    else if (p === 'opengraph') parts.push(fromOpenGraph(d));
    else parts.push(fromMicrodata(d));
  }
  parts.push(fromSelectors(d));
  const pick = <K extends keyof Partial>(k: K) => parts.find((p) => p[k] !== undefined)?.[k];
  const name = pick('name');
  const price = pick('price');
  if (!name || !price) return null;
  const url = allowedUrl(d.url, d.url, store.allowedHosts);
  if (!url) return null;
  const rating = pick('rating');
  const count = pick('ratingCount');
  return {
    name: plainText(name, 200),
    price,
    currency: pick('currency') ?? store.currency,
    image: allowedUrl(pick('image'), d.url, store.allowedHosts),
    url,
    rating: rating !== undefined && rating >= 0 && rating <= 10 ? rating : null,
    ratingCount: rating !== undefined && count !== undefined && count >= 0 ? count : null,
  };
}

/** a URL whose path says sign-up / register / create account: never opened by the shop module */
export function isSignUpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return true;
  }
  const w: string[] = [];
  let cur = '';
  for (const ch of `${u.pathname} ${u.hash}`.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) cur += ch;
    else if (cur) {
      w.push(cur);
      cur = '';
    }
  }
  if (cur) w.push(cur);
  const joined = w.join('');
  return (
    w.some((x) => ['signup', 'register', 'registration', 'createaccount', 'join', 'enroll'].includes(x)) ||
    joined.includes('signup') ||
    joined.includes('createaccount')
  );
}
