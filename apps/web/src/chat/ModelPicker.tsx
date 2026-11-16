/**
 * The chat header's model picker (polish direction B). One tap on the pill opens a popover under it (a bottom sheet
 * on a phone, both in a portal so nothing clips them): the brain's icon, the brains that are ready to switch to,
 * then "Automatic" first and the brain's models with plain hints and a tick on the chosen one. Picking a row saves
 * it on the agent (`PATCH /api/v1/agents/:id`, owner only on the server too) and closes. Everyone else sees the
 * same pill, read only. Keyboard: arrows move through the rows, Enter or Space picks, Escape closes and gives focus
 * back to the pill.
 */
import type { AgentDTO } from '@pasabot/protocol';
import { BrandTile, Icon, type IconName } from '@pasabot/ui';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { brainState, type ModelRow, useModels } from '../agents/BrainPicker.js';
import { api } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { type ProviderInfo, providerName, setState, useStore } from '../app/store.js';

const HINT_ICON: Record<NonNullable<ModelRow['hint']>, IconName> = {
  smartest: 'brain',
  smart: 'brain',
  balanced: 'gauge',
  fast: 'bolt',
  free: 'wallet',
};
const PHONE = '(max-width: 600px)';
type ModelList = ReturnType<typeof useModels>['list'];

