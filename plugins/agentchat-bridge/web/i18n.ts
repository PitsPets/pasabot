/**
 * Plugin-local translations: the plugin's own locale files, in the language the shell set on <html lang>.
 * (Plugin web code imports only @pasabot/ui, @pasabot/protocol and @pasabot/i18n.)
 */
import { createI18n, documentLocale, localeResources } from '@pasabot/i18n';
import { useEffect, useMemo, useState } from 'react';

const NS = 'agentchat-bridge';
const res = localeResources(NS, import.meta.glob('../locales/*.json', { eager: true, import: 'default' }));

const docLang = () => documentLocale();

export function useT() {
  const [lng, setLng] = useState(docLang);
  useEffect(() => {
    const mo = new MutationObserver(() => setLng(docLang()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => mo.disconnect();
  }, []);
  return useMemo(() => {
    const i = createI18n(res as never, lng);
    i.setDefaultNamespace(NS);
    return i.t.bind(i) as unknown as (k: string, o?: Record<string, unknown>) => string;
  }, [lng]);
}
