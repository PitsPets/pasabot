/**
 * The desktop shell has no strings of its own: the launcher picks the locale and sends every label already
 * translated (`apps/desktop/locales/<lng>.json`, `en` fills any gap). `{{name}}` placeholders, like i18next.
 */
import { readFileSync } from 'node:fs';

export const LOCALES = ['en', 'fil'] as const;
export type Locale = (typeof LOCALES)[number];
export type Strings = Record<string, string>;

/** `fil-PH`, `tl_PH.UTF-8`, `tl` → fil; anything we do not ship → en */
export function pickLocale(requested: string | undefined | null): Locale {
  const tag = (requested ?? '').toLowerCase().replace('_', '-').split(/[.@]/)[0] ?? '';
  const base = tag.split('-')[0];
  if (base === 'fil' || base === 'tl') return 'fil';
  return 'en';
}

const read = (lng: Locale): Strings => {
  const raw = JSON.parse(readFileSync(new URL(`../locales/${lng}.json`, import.meta.url), 'utf8')) as Strings;
  return raw;
};

export function loadStrings(lng: Locale): Strings {
  const en = read('en');
  return lng === 'en' ? en : { ...en, ...read(lng) };
}

export function t(s: Strings, key: string, vars: Record<string, string> = {}): string {
  const tpl = s[key] ?? key;
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}
