/**
 * The Settings catalog (Simplify spec 3.3): every feature that is not a chat, from the module slots (nav items =
 * pages, settings sections) plus the core ones, each in one of the 12 groups with its icon. A nav item and a
 * section with the same id and group are one feature (the page, then the section). Role rules are the slots' own
 * (`roles` absent = owner only); the owner's hidden list removes optional features from lists and pins.
 */
import {
  type FeaturePlacement,
  NEVER_HIDDEN_FEATURES,
  roleAllows,
  SETTINGS_GROUPS,
  type SettingsGroup,
  type SettingsSection,
  type UserRole,
} from '@pasabot/core/web';
import type { SlotIndex, ViewerRole } from '../shell/slots.js';

export type CoreFeature =
  | 'agents'
  | 'trust'
  | 'always-asks'
  | 'devices'
  | 'language'
  | 'look'
  | 'hidden-features'
  | 'reset-sidebar'
  | 'this-computer';

export interface Feature {
  id: string;
  labelKey: string;
  /** the technical label key while a plain one shows (Technical words off): search still finds it by that name */
  techLabelKey?: string;
  icon: string;
  group: SettingsGroup;
  /** the owner may hide it ("Not using this") */
  optional: boolean;
  /** who may see it (absent = owner only) */
  roles?: UserRole[];
  /** module page path (`/routines`); the feature's link is then the page's own route */
  to?: string;
  /** module settings sections shown on the feature page (after the page, if any) */
  sections: SettingsSection[];
  core?: CoreFeature;
  hintKey?: string;
  keywordsKey?: string;
  /** what is still on (the hide dialog warns that it keeps running) */
  active?: FeaturePlacement['active'];
  /** technical setup only: listed (and opened) only with Technical words on (`FeaturePlacement.expert`) */
  expert?: boolean;
  order: number;
}

export const GROUP_ICONS: Record<SettingsGroup, string> = {
  agents: 'agent',
  tools: 'tools',
  automations: 'clock',
  safety: 'shield',
  spending: 'wallet',
  people: 'users',
  machines: 'server',
  shopping: 'bag',
  inbox: 'inbox',
  memory: 'archive',
  look: 'globe',
  advanced: 'sliders',
};
/**
 * Settings lists all 12 groups, always (owner update, polish build notes 3), in three sections by how often a
 * first-timer needs them. Role rules and "no visible features" still leave a group out; nothing else hides one.
 */
export type SettingsSectionId = 'everyday' | 'helpers' | 'own';
export const GROUP_SECTIONS: readonly { id: SettingsSectionId; groups: readonly SettingsGroup[] }[] = [
  { id: 'everyday', groups: ['agents', 'safety', 'people', 'look'] },
  { id: 'helpers', groups: ['tools', 'inbox', 'shopping', 'memory'] },
  { id: 'own', groups: ['automations', 'spending', 'machines', 'advanced'] },
];
/** every group in the order Settings lists them */
export const GROUP_ORDER: readonly SettingsGroup[] = GROUP_SECTIONS.flatMap((s) => s.groups);
/** groups whose features never hide (spec 4.2) */
const NEVER_HIDE: ReadonlySet<SettingsGroup> = new Set(['safety', 'advanced']);
const ALL: UserRole[] = ['owner', 'member', 'guest'];

const CORE: Feature[] = [
  {
    id: 'agents',
    core: 'agents',
    labelKey: 'web:features.agents',
    hintKey: 'web:features.agentsHint',
    icon: 'agent',
    group: 'agents',
    optional: false,
    roles: ['owner', 'member'],
    sections: [],
    order: 10,
  },
  {
    id: 'trust',
    core: 'trust',
    labelKey: 'web:settings.newAgents',
    icon: 'shield',
    group: 'safety',
    optional: false,
    sections: [],
    order: 30,
  },
  {
    id: 'always-asks',
    core: 'always-asks',
    labelKey: 'web:settings.alwaysAsks',
    icon: 'hand',
    group: 'safety',
    optional: false,
    sections: [],
    order: 40,
  },
  {
    id: 'devices',
    core: 'devices',
    labelKey: 'web:nav.devices',
    icon: 'device',
    group: 'people',
    optional: false,
    roles: ALL,
    to: '/devices',
    sections: [],
    order: 700,
  },
  {
    id: 'language',
    core: 'language',
    labelKey: 'web:settings.language',
    hintKey: 'web:settings.languageHint',
    icon: 'globe',
    group: 'look',
    optional: false,
    roles: ALL,
    sections: [],
    order: 10,
  },
  {
    id: 'look',
    core: 'look',
    labelKey: 'web:account.look',
    icon: 'sun-moon',
    group: 'look',
    optional: false,
    roles: ALL,
    sections: [],
    order: 20,
  },
  {
    id: 'this-computer',
    core: 'this-computer',
    labelKey: 'web:system.pageTitle',
    hintKey: 'web:system.pageHint',
    icon: 'server',
    group: 'advanced',
    optional: false,
    sections: [],
    order: 100,
  },
  {
    id: 'hidden-features',
    core: 'hidden-features',
    labelKey: 'web:settings.notUsing',
    icon: 'eye-off',
    group: 'advanced',
    optional: false,
    sections: [],
    order: 900,
  },
  {
    id: 'reset-sidebar',
    core: 'reset-sidebar',
    labelKey: 'web:settings.resetSidebar',
    hintKey: 'web:settings.resetSidebarHint',
    icon: 'pin',
    group: 'advanced',
    optional: false,
    roles: ALL,
    sections: [],
    order: 950,
  },
];

