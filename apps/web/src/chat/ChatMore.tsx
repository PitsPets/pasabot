/**
 * The chat's More menu (Simplify spec 2.1): "Edit Tala" first, then agent details, searching, and the module header
 * widgets that name a menu item (People in this chat, Who can use this agent...); on a phone also Settings. A widget
 * item opens its component in the menu's panel.
 */
import { Icon, Menu, type MenuItem } from '@pasabot/ui';
import { useCallback, useState } from 'react';
import { useT } from '../app/i18n.js';
import { navigate } from '../app/router.js';
import { slots } from '../app/slots.js';
import { chatAgentId, useStore } from '../app/store.js';
import { usePaused } from './Composer.js';

/** asks the stop control on screen (the safety module's top-bar item) to stop everything */
const STOP_EVENT = 'pasabot:stop-all';

export function ChatMore({
  chatId,
  onToggleDetails,
  testId = 'chat-more',
  phone = false,
}: {
  chatId: string;
  onToggleDetails(): void;
  testId?: string;
  /** the phone chat header's menu: it also links to Settings */
  phone?: boolean;
}) {
  const t = useT();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const agentId = useStore((s) => chatAgentId(s.chats[chatId]));
  const agentName = useStore((s) => (agentId ? s.agents[agentId]?.name : undefined));
  const paused = usePaused().stopped;
  const canStop = owner && slots.topBarItems.some((i) => i.id === 'safety-stop');
  const [panel, setPanel] = useState<string | null>(null);
  // stable, so it focuses once when the panel mounts and not again on every re-render (typing in the panel)
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), []);
  const widgets = slots.chatHeaderWidgets.filter((w) => w.labelKey);
  const canSearch = slots.routes.some((r) => r.path === '/search');
  const open = panel ? widgets.find((w) => w.id === panel) : undefined;
  const items: MenuItem[] = open
    ? []
    : [
        // the most wanted first: edit this agent (its brain, what it does), then its details
        ...(owner && agentId
          ? [
              {
                id: 'edit',
                icon: 'pencil',
                label: agentName ? t('chat.editNamed', { name: agentName }) : t('chat.editAgent'),
                onSelect: () => navigate(`/agents/${agentId}/edit`),
                testId: 'more-edit',
              },
            ]
          : []),
        ...(agentId
          ? [
              {
                id: 'details',
                icon: 'info',
                label: t('details.label'),
                onSelect: onToggleDetails,
                testId: 'more-details',
              },
            ]
          : []),
        ...(canSearch
          ? [{ id: 'search', icon: 'search', label: t('chat.searchThis'), href: `#/search?chat=${chatId}` }]
          : []),
        ...widgets.map((w) => ({
          id: `w-${w.id}`,
          icon: w.icon ?? 'dot',
          label: t(w.labelKey!),
          keepOpen: true,
          onSelect: () => setPanel(w.id),
          testId: `more-${w.id}`,
        })),
        // stopping is always one step away, even while the top-bar button is calm or hidden (also Ctrl/⌘ + Shift + .)
        ...(canStop && !paused
          ? [
              {
                id: 'stop-all',
                icon: 'stop',
                label: t('chat.stopAll'),
                onSelect: () => window.dispatchEvent(new CustomEvent(STOP_EVENT)),
                testId: 'more-stop-all',
              },
            ]
          : []),
        // a phone chat has no sidebar: Settings is one tap away from here
        ...(phone
          ? [
              {
                id: 'settings',
                icon: 'settings',
                label: t('nav.settings'),
                href: '#/settings',
                testId: 'more-settings',
              },
            ]
          : []),
      ];
  return (
    <Menu
      label={t('chat.more')}
      triggerTitle={t('chat.more')}
      trigger={<Icon name="more" />}
      items={items}
      testId={testId}
      triggerTestId={`${testId}-btn`}
      onOpenChange={(v) => {
        if (!v) setPanel(null);
      }}
    >
      {open
        ? () => {
            const C = open.component;
            return (
              <div className="more-panel">
                <button
                  type="button"
                  className="bk-menu__item"
                  onClick={() => setPanel(null)}
                  // the item that opened the panel is gone: focus lands on the panel's way back, never on <body>
                  ref={focusOnMount}
                  data-testid="more-panel-back"
                >
                  <Icon name="back" />
                  <span className="bk-menu__label">{t(open.labelKey!)}</span>
                </button>
                <div className="more-panel-body">
                  <C chatId={chatId} />
                </div>
              </div>
            );
          }
        : undefined}
    </Menu>
  );
}
