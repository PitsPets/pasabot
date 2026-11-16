/** Node-only helpers (kept out of the browser entry). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Resource } from 'i18next';
import { type LocaleTree, mergeLocaleFiles } from './index.js';

/** Server-side: read every `<root>/<group>/<id>/locales/*.json` from disk. */
export function loadLocaleDir(root: string): Resource {
  const files: Record<string, LocaleTree> = {};
  for (const group of ['packages', 'modules', 'plugins', 'channels', 'providers']) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const id of readdirSync(g)) {
      const dir = join(g, id, 'locales');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json'))
          files[`${group}/${id}/locales/${f}`] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      }
    }
  }
  return mergeLocaleFiles(files);
}