const groupOf = (g: string | undefined): SettingsGroup =>
  g && (SETTINGS_GROUPS as readonly string[]).includes(g) ? (g as SettingsGroup) : 'advanced';

export function buildCatalog(slots: SlotIndex): Feature[] {
  const out: Feature[] = CORE.map((f) => ({ ...f, sections: [] }));
  const byId = new Map(out.map((f) => [f.id, f]));
  for (const n of slots.navItems) {
    const group = groupOf(n.group);
    const f: Feature = {
      id: n.id,
      labelKey: n.labelKey,
      icon: n.icon ?? 'dot',
      group,
      optional: n.optional ?? true,
      roles: n.roles,
      to: n.to,
      sections: [],
      hintKey: n.hintKey,
      keywordsKey: n.keywordsKey,
      active: n.active,
      expert: n.expert,
      order: n.order ?? 500,
    };
    if (byId.has(f.id)) f.id = `${f.id}-page`;
    byId.set(f.id, f);
    out.push(f);
  }
  for (const s of slots.settingsSections) {
    const group = groupOf(s.group);
    const same = byId.get(s.id);
    if (same && !same.core && same.group === group) {
      same.sections.push(s);
      same.active ??= s.active;
      same.expert ||= s.expert;
      continue;
    }
    const id = same ? `${s.id}-settings` : s.id;
    const f: Feature = {
      id,
      labelKey: s.labelKey,
      icon: s.icon ?? 'dot',
      group,
      optional: s.optional ?? true,
      roles: s.roles,
      sections: [s],
      hintKey: s.hintKey,
      keywordsKey: s.keywordsKey,
      active: s.active,
      expert: s.expert,
      order: s.order ?? 500,
    };
    byId.set(id, f);
    out.push(f);
  }
  for (const f of out)
    if (NEVER_HIDE.has(f.group) || NEVER_HIDDEN_FEATURES.includes(f.id)) f.optional = false;
  return out.sort((a, b) => a.order - b.order);
}

/** Features this role may see; the owner's hidden ones only with `withHidden`. */
export function visibleFeatures(
  cat: Feature[],
  role: ViewerRole,
  hidden: readonly string[],
  withHidden = false,
): Feature[] {
  const gone = new Set(hidden);
  return cat.filter((f) => roleAllows(f.roles, role) && (withHidden || !f.optional || !gone.has(f.id)));
}

export const isHidden = (f: Feature, hidden: readonly string[]) => f.optional && hidden.includes(f.id);

export const featureHref = (f: Feature) => (f.to ? `#${f.to}` : `#/settings/${f.group}/${f.id}`);

export interface SettingsPlace {
  group: SettingsGroup | null;
  feature: Feature | null;
}
/**
 * Where a route sits in Settings: `/settings`, `/settings/<group>`, `/settings/<group>/<feature>`, or a feature's
 * own page (`/routines`, `/devices`), which opens inside Settings with its group selected. null = not Settings.
 */
export function settingsPlace(path: string, cat: Feature[]): SettingsPlace | null {
  if (path === '/settings' || path === '/menu') return { group: null, feature: null };
  const m = /^\/settings\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (m) {
    const group = (SETTINGS_GROUPS as readonly string[]).includes(m[1]!) ? (m[1] as SettingsGroup) : null;
    if (!group) return { group: null, feature: null };
    const feature = m[2] ? (cat.find((f) => f.id === m[2] && f.group === group) ?? null) : null;
    return { group, feature };
  }
  const page = cat.find((f) => f.to === path);
  return page ? { group: page.group, feature: page } : null;
}
