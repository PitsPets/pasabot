/**
 * @pasabot/core/web — the default export of modules/<id>/web/index.tsx (ARCHITECTURE.md 2.1).
 * Framework-neutral types: components are plain functions so this package has no React dependency;
 * the web shell renders them with React.
 */
import type { ApprovalDTO, MessageBlock, MessageDTO, RunEventDTO } from '@pasabot/protocol';

export type Component<P = object> = (props: P) => any;

/**
 * Who a slot entry is for (W39). Leaving `roles` out means **owner only**: members and guests are lesser roles
 * (ARCHITECTURE 3.1) and only see the nav entries, pages, settings and top-bar controls a module opens to them.
 * The server still checks every call; this only keeps forms a person cannot use out of their way.
 */
export type UserRole = 'owner' | 'member' | 'guest';
/** True when `role` may see an entry with these `roles` (absent = owner only; a signed-out viewer sees none). */
export const roleAllows = (roles: readonly UserRole[] | undefined, role: UserRole | null | undefined) =>
  !!role && (roles ?? ['owner']).includes(role);

export interface RouteDef {
  /** app path, e.g. '/example' */
  path: string;
  component: Component;
  titleKey?: string;
  /**
   * Also reachable signed out (W23: an invite's accept page). Such a page gets no session: it may only call the
   * module's `publicHttp` routes. Core paths (`/setup`, `/login`, `/pair`) cannot be taken.
   */
  public?: boolean;
  /** signed-in roles that may open the page (absent = owner only; others get a plain "owner only" note) */
  roles?: UserRole[];
  /**
   * Full screen: the signed-in shell draws none of its own chrome around the page (no top bar, chats list or
   * details), for a focused flow such as the team builder's first-run Stage. The page brings its own way out.
   */
  bare?: boolean;
}
/**
 * The 12 Settings groups every feature lives in (Simplify spec 3.3). The signed-in shell shows only the chats list
 * and the open chat; every module page and settings section is a feature row in one of these groups (anything
 * without `group` lands in `advanced`), and a person may pin a feature to the sidebar.
 */
