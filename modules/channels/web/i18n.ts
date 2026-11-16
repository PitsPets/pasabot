/**
 * Module-local translations: the module's own locale files, in the language the shell set on <html lang>.
 * (Module web code imports only @pasabot/ui, @pasabot/protocol and @pasabot/i18n.)
 */

import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { useCallback, useSyncExternalStore } from 'react';

const translations = moduleTranslator(
  'channels',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
export function useT() {
  return useModuleT(translations).t;
}

/** The person's "Technical words" switch (mirrored on `<html data-advanced>`, `pasabot:advanced` on change). */
export function useTechnical(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
    () => false,
  );
}

const MISSING = '\u0000';
/**
 * `useT` in plain words while "Technical words" is off: a key reads `plain.<key>` when this module ships it ("Bot
 * token" -> "Secret code from the app"), else `<key>`; with the switch on, always `<key>`.
 */
export function useW(): (key: string, opts?: Record<string, unknown>) => string {
  const t = useT();
  const tech = useTechnical();
  return useCallback(
    (key: string, opts?: Record<string, unknown>) => {
      if (tech) return t(key, opts);
      const v = t(`plain.${key}`, { ...opts, defaultValue: MISSING });
      return v === MISSING ? t(key, opts) : v;
    },
    [t, tech],
  );
}
