/**
 * Web module discovery: every `modules/*\/web/index.tsx`, `plugins/*\/web/index.tsx` and `providers/*\/web/index.tsx`
 * (a provider package that is also a module, e.g. W34's owner-configured local models) is found by
 * import.meta.glob (no registry file), and every `locales/{en,fil}.json` is merged under its folder's namespace.
 */
import type { WebModule } from '@pasabot/core/web';
import { mergeLocaleFiles, type Resource } from '@pasabot/i18n';

type Glob = Record<string, { default: WebModule }>;

/** Validate and order discovered web modules (by id). Throws on duplicate ids or malformed block keys. */
export function collectWebModules(found: Glob): WebModule[] {
  const seen = new Set<string>();
  const out: WebModule[] = [];
  for (const [path, mod] of Object.entries(found)) {
    const m = mod.default;
    if (!m || typeof m.id !== 'string') throw new Error(`${path}: default export is not a WebModule`);
    if (seen.has(m.id)) throw new Error(`duplicate web module id "${m.id}"`);
    seen.add(m.id);
    for (const key of Object.keys(m.messageBlockRenderers ?? {})) {
      if (!key.startsWith(`${m.id}.`))
        throw new Error(`${m.id}: block renderer "${key}" must be "${m.id}.<kind>"`);
    }
    out.push(m);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Sample modules (`modules/_*`) prove the slots in tests and dev; a production build never shows them. */
const isSample = (path: string) => /\/modules\/_[^/]+\//.test(path);

export function loadWebModules(): WebModule[] {
  const found: Glob = {
    ...(import.meta.glob('../../../../modules/*/web/index.tsx', { eager: true }) as Glob),
    ...(import.meta.glob('../../../../plugins/*/web/index.tsx', { eager: true }) as Glob),
    ...(import.meta.glob('../../../../providers/*/web/index.tsx', { eager: true }) as Glob),
  };
  const shown = import.meta.env.PROD
    ? Object.fromEntries(Object.entries(found).filter(([path]) => !isSample(path)))
    : found;
  return collectWebModules(shown);
}

export function loadWebLocales(): Resource {
  return mergeLocaleFiles({
    ...(import.meta.glob('../../../../packages/i18n/locales/*.json', { eager: true }) as Record<
      string,
      never
    >),
    ...(import.meta.glob('../../../../modules/*/locales/*.json', { eager: true }) as Record<string, never>),
    ...(import.meta.glob('../../../../plugins/*/locales/*.json', { eager: true }) as Record<string, never>),
    ...(import.meta.glob('../../../../providers/*/locales/*.json', { eager: true }) as Record<string, never>),
  });
}