export const SETTINGS_GROUPS = [
  'agents',
  'tools',
  'automations',
  'safety',
  'spending',
  'people',
  'machines',
  'shopping',
  'inbox',
  'memory',
  'look',
  'advanced',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/**
 * Feature ids the owner can never hide ("Not using this", Simplify spec 4.2), shared by the server's
 * `PUT /api/v1/settings/features` (refused) and the web catalog (never optional) so the two cannot disagree. A slot
 * entry with `optional: false`, and every entry in the `safety` and `advanced` groups, has its feature id here
 * (the web catalog test checks it against every module, plugin and provider).
 */
export const NEVER_HIDDEN_FEATURES: readonly string[] = [
  // core
  'agents',
  'trust',
  'always-asks',
  'devices',
  'language',
  'look',
  'hidden-features',
  'reset-sidebar',
  'this-computer',
  'settings',
  'account',
  // modules, plugins and providers that say `optional: false` or sit in safety / advanced
  'acp-agents',
  'admin',
  'agentchat-bridge',
  'brains',
  'local',
  'memory',
  'procs',
  'provider-ops',
  'provider-ops-settings',
  'push',
  'safety',
  'search',
  'vault',
];

/**
 * Feature ids a member or guest may see, with the roles their slot entry declares (every other feature is owner
 * only, the slots' own default). The server checks pins (`ui.pins`) and the hidden list it hands out against this,
 * so a member can never store or learn an owner-only feature id; the web catalog test checks it against every
 * module, plugin and provider so the two cannot drift.
 */
export const SHARED_FEATURE_ROLES: Readonly<Record<string, readonly UserRole[]>> = {
  agents: ['owner', 'member'],
  devices: ['owner', 'member', 'guest'],
  language: ['owner', 'member', 'guest'],
  look: ['owner', 'member', 'guest'],
  'reset-sidebar': ['owner', 'member', 'guest'],
  people: ['owner', 'member', 'guest'],
  push: ['owner', 'member', 'guest'],
  search: ['owner', 'member', 'guest'],
};
/** True when `role` may see the feature `id` by the shared rule above (unknown ids: owner only). */
export const featureAllows = (id: string, role: UserRole | null | undefined) =>
  roleAllows(Object.hasOwn(SHARED_FEATURE_ROLES, id) ? SHARED_FEATURE_ROLES[id] : undefined, role);

/** Where a nav entry or settings section sits in Settings, and how it is drawn (shared by both slots). */
export interface FeaturePlacement {
  /**
   * Icon name from `@pasabot/ui`'s icon registry (`ICON_NAMES`: `clock`, `inbox`, `shield`...); an unknown name
   * falls back to a dot. Shown beside the label on every row, pin and page header.
   */
  icon?: string;
  /** Settings group (absent = `advanced`) */
  group?: SettingsGroup;
  /**
   * The owner may hide it for everyone with "Not using this" (a UI hide only: the module keeps running). Default
   * `true`; the shell never offers it for the safety, agents, look and advanced groups.
   */
  optional?: boolean;
  /** i18n key of a one-line hint under the name in Settings (`<module>:<key>`) */
  hintKey?: string;
  /** i18n key of extra comma-separated search words for Settings search (`<module>:<key>`) */
  keywordsKey?: string;
  /**
   * Things of this feature that are still on (Simplify spec 4.2): the "Not using this" dialog asks `count()` and,
   * when it is above 0, warns with `labelKey` (`{count}`), e.g. "3 routines are still on and will keep running".
   * Hiding never stops them. A failing `count()` shows no warning.
   */
  active?: { count(): Promise<number>; labelKey: string };
  /**
   * For technical setup only (W30): while the person's "Technical words" switch is off it is not listed in its group
   * (Settings › Advanced says one plain line instead) and its page asks to turn the switch on. It keeps working.
   */
  expert?: boolean;
}
export interface NavItem extends FeaturePlacement {
  id: string;
  /** i18n key, `<module>:<key>` */
  labelKey: string;
  to: string;
  order?: number;
  /** absent = owner only */
  roles?: UserRole[];
}
export interface SettingsSection extends FeaturePlacement {
  id: string;
  labelKey: string;
  component: Component;
  order?: number;
  /** absent = owner only */
  roles?: UserRole[];
}
export type BlockRenderer = Component<{ block: MessageBlock; message?: MessageDTO }>;
export interface ComposerAction {
  id: string;
  labelKey: string;
  icon?: string;
  component?: Component<{ chatId: string }>;
}
/**
 * A chat-header widget. The chat header keeps only the name and a More menu: a widget with a `labelKey` is a More
 * menu item (its `icon` + label) that opens `component` in the menu's panel; one without renders in the header.
 */
export interface HeaderWidget {
  id: string;
  component: Component<{ chatId: string }>;
  /** icon name from the `@pasabot/ui` registry, for its More menu item */
  icon?: string;
  /** i18n key of its More menu item; set = shown from the More menu instead of in the header */
  labelKey?: string;
}
export type RunEventRenderer = Component<{ event: RunEventDTO }>;
/**
 * W16: a small picture inside the approval card of one tool's call (key = the tool name, e.g. `computer_click`):
 * where it will click, what it will type. Gets the approval as the server stored it (inputs already redacted).
 */
export type ApprovalPreview = Component<{ approval: ApprovalDTO }>;
/** Shown under every person's and agent's message bubble (reactions, read marks, ...). */
export interface MessageFooter {
  id: string;
  component: Component<{ message: MessageDTO }>;
}
export interface DockPanel {
  id: string;
  labelKey: string;
  component: Component;
}
/** A control in the signed-in top bar on every screen (desktop and phone), e.g. the W31 stop button. */
export interface TopBarItem {
  id: string;
  order?: number;
  /**
   * `compact`: the phone header; `idle`: nothing is working or waiting (a stop button is calm, not red); `hideIdle`:
   * draw nothing while idle (the phone chat header), but stay mounted
   */
  component: Component<{ compact?: boolean; idle?: boolean; hideIdle?: boolean }>;
  /** absent = owner only */
  roles?: UserRole[];
}
/**
 * One pending owner decision a module contributes to the single pinned decision bar (W39): a budget cap card, a
 * skill-permission proposal, ... Approvals of runs and workflows come from core and are not repeated here.
 * `title` is already in the viewer's language. `review` renders the decision in the bar's Review list
 * (answerable there); `href` (an in-app `#/...` path) opens the module's own place for it.
 */
export interface DecisionItem {
  id: string;
  title: string;
  text?: string;
  href?: string;
  review?: Component;
  /** sorts the Review list (earliest first); absent sorts last */
  at?: number;
}
export interface DecisionSource {
  id: string;
  /**
   * A React hook (the shell calls it from its own component, once per render, in a stable order): the module's
   * pending decisions, kept fresh by the module (live events or polling). Called only for roles in `roles`.
   */
  useItems(): DecisionItem[];
  /** absent = owner only */
  roles?: UserRole[];
}
export interface OnboardingStep {
  id: string;
  order: number;
  component: Component<{ next(): void }>;
}

export interface WebModule {
  id: string;
  routes?: RouteDef[];
  navItems?: NavItem[];
  settingsSections?: SettingsSection[];
  /** key = `<module>.<kind>`, must match a server BlockKind */
  messageBlockRenderers?: Record<`${string}.${string}`, BlockRenderer>;
  composerActions?: ComposerAction[];
  chatHeaderWidgets?: HeaderWidget[];
  runEventRenderers?: Record<string, RunEventRenderer>;
  messageFooters?: MessageFooter[];
  dockPanels?: DockPanel[];
  /** ordered by `order`; core contributes the owner-setup step */
  onboardingSteps?: OnboardingStep[];
  /** the signed-in top bar, every screen; `compact` on the phone bar */
  topBarItems?: TopBarItem[];
  /** pending owner decisions for the one pinned decision bar on every screen (W39) */
  decisionSources?: DecisionSource[];
  /** W16: per tool name, a preview inside that tool's approval card */
  approvalPreviews?: Record<string, ApprovalPreview>;
}
export const defineWebModule = (m: WebModule) => m;

/**
 * Every slot a WebModule can fill (the shell renders each one). Live events the shell does not handle itself
 * (module events, `reaction.changed`) are re-dispatched on `window` as `CustomEvent('pasabot:event',
 * { detail: { type, data } })` for module components.
 */
export const LIVE_EVENT = 'pasabot:event';

export const WEB_SLOTS = [
  'routes',
  'navItems',
  'settingsSections',
  'messageBlockRenderers',
  'composerActions',
  'chatHeaderWidgets',
  'runEventRenderers',
  'messageFooters',
  'dockPanels',
  'onboardingSteps',
  'topBarItems',
  'decisionSources',
  'approvalPreviews',
] as const satisfies readonly (keyof WebModule)[];
export type WebSlot = (typeof WEB_SLOTS)[number];
