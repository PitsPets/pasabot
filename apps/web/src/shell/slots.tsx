/**
 * Slot renderer: the shell renders every slot every WebModule fills. Layout and styling belong to W0b's shell;
 * this file only decides *what* is rendered for each slot.
 */
import {
  type ApprovalPreview,
  type BlockRenderer,
  type ComposerAction,
  type DecisionItem,
  type DecisionSource,
  type DockPanel,
  type HeaderWidget,
  type MessageFooter,
  type NavItem,
  type OnboardingStep,
  type RouteDef,
  type RunEventRenderer,
  roleAllows,
  type SettingsSection,
  type TopBarItem,
  type UserRole,
  type WebModule,
} from '@pasabot/core/web';
import type { MessageBlock, MessageDTO, RunEventDTO } from '@pasabot/protocol';
import { useEffect } from 'react';

const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 500) - (b.order ?? 500);

export interface SlotIndex {
  routes: RouteDef[];
  navItems: NavItem[];
  settingsSections: SettingsSection[];
  blockRenderers: Map<string, BlockRenderer>;
  composerActions: ComposerAction[];
  chatHeaderWidgets: HeaderWidget[];
  runEventRenderers: Map<string, RunEventRenderer>;
  messageFooters: MessageFooter[];
  dockPanels: DockPanel[];
  onboardingSteps: OnboardingStep[];
  topBarItems: TopBarItem[];
  decisionSources: DecisionSource[];
  /** W16: tool name → its approval card's preview (first registration wins) */
  approvalPreviews: Map<string, ApprovalPreview>;
}

/** Flatten all modules' slots into one index (first registration of a block/run-event key wins). */
export function indexSlots(mods: WebModule[]): SlotIndex {
  const idx: SlotIndex = {
    routes: [],
    navItems: [],
    settingsSections: [],
    blockRenderers: new Map(),
    composerActions: [],
    chatHeaderWidgets: [],
    runEventRenderers: new Map(),
    messageFooters: [],
    dockPanels: [],
    onboardingSteps: [],
    topBarItems: [],
    decisionSources: [],
    approvalPreviews: new Map(),
  };
  for (const m of mods) {
    idx.routes.push(...(m.routes ?? []));
    idx.navItems.push(...(m.navItems ?? []));
    idx.settingsSections.push(...(m.settingsSections ?? []));
    for (const [k, r] of Object.entries(m.messageBlockRenderers ?? {}))
      if (!idx.blockRenderers.has(k)) idx.blockRenderers.set(k, r);
    idx.composerActions.push(...(m.composerActions ?? []));
    idx.chatHeaderWidgets.push(...(m.chatHeaderWidgets ?? []));
    for (const [k, r] of Object.entries(m.runEventRenderers ?? {}))
      if (!idx.runEventRenderers.has(k)) idx.runEventRenderers.set(k, r);
    idx.messageFooters.push(...(m.messageFooters ?? []));
    idx.dockPanels.push(...(m.dockPanels ?? []));
    idx.onboardingSteps.push(...(m.onboardingSteps ?? []));
    idx.topBarItems.push(...(m.topBarItems ?? []));
    idx.decisionSources.push(...(m.decisionSources ?? []));
    for (const [k, r] of Object.entries(m.approvalPreviews ?? {}))
      if (!idx.approvalPreviews.has(k)) idx.approvalPreviews.set(k, r);
  }
  idx.topBarItems.sort(byOrder);
  idx.navItems.sort(byOrder);
  idx.settingsSections.sort(byOrder);
  idx.onboardingSteps.sort((a, b) => a.order - b.order);
  return idx;
}

/** The signed-in viewer's role; null while unknown (shows owner-only entries to nobody). */
export type ViewerRole = UserRole | null | undefined;

/** Nav entries this role may use (absent `roles` = owner only, W39). */
export const navFor = (slots: SlotIndex, role: ViewerRole) =>
  slots.navItems.filter((n) => roleAllows(n.roles, role));
export const settingsFor = (slots: SlotIndex, role: ViewerRole) =>
  slots.settingsSections.filter((s) => roleAllows(s.roles, role));
export const decisionSourcesFor = (slots: SlotIndex, role: ViewerRole) =>
  slots.decisionSources.filter((s) => roleAllows(s.roles, role));

/**
 * A module page. With `viewer` given (the signed-in shell), a page the role may not open renders `denied` instead
 * (a public page is open to everyone); without it, the page renders as is.
 */
export function ModuleRoute({
  slots,
  path,
  viewer: role,
  denied = null,
}: {
  slots: SlotIndex;
  path: string;
  viewer?: ViewerRole;
  denied?: React.ReactNode;
}) {
  const r = slots.routes.find((x) => x.path === path);
  if (!r) return null;
  if (role !== undefined && !r.public && !roleAllows(r.roles, role)) return <>{denied}</>;
  const C = r.component;
  return <C />;
}

