/**
 * i18n for the web app: core + module locales (shell glob) plus the app's own strings (`apps/web/locales`,
 * namespace `web`). The language picker switches every system string. The first visit follows the browser's
 * language list; a choice is remembered on this device and for the signed-in user, and sets `<html lang dir>`.
 */

import {
  availableLocales,
  createI18n,
  type i18n,
  type LocaleMeta,
  localeMeta,
  type Resource,
  resolveLocale,
  SET_LANGUAGE_EVENT,
} from '@pasabot/i18n';
import { plainKeyOf, usePlainScope } from '@pasabot/i18n/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadWebLocales } from '../shell/modules.js';
import { api } from './api.js';
import { useStore } from './store.js';

/** A locale code that has files in this build (`en`, `fil`, `ja`, `pt-BR`, ...). */
export type Lang = string;
const KEY = 'pasabot.lang';
const userKey = (id: string) => `${KEY}.${id}`;

/** Every locale file the web app sees, with the app's own strings under `web`. */
export function webResources(): Resource {
  const base = loadWebLocales();
  const own = import.meta.glob('../../locales/*.json', { eager: true, import: 'default' }) as Record<
    string,
    Resource[string][string]
  >;
  for (const [path, tree] of Object.entries(own)) {
    const lng = path.match(/([a-z]{2,3}(?:-[A-Za-z]+)?)\.json$/)?.[1];
    if (lng) base[lng] = { ...(base[lng] ?? {}), web: tree };
  }
  return base;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // ignore
  }
}

function initialLang(available: string[]): Lang {
  const saved = read(KEY);
  if (saved && available.includes(saved)) return saved;
  const nav = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  return resolveLocale(nav, available);
}

interface Ctx {
  lang: Lang;
  setLang(l: Lang): void;
  t: i18n['t'];
  /** `t` in plain words: `plain.<key>` when it exists (inside `<PlainWords on>`, see `useT`) */
  plainT: i18n['t'];
  /** every language in this build, with its own name, direction and review status */
  languages: LocaleMeta[];
  meta: LocaleMeta;
}
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const res = useMemo(webResources, []);
  const languages = useMemo(() => availableLocales(res).map((l) => localeMeta(res, l)), [res]);
  const codes = useMemo(() => languages.map((l) => l.code), [languages]);
  const [lang, setLangState] = useState<Lang>(() => initialLang(codes));
  const userId = useStore((s) => s.me?.id ?? null);
  // a language the signed-in user picked themselves wins over this device's last one
  useEffect(() => {
    if (!userId) return;
    const mine = read(userKey(userId));
    if (mine && codes.includes(mine)) setLangState(mine);
  }, [userId, codes]);
  // the server renders push, channel and stored text in the language the person reads the app in (W24)
  useEffect(() => {
    if (!userId) return;
    api('/api/v1/me/language', { method: 'PUT', body: { language: lang } }).catch(() => {});
  }, [userId, lang]);
  const inst = useMemo(() => {
    const i = createI18n(res, lang);
    i.setDefaultNamespace('web');
    return i;
  }, [res, lang]);
  const setLang = useCallback(
    (l: Lang) => {
      write(KEY, l);
      if (userId) write(userKey(userId), l);
      setLangState(l);
    },
    [userId],
  );
  // a module's language pick (the team builder's Stage): the same as a pick in Settings › Language
  useEffect(() => {
    const on = (e: Event) => {
      const l = (e as CustomEvent<unknown>).detail;
      if (typeof l === 'string' && codes.includes(l)) setLang(l);
    };
    window.addEventListener(SET_LANGUAGE_EVENT, on);
    return () => window.removeEventListener(SET_LANGUAGE_EVENT, on);
  }, [codes, setLang]);
  const meta = useMemo(() => localeMeta(res, lang), [res, lang]);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.dir;
  }
  const value = useMemo<Ctx>(() => {
    const t = inst.t.bind(inst) as i18n['t'];
    const call = t as unknown as (key: unknown, ...rest: unknown[]) => string;
    const plainT = ((key: unknown, ...rest: unknown[]) => {
      if (typeof key === 'string') {
        const p = plainKeyOf(key);
        if (p !== key && inst.exists(p)) return call(p, ...rest);
      }
      return call(key, ...rest);
    }) as unknown as i18n['t'];
    return { lang, setLang, t, plainT, languages, meta };
  }, [lang, setLang, inst, languages, meta]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nCtx);
  if (!c) throw new Error('useI18n outside I18nProvider');
  return c;
}
/**
 * The app's translate function. Inside `<PlainWords on>` (every Settings page while "Technical words" is off) a key
 * reads its plain wording `plain.<key>` when the locale has one, as module strings do (W30).
 */
export const useT = () => {
  const c = useI18n();
  return usePlainScope() ? c.plainT : c.t;
};
