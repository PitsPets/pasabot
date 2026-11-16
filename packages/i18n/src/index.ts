/**
 * @pasabot/i18n — i18next setup, core strings, and the locale-file merger.
 * Every package may ship `locales/<code>.json`; they are merged under the namespace `<id>` (folder name),
 * core strings under `core`. No central registry: callers glob the files and pass them in, so a new language is
 * one more `<code>.json` per folder and loads with no code change. A language's own name, writing direction and
 * review status live in its core file under `meta` (`packages/i18n/locales/<code>.json`).
 */
import i18next, { type i18n, type Resource } from 'i18next';

export type { i18n, Resource };

/** The languages this repo ships. Discovery does not depend on this list; `i18n:check` and tests do. */
export const SUPPORTED_LOCALES = [
  'en',
  'fil',
  'es',
  'pt-BR',
  'fr',
  'de',
  'id',
  'vi',
  'hi',
  'ja',
  'ko',
  'zh-Hans',
  'zh-Hant',
  'ar',
] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
/**
 * A module asks the web app to show itself in another UI language (the team builder's Stage, where the owner picks
 * one): `window.dispatchEvent(new CustomEvent(SET_LANGUAGE_EVENT, { detail: 'fil' }))`. A code the app does not ship
 * is ignored; the choice is kept like one made in Settings › Language.
 */
export const SET_LANGUAGE_EVENT = 'pasabot:set-language';
export const CORE_NAMESPACE = 'core';
/** Where a "help improve this translation" link points: the CONTRIBUTING section on languages. */
export const TRANSLATION_HELP_URL = 'CONTRIBUTING.md#adding-a-language';

export type LocaleTree = { [k: string]: string | LocaleTree };

/** What a language says about itself in its core file (`core:meta`). */
export interface LocaleMeta {
  code: string;
  /** the language's name in that language, e.g. "日本語" */
  name: string;
  dir: 'ltr' | 'rtl';
  /** false for a machine-written locale no fluent speaker has signed off yet */
  reviewed: boolean;
}

/**
 * Namespace for a locale file path: `.../modules/<id>/locales/en.json` -> `<id>`,
 * `.../packages/i18n/locales/en.json` -> `core`.
 */
export function namespaceOf(path: string): { ns: string; lng: string } | null {
  const m = path
    .replace(/\\/g, '/')
    .match(/(?:^|\/)([^/]+)\/([^/]+)\/locales\/([a-z]{2,3}(?:-[A-Za-z]+)?)\.json$/);
  if (!m) return null;
  const [, group, id, lng] = m;
  if (group === 'packages' && id === 'i18n') return { ns: CORE_NAMESPACE, lng: lng! };
  return { ns: id!, lng: lng! };
}

/** Merge `{ path: json }` (e.g. an eager import.meta.glob result) into i18next resources. */
export function mergeLocaleFiles(files: Record<string, LocaleTree | { default: LocaleTree }>): Resource {
  const res: Resource = {};
  for (const [path, mod] of Object.entries(files)) {
    const where = namespaceOf(path);
    if (!where) continue;
    const data = (mod as { default?: LocaleTree }).default ?? (mod as LocaleTree);
    res[where.lng] ??= {};
    res[where.lng]![where.ns] = data;
  }
  return res;
}

/**
 * Resources for one namespace from a module's own globbed files, keyed by file name:
 * `localeResources('shop', import.meta.glob('../locales/*.json', { eager: true, import: 'default' }))`.
 */
export function localeResources(ns: string, files: Record<string, unknown>): Resource {
  const res: Resource = {};
  for (const [path, mod] of Object.entries(files)) {
    const lng = path.match(/([a-z]{2,3}(?:-[A-Za-z]+)?)\.json$/)?.[1];
    if (!lng) continue;
    const data = ((mod as { default?: LocaleTree }).default ?? mod) as LocaleTree;
    res[lng] = { ...(res[lng] ?? {}), [ns]: data };
  }
  return res;
}