/** Calls one module's decision hook and reports its items up (one probe per source keeps hook order stable). */
function DecisionProbe({
  source,
  report,
}: {
  source: DecisionSource;
  report(id: string, items: DecisionItem[]): void;
}) {
  const items = source.useItems();
  const key = items.map((i) => `${i.id}\u0000${i.title}\u0000${i.text ?? ''}`).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-reports only when the items change
  useEffect(() => report(source.id, items), [key, source.id, report]);
  useEffect(() => () => report(source.id, []), [source.id, report]);
  return null;
}

/** Every module decision source this role may see, reporting into `report` (renders nothing itself). */
export function DecisionSourceSlots({
  slots,
  viewer: role,
  report,
}: {
  slots: SlotIndex;
  viewer: ViewerRole;
  report(id: string, items: DecisionItem[]): void;
}) {
  return (
    <>
      {decisionSourcesFor(slots, role).map((s) => (
        <DecisionProbe key={s.id} source={s} report={report} />
      ))}
    </>
  );
}

/** Unknown kinds render as a plain fallback card (ARCHITECTURE 2.1). */
export function MessageBlockView({
  slots,
  block,
  fallbackText,
}: {
  slots: SlotIndex;
  block: MessageBlock;
  fallbackText?: string;
}) {
  const R = slots.blockRenderers.get(block.kind);
  if (R) return <R block={block} />;
  return (
    <div data-block-fallback={block.kind} role="note">
      {fallbackText ?? block.kind}
    </div>
  );
}

export function RunEventView({ slots, event }: { slots: SlotIndex; event: RunEventDTO }) {
  const R = slots.runEventRenderers.get(event.type);
  return R ? <R event={event} /> : null;
}

/** Module footers under a message bubble (reactions, ...); nothing when no module fills the slot. */
export function MessageFooterSlots({ slots, message }: { slots: SlotIndex; message: MessageDTO }) {
  if (!slots.messageFooters.length) return null;
  return (
    <>
      {slots.messageFooters.map((f) => {
        const C = f.component;
        return <C key={f.id} message={message} />;
      })}
    </>
  );
}

export function SettingsSlots({ slots, viewer: role }: { slots: SlotIndex; viewer?: ViewerRole }) {
  const list = role === undefined ? slots.settingsSections : settingsFor(slots, role);
  return (
    <>
      {list.map((s) => {
        const C = s.component;
        return <C key={s.id} />;
      })}
    </>
  );
}

/** Header widgets that stay in the chat header; one with a `labelKey` is a More-menu item instead. */
export function HeaderWidgetSlots({ slots, chatId }: { slots: SlotIndex; chatId: string }) {
  return (
    <>
      {slots.chatHeaderWidgets
        .filter((w) => !w.labelKey)
        .map((w) => {
          const C = w.component;
          return <C key={w.id} chatId={chatId} />;
        })}
    </>
  );
}

/** Composer actions (voice, attach...) that bring their own component; renders nothing when no module has one. */
export function ComposerActionSlots({ slots, chatId }: { slots: SlotIndex; chatId: string }) {
  return (
    <>
      {slots.composerActions.map((a) => {
        const C = a.component;
        return C ? <C key={a.id} chatId={chatId} /> : null;
      })}
    </>
  );
}

export function DockPanelSlots({ slots }: { slots: SlotIndex }) {
  return (
    <>
      {slots.dockPanels.map((d) => {
        const C = d.component;
        return <C key={d.id} />;
      })}
    </>
  );
}

export function OnboardingSlots({ slots, next }: { slots: SlotIndex; next(): void }) {
  return (
    <>
      {slots.onboardingSteps.map((s) => {
        const C = s.component;
        return <C key={s.id} next={next} />;
      })}
    </>
  );
}

/** Module controls in the signed-in top bar (the W31 stop button); nothing when no module fills the slot. */
export function TopBarSlots({
  slots,
  compact,
  idle,
  hideIdle,
  viewer: role,
}: {
  slots: SlotIndex;
  compact?: boolean;
  /** nothing is working or waiting: a stop control is calm (or, with `hideIdle`, not drawn) */
  idle?: boolean;
  hideIdle?: boolean;
  viewer?: ViewerRole;
}) {
  const list =
    role === undefined ? slots.topBarItems : slots.topBarItems.filter((i) => roleAllows(i.roles, role));
  return (
    <>
      {list.map((i) => {
        const C = i.component;
        return <C key={i.id} compact={compact} idle={idle} hideIdle={hideIdle} />;
      })}
    </>
  );
}
