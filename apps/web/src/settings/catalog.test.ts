/**
 * The Settings catalog built from every real web module, plugin and provider (sample modules left out): the
 * never-hideable features are exactly the shared list the server refuses to hide, and a deep link's feature keeps
 * its owner-only rule (the page checks it; members and guests never get it from the visible list).
 */
import { NEVER_HIDDEN_FEATURES, SHARED_FEATURE_ROLES, type WebModule } from '@pasabot/core/web';
import { describe, expect, it } from 'vitest';
import { collectWebModules } from '../shell/modules.js';
import { indexSlots } from '../shell/slots.js';
import { buildCatalog, settingsPlace, visibleFeatures } from './catalog.js';

type Glob = Record<string, { default: WebModule }>;
const found: Glob = {
  ...(import.meta.glob('../../../../modules/*/web/index.tsx', { eager: true }) as Glob),
  ...(import.meta.glob('../../../../plugins/*/web/index.tsx', { eager: true }) as Glob),
  ...(import.meta.glob('../../../../providers/*/web/index.tsx', { eager: true }) as Glob),
};
const real = Object.fromEntries(Object.entries(found).filter(([p]) => !/\/modules\/_[^/]+\//.test(p)));
const cat = buildCatalog(indexSlots(collectWebModules(real)));

describe('settings catalog', () => {
  it('every feature the owner cannot hide is on the list the server refuses, and nothing on it is optional', () => {
    // the real modules loaded (not an empty glob)
    expect(cat.some((f) => f.id === 'push') && cat.some((f) => f.id === 'routines')).toBe(true);
    const fixed = cat.filter((f) => !f.optional).map((f) => f.id);
    expect(fixed.filter((id) => !NEVER_HIDDEN_FEATURES.includes(id))).toEqual([]);
    expect(cat.filter((f) => f.optional && NEVER_HIDDEN_FEATURES.includes(f.id)).map((f) => f.id)).toEqual(
      [],
    );
  });

  it('owner-only core features resolve from a deep link but are never visible to a member or guest', () => {
    for (const path of [
      '/settings/safety/trust',
      '/settings/safety/always-asks',
      '/settings/advanced/hidden-features',
    ]) {
      const f = settingsPlace(path, cat)?.feature;
      expect(f, path).toBeTruthy();
      for (const role of ['member', 'guest'] as const)
        expect(visibleFeatures(cat, role, [], true).some((v) => v.id === f!.id)).toBe(false);
      expect(visibleFeatures(cat, 'owner', [], true).some((v) => v.id === f!.id)).toBe(true);
    }
  });

  it('the features a member or guest may see are exactly the shared list the server filters pins by', () => {
    const open = Object.fromEntries(
      cat
        .filter((f) => f.roles && f.roles.some((r) => r !== 'owner'))
        .map((f) => [f.id, [...f.roles!].sort()]),
    );
    const shared = Object.fromEntries(
      Object.entries(SHARED_FEATURE_ROLES).map(([id, r]) => [id, [...r].sort()]),
    );
    expect(shared).toEqual(open);
  });
});