export function ChatModelPicker({ agent }: { agent: AgentDTO }) {
  const t = useT();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const provider = useStore((s) => s.providers.find((p) => p.id === agent.providerId));
  const brain = provider ? providerName(t, provider) : agent.providerId;
  // the owner may ask a brain for its model names; everyone else reads the saved id
  const { list, reload } = useModels(owner ? agent.providerId : '');
  const models = list.state === 'ok' ? list.models : [];
  const modelLabel = agent.model
    ? (models.find((m) => m.id === agent.model)?.label ?? agent.model)
    : t('agents.modelAuto');
  const shortLabel = agent.model ? modelLabel : t('chat.model.auto');
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  // the test-only Fake brain is never offered to switch to (it shows only when the agent already runs on it)
  const providers = useStore((s) => s.providers);
  const others = useMemo(
    () => providers.filter((p) => p.id !== 'fake' || p.id === agent.providerId),
    [providers, agent.providerId],
  );
  const canSwitch = others.some((p) => p.id !== agent.providerId && brainState(p) === 'ready');
  // a brain that lists no models picks its own; with no other brain to switch to there is nothing to choose
  const nothing = list.state === 'none' && !canSwitch;
  const pill = (
    <>
      <BrandTile id={agent.providerId} size={28} fallback="brain" />
      <span className="mp-pill__t">
        <span className="mp-pill__k">{t('chat.model.thinksWith')}</span>
        <span className="mp-pill__v">{agent.model ? `${brain} · ${modelLabel}` : brain}</span>
      </span>
      <span className="mp-pill__short">{shortLabel}</span>
    </>
  );
  if (!owner)
    return (
      <span
        className="mp-pill mp-pill--ro"
        data-testid="model-pill"
        role="img"
        aria-label={t('chat.model.readOnly', { name: agent.name, brain, model: modelLabel })}
        title={t('chat.model.readOnly', { name: agent.name, brain, model: modelLabel })}
      >
        {pill}
      </span>
    );
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="mp-pill"
        data-testid="model-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('chat.model.change', { name: agent.name, brain, model: modelLabel })}
        title={nothing ? t('chat.model.own') : undefined}
        disabled={nothing}
        onClick={() => setOpen((v) => !v)}
      >
        {pill}
        <Icon name="chevron" size={16} className="mp-pill__chev" />
      </button>
      {open && (
        <ModelPopover
          agent={agent}
          anchor={btn}
          providers={others}
          initial={list}
          reloadInitial={reload}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

function usePhone() {
  const [phone, setPhone] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const m = matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

function ModelPopover({
  agent,
  anchor,
  providers,
  initial,
  reloadInitial,
  onClose,
}: {
  agent: AgentDTO;
  anchor: React.RefObject<HTMLButtonElement | null>;
  providers: ProviderInfo[];
  initial: ModelList;
  reloadInitial(): void;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const phone = usePhone();
  const pop = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const listId = useId();
  const [brainId, setBrainId] = useState(agent.providerId);
  // the agent's own brain: the list the pill already has (no reload, no flash); another brain: asked now
  const otherModels = useModels(brainId === agent.providerId ? '' : brainId);
  const list = brainId === agent.providerId ? initial : otherModels.list;
  const reload = brainId === agent.providerId ? reloadInitial : otherModels.reload;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // desktop: anchored under the pill, its end edge lined up with the pill's (kept inside the window)
  useLayoutEffect(() => {
    if (phone) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      const rtl = document.documentElement.dir === 'rtl';
      setPos({ top: r.bottom + 8, right: Math.max(8, rtl ? vw - r.left - 340 : vw - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [phone, anchor]);

  // Escape closes (focus back to the pill); a press outside closes without moving focus
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close.current(true);
    };
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (pop.current?.contains(n) || anchor.current?.contains(n)) return;
      close.current(false);
    };
    // following the "Set up another brain" link (or any other route change) closes it too
    const gone = () => close.current(false);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down);
    window.addEventListener('hashchange', gone);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('hashchange', gone);
    };
  }, [anchor]);

  const current = brainId === agent.providerId;
  const chosen = current ? (agent.model ?? '') : null;
  const models = list.state === 'ok' ? list.models : [];
  // the list could not be loaded: the saved model stays the one ticked row, and nothing else is offered for this
  // brain (a tap on "Automatic" would clear the agent's model without the owner seeing what it replaces)
  const failedOwn = current && list.state === 'error' && !!agent.model;
  // a model the agent runs on that the list no longer offers stays visible and ticked
  const rows: { id: string; label: string; hint: string; icon: IconName | null }[] = [
    ...(failedOwn
      ? []
      : [{ id: '', label: t('agents.modelAuto'), hint: t('chat.model.autoHint'), icon: null }]),
    ...models.map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      hint: m.hint ? t(`chat.model.hints.${m.hint}`) : '',
      icon: m.hint ? HINT_ICON[m.hint] : ('sparkle' as IconName),
    })),
    ...(current &&
    agent.model &&
    (list.state === 'ok' || list.state === 'error') &&
    !models.some((m) => m.id === agent.model)
      ? [{ id: agent.model, label: agent.model, hint: '', icon: 'sparkle' as IconName }]
      : []),
  ];
  const chosenAt = Math.max(
    0,
    rows.findIndex((r) => r.id === chosen),
  );
  const [active, setActive] = useState(chosenAt);
  const optId = (i: number) => `${listId}-o${i}`;
  // focus the list once it is there, so arrows work right away
  useEffect(() => {
    listRef.current?.focus();
  }, []);
  // the keyboard cursor starts on the ticked row, again when the list arrives or another brain is shown
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-syncs only when the brain or its list changes
  useEffect(() => setActive(chosenAt), [brainId, list.state]);

  const pick = async (model: string) => {
    if (busy) return;
    if (current && model === (agent.model ?? '')) return close.current(true);
    setBusy(true);
    setError(false);
    try {
      const r = await api<{ agent: AgentDTO }>(`/api/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: current ? { model: model || null } : { providerId: brainId, model: model || null },
      });
      setState((s) => ({ agents: { ...s.agents, [r.agent.id]: r.agent } }));
      close.current(true);
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = rows.length - 1;
    if (e.key === 'ArrowDown') setActive((i) => Math.min(last, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Enter' || e.key === ' ') {
      const r = rows[active];
      if (r) void pick(r.id);
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' });
  });

  const ready = providers.filter((p) => brainState(p) === 'ready' || p.id === agent.providerId);
  const body = (
    <div
      ref={pop}
      className={phone ? 'mp-pop mp-pop--sheet' : 'mp-pop'}
      role="dialog"
      aria-modal={phone || undefined}
      aria-labelledby={titleId}
      data-layer="popover"
      data-testid="model-popover"
      style={!phone && pos ? { top: pos.top, insetInlineEnd: pos.right } : undefined}
    >
      {phone && <span className="mp-grab" aria-hidden="true" />}
      <h2 id={titleId} className="mp-title">
        {t('chat.model.title', { name: agent.name })}
      </h2>
      {ready.length > 1 && (
        <fieldset className="mp-brains">
          <legend className="bk-visually-hidden">{t('chat.model.brain')}</legend>
          {ready.map((p) => (
            <button
              key={p.id}
              type="button"
              className="mp-brain"
              aria-pressed={brainId === p.id}
              data-testid={`model-brain-${p.id}`}
              onClick={() => {
                setBrainId(p.id);
                setError(false);
              }}
            >
              <BrandTile id={p.id} size={24} fallback="brain" />
              <span>{providerName(t, p)}</span>
            </button>
          ))}
        </fieldset>
      )}
      {ready.length <= 1 && (
        <p className="mp-one">
          <BrandTile id={brainId} size={32} fallback="brain" />
          <span>{ready[0] ? providerName(t, ready[0]) : brainId}</span>
        </p>
      )}
      <div
        ref={listRef}
        id={listId}
        className="mp-list"
        role="listbox"
        tabIndex={0}
        aria-label={t('chat.model.models')}
        aria-activedescendant={optId(active)}
        aria-busy={busy || list.state === 'loading' || undefined}
        onKeyDown={onKey}
        data-testid="model-list"
      >
        {rows.map((r, i) => {
          const on = r.id === chosen;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles keys (arrows, Enter, Space)
            <div
              key={r.id || 'auto'}
              id={optId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={on}
              className="mp-opt"
              data-active={i === active || undefined}
              data-testid={`model-row-${r.id || 'auto'}`}
              onClick={() => {
                setActive(i);
                void pick(r.id);
              }}
            >
              <span className="mp-opt__ic" aria-hidden="true">
                <Icon name={r.icon ?? 'sparkle'} size={18} />
              </span>
              <span className="mp-opt__t">
                <span className="mp-opt__n">
                  {r.label}
                  {r.id === '' && <span className="mp-best">{t('chat.model.best')}</span>}
                </span>
                {r.hint && <span className="mp-opt__h">{r.hint}</span>}
              </span>
              {on && <Icon name="check" size={20} className="mp-tick" />}
            </div>
          );
        })}
      </div>
      {list.state === 'loading' && (
        <p className="mp-note" role="status">
          {t('agents.modelsLoading')}
        </p>
      )}
      {list.state === 'none' && <p className="mp-note">{t('chat.model.own')}</p>}
      {list.state === 'error' && (
        <p className="mp-note mp-note--err" role="alert" data-testid="model-list-error">
          <span>{t('chat.model.error')}</span>{' '}
          <button type="button" className="mp-retry" data-testid="model-list-retry" onClick={() => reload()}>
            {t('chat.model.retry')}
          </button>
        </p>
      )}
      {error && (
        <p className="mp-note mp-note--err" role="alert">
          {t('errors.generic')}
        </p>
      )}
      <a className="mp-more" href="#/settings/agents/brains">
        <Icon name="plus" size={18} />
        <span>{t('chat.model.more')}</span>
      </a>
    </div>
  );
  return createPortal(
    <>
      {phone && <div className="mp-scrim" aria-hidden="true" />}
      {body}
    </>,
    document.body,
  );
}
