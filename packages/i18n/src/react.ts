/**
 * The translate hook every module's web code uses. One translate function per module and language, made once and
 * kept: the same function on every render and in every component. Pages' loaders list `t` in their dependencies,
 * so a translate function made anew on each render made every load re-render and load again, forever (about 100k
 * requests in 140 s from one open page). It follows `<html lang>`: a language switch re-renders with that
 * language's function.
 */

import { createContext, createElement, type ReactNode, useContext, useSyncExternalStore } from 'react';
import { createI18n, documentLocale, localeResources } from './index.js';

/** Translates a key of the module's own namespace; `has` says whether the key exists (in this language or `en`). */
export type Translate = ((key: string, options?: Record<string, unknown>) => string) & {
  has(key: string): boolean;
};
export interface ModuleT {
  t: Translate;
  /** the language `t` translates into (the app's language, as on `<html lang>`) */
  lang: string;
}

function subscribeLang(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  return () => mo.disconnect();
}
const readLang = () => documentLocale();

/** The app's language (`<html lang>`, resolved to a shipped locale); re-renders when it changes. */
export function useDocumentLang(): string {
  return useSyncExternalStore(subscribeLang, readLang, readLang);
}

/**
 * Plain words (FIRST-TIMER §3, W30): inside `<PlainWords on>` (the app wraps every Settings page in it while the
 * person's "Technical words" switch is off) a module's `t(key)` reads `<ns>:plain.<prefix><key>` when the module
 * ships that key ("MCP servers" reads "Apps helpers can use") and `<key>` otherwise. Outside it, or with `on` false,
 * strings are unchanged. The app's own translate hook follows the same scope.
 */
const PlainWordsCtx = createContext(false);
export function PlainWords({ on, children }: { on: boolean; children?: ReactNode }) {
  return createElement(PlainWordsCtx.Provider, { value: on }, children);
}
/** whether the strings around this component read their plain words (`<PlainWords on>`) */
export const usePlainScope = (): boolean => useContext(PlainWordsCtx);
/** `ns:a.b` -> `ns:plain.a.b`; a key already under `plain.` stays as it is */
export const plainKeyOf = (key: string): string => {
  const at = key.indexOf(':');
  const ns = at < 0 ? '' : key.slice(0, at + 1);
  const rest = at < 0 ? key : key.slice(at + 1);
  return rest.startsWith('plain.') ? key : `${ns}plain.${rest}`;
};

/** A module's strings, one ready translate function per language and wording (made on first use, then kept). */
export interface Translator {
  forLang(lang: string, plain?: boolean): ModuleT;
}

/**
 * A module's strings, made once at module level:
 * `const translations = moduleTranslator('inbox', import.meta.glob('../locales/*.json', { eager: true, import: 'default' }))`,
 * then read in components with `useModuleT(translations)`. `prefix` puts every key under a sub-tree (`brains.`
 * reads `ns:brains.<key>`).
 */
export function moduleTranslator(
  ns: string,
  files: Record<string, unknown>,
  { prefix = '' }: { prefix?: string } = {},
): Translator {
  const res = localeResources(ns, files);
  const byLang = new Map<string, ModuleT>();
  const forLang = (lang: string, plain = false): ModuleT => {
    const id = `${lang}\u0000${plain ? 'plain' : 'technical'}`;
    let m = byLang.get(id);
    if (!m) {
      const inst = createI18n(res, lang);
      // the options go to `exists` too: a plural plain key (`plain.x_one`, `plain.x_other`) exists only for a count
      const full = (key: string, options?: Record<string, unknown>) => {
        const k = `${ns}:${prefix}${key}`;
        if (!plain) return k;
        const p = `${ns}:plain.${prefix}${key}`;
        return !key.startsWith('plain.') && inst.exists(p, options) ? p : k;
      };
      const t = Object.assign(
        (key: string, options?: Record<string, unknown>) =>
          inst.t(full(key, options), options ?? {}) as string,
        { has: (key: string) => inst.exists(`${ns}:${prefix}${key}`) },
      );
      m = { t, lang };
      byLang.set(id, m);
    }
    return m;
  };
  return { forLang };
}

/**
 * The module's `{ t, lang }` in the app's language. The same object (and the same `t`) for as long as the language
 * stays, in every render and every component, so `t` is safe in any dependency list.
 */
export function useModuleT(translations: Translator): ModuleT {
  return translations.forLang(useDocumentLang(), usePlainScope());
}