/** Languages are written right to left by script; only these ship today. */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
export const dirOf = (lng: string): 'ltr' | 'rtl' => (RTL.has(lng.split('-')[0]!) ? 'rtl' : 'ltr');

/**
 * Best available locale for a BCP 47 tag (or a list in preference order, like `navigator.languages`):
 * exact match, then the script/region form we ship (`zh-TW` -> `zh-Hant`, `zh-CN` -> `zh-Hans`, `pt` -> `pt-BR`,
 * `tl` -> `fil`), then the base language; `fallback` when nothing matches.
 */
export function resolveLocale(
  wanted: string | readonly string[] | null | undefined,
  available: readonly string[] = SUPPORTED_LOCALES,
  fallback: string = DEFAULT_LOCALE,
): string {
  const list = (Array.isArray(wanted) ? wanted : [wanted]).filter((x): x is string => !!x);
  const byLower = new Map(available.map((a) => [a.toLowerCase(), a]));
  for (const raw of list) {
    const tag = raw.replace(/_/g, '-').toLowerCase();
    const exact = byLower.get(tag);
    if (exact) return exact;
    const [base, ...rest] = tag.split('-');
    let alias: string | undefined;
    if (base === 'zh') {
      const hant = rest.some((p) => ['hant', 'tw', 'hk', 'mo'].includes(p));
      alias = hant ? 'zh-hant' : 'zh-hans';
    } else if (base === 'tl') alias = 'fil';
    else if (base === 'in') alias = 'id';
    if (alias && byLower.has(alias)) return byLower.get(alias)!;
    if (base && byLower.has(base)) return byLower.get(base)!;
    const sameBase = available.find((a) => a.toLowerCase().split('-')[0] === base);
    if (sameBase) return sameBase;
  }
  return fallback;
}

/**
 * A brain's (provider's) name as every screen shows it (W24): a product name as is; a name with a locale key (the
 * test brain) translated by `t`, the English name when the language lacks the key. One rule for the side panel, the
 * chat header, the Brain picker and Settings (the shell passes its `t`; the server passes `app.i18n.t`).
 */
export function providerDisplayName(
  p: { displayName: string; displayNameKey?: string | undefined },
  t: (key: string, opts: { defaultValue: string }) => unknown,
): string {
  return p.displayNameKey ? String(t(p.displayNameKey, { defaultValue: p.displayName })) : p.displayName;
}

