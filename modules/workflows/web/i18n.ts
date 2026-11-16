/**
 * Module-local translations: the module's own locale files, in the language the shell set on <html lang>.
 * (Module web code imports only @pasabot/ui, @pasabot/protocol and @pasabot/i18n.)
 */

import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

const translations = moduleTranslator(
  'workflows',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
export function useT() {
  return useModuleT(translations).t;
}