/** app locales written in a non-Latin script: a Latin `am`/`pm` in their times is English leaking through */
const NON_LATIN = new Set(['hi', 'ar', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
const latinDayPeriod = new Map<string, boolean>();
/** whether this platform's `Intl` writes the day period of `lng` in Latin letters (ICU gives `hi` plain `pm`) */
function writesLatinDayPeriod(lng: string): boolean {
  let v = latinDayPeriod.get(lng);
  if (v === undefined) {
    try {
      const part = new Intl.DateTimeFormat(lng, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' })
        .formatToParts(Date.UTC(2026, 0, 1, 15))
        .find((p) => p.type === 'dayPeriod');
      v = !!part && /[a-z]/i.test(part.value);
    } catch {
      v = false;
    }
    latinDayPeriod.set(lng, v);
  }
  return v;
}

/**
 * The locale to hand `Intl` (dates, numbers, currency) for an app locale. A non-Latin-script locale whose platform
 * day period is Latin (`hi` gives `3:05 pm`) uses the 24-hour clock instead, so no English shows in its times.
 */
export const intlLocale = (lng: string): string => {
  if (lng === 'fil') return 'fil-PH';
  if (NON_LATIN.has(lng) && writesLatinDayPeriod(lng)) return `${lng}-u-hc-h23`;
  return lng;
};

/**
 * The language the web shell set on `<html lang>`, narrowed to the locales a module ships
 * (`en` outside a browser, e.g. when a slot is rendered on the server).
 */
export function documentLocale(available: readonly string[] | Resource = SUPPORTED_LOCALES): string {
  const list = Array.isArray(available) ? available : Object.keys(available);
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  return resolveLocale(lang, list);
}

/** A language's self-description from its core `meta` block (sensible defaults when the block is missing). */
export function localeMeta(resources: Resource, lng: string): LocaleMeta {
  const meta = (resources[lng]?.[CORE_NAMESPACE] as LocaleTree | undefined)?.meta as LocaleTree | undefined;
  const name = typeof meta?.name === 'string' && meta.name ? meta.name : lng;
  const dir = meta?.dir === 'rtl' || meta?.dir === 'ltr' ? meta.dir : dirOf(lng);
  return { code: lng, name, dir, reviewed: meta?.status !== 'unreviewed' };
}

/** Every language present in `resources`, `en` first, then by code (stable for a picker). */
export function availableLocales(resources: Resource): string[] {
  return Object.keys(resources).sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
}

/** A ready (synchronously initialised) i18next instance; every language falls back to `en` key by key. */
export function createI18n(resources: Resource, lng: string = DEFAULT_LOCALE): i18n {
  const inst = i18next.createInstance();
  const langs = [...new Set([...SUPPORTED_LOCALES, ...Object.keys(resources)])];
  void inst.init({
    resources,
    lng,
    fallbackLng: { default: ['en'] },
    supportedLngs: langs,
    nonExplicitSupportedLngs: false,
    load: 'currentOnly',
    ns: [...new Set(Object.values(resources).flatMap((r) => Object.keys(r ?? {})))],
    defaultNS: CORE_NAMESPACE,
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return inst;
}

/** One ready instance per language in `resources` (modules that switch instances instead of re-creating one). */
export function localeInstances(resources: Resource): Record<string, i18n> {
  return Object.fromEntries(Object.keys(resources).map((l) => [l, createI18n(resources, l)]));
}

/**
 * The `Intl` locale for showing dates and numbers in the app's language, always: every language formats in that
 * language. `en` keeps the device's English region (en-PH, en-GB) when the device's own language is English, and is
 * plain `en` otherwise (an English app on a German device shows English dates, never the device's German ones).
 * `device` is the device's language (`navigator.language` by default).
 */
export function displayLocale(
  lng: string = documentLocale(),
  device: string | undefined = deviceLanguage(),
): string {
  if (lng !== 'en') return intlLocale(lng);
  const d = (device ?? '').replace('_', '-');
  if (d.toLowerCase() === 'en' || d.toLowerCase().startsWith('en-')) {
    try {
      return Intl.getCanonicalLocales(d)[0] ?? 'en';
    } catch {
      return 'en';
    }
  }
  return 'en';
}
const deviceLanguage = () => (typeof navigator !== 'undefined' ? navigator.language : undefined);

/** Keys present in `en` but missing in `lng`, per namespace (used by the W24 missing-key gate). */
export function missingKeys(resources: Resource, lng: string): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, prefix: string) => {
    if (typeof a !== 'object' || a === null) return;
    for (const [k, v] of Object.entries(a)) {
      const other = (b as Record<string, unknown> | undefined)?.[k];
      if (typeof v === 'object') walk(v, other, `${prefix}${k}.`);
      else if (other === undefined && !isPluralVariantPresent(k, b, lng)) out.push(`${prefix}${k}`);
    }
  };
  for (const [ns, tree] of Object.entries(resources.en ?? {})) walk(tree, resources[lng]?.[ns], `${ns}:`);
  return out;
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** An `en` plural form (`x_one`) counts as present when the language has the forms its own rules need. */
function isPluralVariantPresent(key: string, tree: unknown, lng: string): boolean {
  const m = key.match(PLURAL_SUFFIX);
  if (!m || !tree || typeof tree !== 'object') return false;
  const base = key.slice(0, -m[0].length);
  const cats = pluralCategories(lng);
  // a category the language does not use (e.g. `_one` in Japanese) is not missing
  if (!cats.includes(m[1]!)) return `${base}_other` in tree;
  return false;
}

/** CLDR plural categories i18next uses for a language. */
export function pluralCategories(lng: string): string[] {
  try {
    return [...new Intl.PluralRules(lng).resolvedOptions().pluralCategories];
  } catch {
    return ['one', 'other'];
  }
}
