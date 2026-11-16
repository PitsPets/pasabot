/**
 * Settings, the home of every feature that is not a chat (Simplify spec 3): a searchable list of the 12 groups,
 * a group page with one row per feature (icon, name, hint, "Show in sidebar"), and the feature page (a module's
 * page and/or settings sections, or a core one) with a breadcrumb. The owner can hide an optional feature for
 * everyone ("Not using this", a UI hide only) and bring it back from Advanced. All 12 groups are always listed, in
 * three sections (polish B); the per-person "Technical words" switch changes wording (every feature page reads its
 * plain words inside `<PlainWords>` while it is off, W30) and keeps the few pages that are technical setup only
 * (`expert`) out of the lists behind one plain line in Advanced.
 */
import { roleAllows, type SettingsGroup } from '@pasabot/core/web';
import { PlainWords } from '@pasabot/i18n/react';
import type { TrustLevel } from '@pasabot/protocol';
import {
  AgentAvatar,
  Button,
  Icon,
  IconTile,
  ListRow,
  Segmented,
  Sheet,
  StatusChip,
  Switch,
} from '@pasabot/ui';
import { useEffect, useId, useMemo, useState } from 'react';
import { TrustNote } from '../agents/TrustNote.js';
import { api } from '../app/api.js';
import { LangToggle } from '../app/chrome.js';
import { useT } from '../app/i18n.js';
import { setAdvanced, setHidden, setPins, togglePin, usePrefs } from '../app/prefs.js';
import { navigate, useRoute } from '../app/router.js';
import { slots } from '../app/slots.js';
import { agentStatus, useStore } from '../app/store.js';
import { type Look, setLook, useLook } from '../app/theme.js';
import { usePlainFeature, usePlainWords, useWords } from '../app/words.js';
import { Devices } from '../auth/Devices.js';
import { SignOut } from '../chat/SignOut.js';
import { ModuleRoute, type ViewerRole } from '../shell/slots.js';
import { AppControls } from './AppControls.js';
import {
  buildCatalog,
  type Feature,
  featureHref,
  GROUP_ICONS,
  GROUP_SECTIONS,
  isHidden,
  type SettingsPlace,
  visibleFeatures,
} from './catalog.js';
import { ThisComputer } from './ThisComputer.js';

export const catalog = buildCatalog(slots);

export function useFeatures(withHidden = false) {
  const role = useStore((s) => s.me?.kind ?? null);
  const hidden = usePrefs((s) => s.hidden);
  const advanced = usePrefs((s) => s.advanced);
  const plain = usePlainFeature();
  return useMemo(
    () =>
      visibleFeatures(catalog, role, hidden, withHidden)
        .filter((f) => advanced || !f.expert)
        .map(plain),
    [role, hidden, withHidden, plain, advanced],
  );
}
/** whether this person has technical-setup pages that Technical words off keeps out of the lists */
function useExpertHidden(): boolean {
  const role = useStore((s) => s.me?.kind ?? null);
  const advanced = usePrefs((s) => s.advanced);
  return !advanced && catalog.some((f) => f.expert && roleAllows(f.roles, role));
}
/**
 * The sections and groups Settings lists: all 12 groups, always, each section with the groups this person has
 * something in (a role sees only its own features; a group with none is left out, and so is an empty section).
 */
export function useSections() {
  const list = useFeatures();
  return useMemo(
    () =>
      GROUP_SECTIONS.map((s) => ({
        id: s.id,
        groups: s.groups.filter((g) => list.some((f) => f.group === g)),
      })).filter((s) => s.groups.length > 0),
    [list],
  );
}

/** Settings search over group names, hints, feature names and their keywords (spec 3.1). */
function useSearch(q: string) {
  const t = useT();
  const list = useFeatures();
  return useMemo(() => {
    // every word must match somewhere (name, hint, keywords, group): "cron timer" finds Routines
    const terms = q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return list.filter((f) => {
      const words = [
        t(f.labelKey),
        // the technical name finds it too while the plain one shows ("mcp" finds "Apps and tools helpers can use")
        f.techLabelKey ? t(f.techLabelKey) : '',
        f.hintKey ? t(f.hintKey) : '',
        f.keywordsKey ? t(f.keywordsKey) : '',
        t(`web:groups.${f.group}.name`),
        t(`web:groups.${f.group}.hint`),
      ]
        .join(' ')
        .toLocaleLowerCase();
      return terms.every((w) => words.includes(w));
    });
  }, [q, list, t]);
}

function SearchField() {
  const t = useT();
  const route = useRoute();
  const q = route.query.get('q') ?? '';
  const id = useId();
  return (
    <div className="set-search">
      <label htmlFor={id} className="bk-visually-hidden">
        {t('settings.search')}
      </label>
      <Icon name="search" size={18} />
      <input
        id={id}
        className="bk-input"
        type="search"
        value={q}
        placeholder={t('settings.search')}
        onChange={(e) => {
          const v = e.target.value;
          navigate(v ? `/settings?q=${encodeURIComponent(v)}` : '/settings', true);
        }}
        data-testid="settings-search"
      />
    </div>
  );
}

/**
 * The groups in their three sections: the sidebar's compact rows (icon + name), or the home's rows with a one-line
 * hint (a list on a phone, a grid of tiles wider than that).
 */
function GroupRows({ current, compact }: { current?: SettingsGroup | null; compact?: boolean }) {
  const t = useT();
  const pw = usePlainWords();
  const sections = useSections();
  const id = useId();
  return (
    <div
      className={compact ? 'set-groups set-groups--nav' : 'set-groups'}
      data-testid={compact ? 'settings-groups' : 'settings-home-groups'}
    >
      {sections.map((s) => (
        <section key={s.id} className="set-sec" aria-labelledby={`${id}-${s.id}`}>
          <h3 className="set-sec-h" id={`${id}-${s.id}`}>
            {t(`settings.sections.${s.id}`)}
          </h3>
          <ul className="plain set-sec-list">
            {s.groups.map((g) => (
              <li key={g}>
                <ListRow
                  icon={GROUP_ICONS[g]}
                  label={pw(`groups.${g}.name`)}
                  hint={compact ? undefined : pw(`groups.${g}.hint`)}
                  href={`#/settings/${g}`}
                  current={current === g}
                  chevron={!compact}
                  testId={`settings-group-${g}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Desktop: the Settings list in place of the chats sidebar. */
export function SettingsNav({ place }: { place: SettingsPlace }) {
  const t = useT();
  return (
    <nav className="set-nav" aria-label={t('settings.title')}>
      <a className="set-back" href="#/">
        <Icon name="back" size={18} />
        <span>{t('settings.back')}</span>
      </a>
      <h2 className="set-nav-title">
        <Icon name="settings" />
        <span>{t('settings.title')}</span>
      </h2>
      <SearchField />
      <GroupRows current={place.group} compact />
    </nav>
  );
}

/** The center of every Settings route. */
export function SettingsPage({ place }: { place: SettingsPlace }) {
  const route = useRoute();
  const q = route.query.get('q') ?? '';
  if (q && !place.group) return <SearchResults q={q} />;
  if (place.feature) return <FeaturePage f={place.feature} />;
  if (place.group) return <GroupPage group={place.group} />;
  return <SettingsHome />;
}

function SettingsHome() {
  const t = useT();
  return (
    <div className="page set-page" data-testid="settings-home">
      <header className="set-head">
        <IconTile name="settings" size={40} />
        <div>
          <h1>{t('settings.title')}</h1>
          <p className="muted">{t('settings.intro')}</p>
        </div>
      </header>
      <div className="set-home-search">
        <SearchField />
      </div>
      <div className="set-home-groups">
        <GroupRows />
      </div>
      <TechnicalSwitch />
      <AppControls />
      <section className="bk-card panel set-account" aria-labelledby="set-acc">
        <h2 id="set-acc" className="row-ic">
          <Icon name="log-out" />
          <span>{t('settings.account')}</span>
        </h2>
        <SignOut />
      </section>
    </div>
  );
}

/**
 * "Technical words" (per person, off by default; pref `ui.advanced`): technical names instead of plain ones ("Trust
 * level", "MCP server"), tier numbers and the approval card's technical block. It hides no group and no page.
 */
function TechnicalSwitch() {
  const t = useT();
  const pw = usePlainWords();
  const advanced = usePrefs((s) => s.advanced);
  return (
    <section className="bk-card panel set-advanced" aria-labelledby="set-adv">
      <div className="set-advanced-row">
        <div>
          <h2 id="set-adv" className="row-ic">
            <Icon name="sliders" />
            <span>{t('settings.advancedSwitch')}</span>
          </h2>
          <p className="muted">{pw('settings.advancedHint')}</p>
        </div>
        <Switch
          checked={advanced}
          onChange={(v) => void setAdvanced(v)}
          label={advanced ? t('settings.switchOn') : t('settings.switchOff')}
          ariaLabel={t('settings.advancedSwitch')}
          testId="settings-advanced"
        />
      </div>
    </section>
  );
}

function SearchResults({ q }: { q: string }) {
  const t = useT();
  const pw = usePlainWords();
  const hits = useSearch(q);
  return (
    <div className="page set-page" data-testid="settings-results">
      <header className="set-head">
        <IconTile name="search" size={40} />
        <h1>{t('settings.title')}</h1>
      </header>
      <div className="set-home-search">
        <SearchField />
      </div>
      {hits.length === 0 ? (
        <p className="muted set-empty" role="status">
          <Icon name="search" />
          <span>{t('settings.searchEmpty', { q })}</span>
        </p>
      ) : (
        <ul className="plain bk-card set-card">
          {hits.map((f) => (
            <li key={f.id}>
              <ListRow
                icon={f.icon}
                label={t(f.labelKey)}
                hint={pw(`groups.${f.group}.name`)}
                href={featureHref(f)}
                testId={`settings-hit-${f.id}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PinSwitch({ f }: { f: Feature }) {
  const t = useT();
  const pinned = usePrefs((s) => s.pins.includes(f.id));
  const label = t(f.labelKey);
  return (
    <Switch
      checked={pinned}
      onChange={(v) => void togglePin(f.id, v)}
      label={t('settings.pin')}
      ariaLabel={t('settings.pinAria', { feature: label })}
      icon="pin"
      testId={`pin-${f.id}`}
    />
  );
}

function GroupPage({ group }: { group: SettingsGroup }) {
  const t = useT();
  const pw = usePlainWords();
  // every feature of the group in one list: nothing is folded away (Technical words only changes wording)
  const list = useFeatures().filter((f) => f.group === group);
  const expertHidden = useExpertHidden();
  const row = (f: Feature) => (
    <li key={f.id}>
      <ListRow
        icon={f.icon}
        label={t(f.labelKey)}
        hint={f.hintKey ? t(f.hintKey) : undefined}
        href={featureHref(f)}
        trailing={<PinSwitch f={f} />}
        testId={`feature-${f.id}`}
      />
    </li>
  );
  return (
    <div className="page set-page" data-testid={`settings-page-${group}`}>
      <a className="set-up" href="#/settings">
        <Icon name="back" size={18} />
        <span>{t('settings.title')}</span>
      </a>
      <header className="set-head">
        <IconTile name={GROUP_ICONS[group]} size={40} />
        <div>
          <h1>{pw(`groups.${group}.name`)}</h1>
          <p className="muted">{pw(`groups.${group}.hint`)}</p>
        </div>
      </header>
      {list.length === 0 ? (
        <p className="muted set-empty">
          <Icon name="eye-off" />
          <span>{t('settings.groupEmpty')}</span>
        </p>
      ) : (
        <ul className="plain bk-card set-card">{list.map(row)}</ul>
      )}
      {group === 'advanced' && expertHidden && (
        <p className="muted set-empty" data-testid="settings-technical-note">
          <Icon name="sliders" />
          <span>{t('settings.technicalOnly', { switch: t('settings.advancedSwitch') })}</span>
        </p>
      )}
    </div>
  );
}

function Crumbs({ f }: { f: Feature }) {
  const t = useT();
  const pw = usePlainWords();
  return (
    <nav className="set-crumbs" aria-label={t('settings.where')}>
      <a href="#/settings" className="set-up">
        <Icon name="back" size={18} />
        <span>{t('settings.title')}</span>
      </a>
      <span aria-hidden="true">›</span>
      <a href={`#/settings/${f.group}`}>{pw(`groups.${f.group}.name`)}</a>
      <span aria-hidden="true">›</span>
      <span className="set-crumb-here" aria-current="page">
        <Icon name={f.icon} size={18} />
        <span>{pw(f.labelKey)}</span>
      </span>
    </nav>
  );
}

function FeaturePage({ f }: { f: Feature }) {
  const role = useStore((s) => s.me?.kind ?? null);
  // a deep link resolves against the whole catalog: a feature this role may not see is a plain note, never its
  // forms (which would only fail) or a pin switch (spec rules 7 and 10)
  const advanced = usePrefs((s) => s.advanced);
  if (!roleAllows(f.roles, role)) return <OwnerOnlyPage />;
  if (f.expert && !advanced) return <TechnicalOnlyPage f={f} />;
  // every string of the page (core and module) reads its plain words while Technical words is off
  return (
    <PlainWords on={!advanced}>
      <AllowedFeaturePage f={f} role={role} />
    </PlainWords>
  );
}

/**
 * A technical-setup page (`expert`) while Technical words is off: one plain line and the switch, never its technical
 * forms rewritten into plain words that would not make sense. The page itself opens once the switch is on.
 */
function TechnicalOnlyPage({ f }: { f: Feature }) {
  const t = useT();
  const pw = usePlainWords();
  return (
    <div className="page set-page" data-feature={f.id} data-testid="settings-technical-only">
      <a className="set-up" href={`#/settings/${f.group}`}>
        <Icon name="back" size={18} />
        <span>{pw(`groups.${f.group}.name`)}</span>
      </a>
      <p className="muted set-empty" role="note">
        <Icon name="sliders" />
        <span>{t('settings.technicalOnlyPage', { switch: t('settings.advancedSwitch') })}</span>
      </p>
      <TechnicalSwitch />
    </div>
  );
}

function AllowedFeaturePage({ f, role }: { f: Feature; role: ViewerRole }) {
  const t = useT();
  const pw = usePlainWords();
  const owner = role === 'owner';
  const hidden = usePrefs((s) => s.hidden);
  const gone = isHidden(f, hidden);
  const sections = f.sections.filter((s) => (s.roles ?? ['owner']).includes(role ?? ('' as never)));
  return (
    <div className={f.to ? 'page set-page set-page--module' : 'page set-page'} data-feature={f.id}>
      <div className="set-feature-top">
        <Crumbs f={f} />
        <PinSwitch f={f} />
      </div>
      {gone && (
        <div className="set-hidden-note bk-card" role="note">
          <Icon name="eye-off" />
          <span>{t('settings.hiddenNote')}</span>
          {owner && (
            <Button size="sm" onClick={() => void setHidden(f.id, false)}>
              {t('settings.showAgain')}
            </Button>
          )}
        </div>
      )}
      {!f.to && (
        <header className="set-head">
          <IconTile name={f.icon} size={40} />
          <h1>{pw(f.labelKey)}</h1>
        </header>
      )}
      {f.to && f.core === 'devices' ? (
        <Devices />
      ) : f.to ? (
        <div className="set-module">
          <ModuleRoute slots={slots} path={f.to} viewer={role} denied={<OwnerOnlyPage />} />
        </div>
      ) : null}
      {f.core && <CoreBody f={f} role={role} />}
      {sections.map((s) => {
        const C = s.component;
        return (
          <div key={s.id} className="set-section" data-settings-section={s.id}>
            <C />
          </div>
        );
      })}
      {owner && f.optional && !gone && <HideFeature f={f} />}
    </div>
  );
}

function CoreBody({ f, role }: { f: Feature; role: ViewerRole }) {
  const t = useT();
  switch (f.core) {
    case 'agents':
      return <Roster />;
    case 'trust':
      return <NewAgentTrust />;
    case 'always-asks':
      return <AlwaysAsks />;
    case 'language':
      return (
        <section className="bk-card panel" aria-label={t('settings.language')}>
          <p className="muted">{t('settings.languageHint')}</p>
          <LangToggle detail />
        </section>
      );
    case 'look':
      return (
        <section className="bk-card panel">
          <LookPicker />
        </section>
      );
    case 'hidden-features':
      return <HiddenFeatures />;
    case 'reset-sidebar':
      return <ResetSidebar />;
    case 'this-computer':
      return <ThisComputer />;
    default:
      void role;
      return null;
  }
}

export function LookPicker() {
  const t = useT();
  const look = useLook();
  return (
    <Segmented<Look>
      label={t('account.look')}
      value={look}
      onChange={setLook}
      options={[
        { value: 'auto', label: t('account.lookAuto') },
        { value: 'light', label: t('account.lookLight') },
        { value: 'dark', label: t('account.lookDark') },
      ]}
    />
  );
}

function Roster() {
  const t = useT();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const agents = useStore((s) => s.agents);
  const statusKey = useStore((s) =>
    Object.keys(s.agents)
      .map((id) => `${id}:${agentStatus(s, id)}`)
      .join(','),
  );
  const st = useMemo(() => Object.fromEntries(statusKey.split(',').map((x) => x.split(':'))), [statusKey]);
  const list = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="bk-card panel" data-testid="agent-roster">
      {owner && (
        <div>
          <Button variant="primary" onClick={() => navigate('/agents/new')}>
            <Icon name="plus" />
            <span>{t('nav.newAgent')}</span>
          </Button>
        </div>
      )}
      {list.length === 0 ? (
        <p className="muted set-empty">
          <Icon name="agent" />
          <span>{t('agents.empty')}</span>
        </p>
      ) : (
        <ul className="plain">
          {list.map((a) => (
            <li key={a.id} className="roster-row">
              <AgentAvatar agentId={a.id} salt={a.avatarSalt} size={36} status={st[a.id]} />
              <span className="grow">
                <b>{a.name}</b>
                <span className="muted small"> · {t(`status.${st[a.id] ?? 'idle'}`)}</span>
              </span>
              {owner && (
                <a className="bk-btn bk-btn--ghost bk-btn--sm" href={`#/agents/${a.id}/edit`}>
                  <Icon name="pencil" size={16} />
                  <span>{t('details.edit')}</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HideFeature({ f }: { f: Feature }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(0);
  const name = t(f.labelKey);
  // what is still on keeps running after a hide: say so before the owner confirms (spec 4.2)
  useEffect(() => {
    setRunning(0);
    if (!open || !f.active) return;
    let live = true;
    f.active
      .count()
      .then((n) => live && setRunning(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, f.active]);
  return (
    <div className="set-hide">
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid="hide-feature">
        <Icon name="eye-off" />
        <span>{t('settings.hide')}</span>
      </Button>
      <Sheet open={open} title={t('settings.hideTitle', { feature: name })} onClose={() => setOpen(false)}>
        <p>{t('settings.hideBody')}</p>
        {running > 0 && f.active && (
          <p className="set-hide-warn" data-testid="hide-running">
            <Icon name="alert" />
            <span>{t(f.active.labelKey, { count: running })}</span>
          </p>
        )}
        <div className="row">
          <Button
            variant="primary"
            onClick={() => {
              setOpen(false);
              void setHidden(f.id, true);
            }}
            data-testid="hide-confirm"
          >
            <Icon name="eye-off" />
            <span>{t('settings.hideConfirm', { feature: name })}</span>
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('core:common.cancel')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function HiddenFeatures() {
  const t = useT();
  const hidden = usePrefs((s) => s.hidden);
  const list = useFeatures(true).filter((f) => isHidden(f, hidden));
  return (
    <section className="bk-card panel" data-testid="hidden-features">
      {list.length === 0 ? (
        <p className="muted set-empty">
          <Icon name="check-circle" />
          <span>{t('settings.notUsingEmpty')}</span>
        </p>
      ) : (
        <ul className="plain">
          {list.map((f) => (
            <li key={f.id} className="roster-row">
              <IconTile name={f.icon} />
              <span className="grow">{t(f.labelKey)}</span>
              <Button size="sm" onClick={() => void setHidden(f.id, false)} data-testid={`show-${f.id}`}>
                <Icon name="eye-off" size={16} />
                <span>{t('settings.showAgain')}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ResetSidebar() {
  const t = useT();
  const n = usePrefs((s) => s.pins.length);
  return (
    <section className="bk-card panel">
      <p className="muted">{t('settings.resetSidebarHint')}</p>
      <div>
        <Button onClick={() => void setPins([])} disabled={n === 0} data-testid="reset-sidebar">
          <Icon name="refresh" />
          <span>{t('settings.resetSidebar')}</span>
        </Button>
      </div>
      <StatusChip icon="pin" label={t('settings.pinnedCount', { count: n })} />
    </section>
  );
}

/** A module page the signed-in role may not open (W39): a plain note instead of forms that would only fail. */
export function OwnerOnlyPage() {
  const t = useT();
  return (
    <section className="bk-card panel" data-testid="owner-only-page">
      <p className="row-ic">
        <Icon name="lock" />
        <span>{t('roles.ownerOnlyPage')}</span>
      </p>
      <a className="bk-btn bk-btn--secondary" href="#/">
        {t('roles.ownerOnlyBack')}
      </a>
    </section>
  );
}

/** Owner-only: the trust level new agents start at (stricter levels stay selectable per agent too). */
function NewAgentTrust() {
  const t = useT();
  const w = useWords();
  const [level, setLevel] = useState<TrustLevel | null>(null);
  const sel = useId();
  useEffect(() => {
    let gone = false;
    api<{ defaultTrust: TrustLevel }>('/api/v1/settings/agent-trust')
      .then((r) => {
        if (!gone) setLevel(r.defaultTrust);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const change = (v: TrustLevel) => {
    const before = level;
    setLevel(v);
    api('/api/v1/settings/agent-trust', { method: 'PUT', body: { defaultTrust: v } }).catch(() =>
      setLevel(before),
    );
  };
  return (
    <section className="bk-card panel" aria-labelledby="set-trust">
      <h2 id="set-trust">{t('settings.newAgents')}</h2>
      <div className="bk-field">
        <label className="bk-field__label" htmlFor={sel}>
          {w('agents.trust')}
        </label>
        <select
          id={sel}
          className="bk-input"
          value={level ?? ''}
          disabled={!level}
          onChange={(e) => change(e.target.value as TrustLevel)}
          data-testid="default-trust"
        >
          {(['guarded', 'standard', 'trusted'] as const).map((l) => (
            <option key={l} value={l}>
              {w(`agents.trustLevels.${l}`)}
            </option>
          ))}
        </select>
        <span className="bk-field__hint">{w('settings.newAgentsHint')}</span>
      </div>
      {level === 'trusted' && <TrustNote testId="default-trust-note" />}
    </section>
  );
}

type AlwaysAskView = { fixed: string[]; extra: string[]; available: string[] };
/**
 * Owner-only, read-only for the three fixed classes (7.1 "Always asks"): money, messages to other people and deletes
 * outside the agent's own workspace (W38) always ask at every trust level; the owner may add publishing, never
 * remove those three.
 */
function AlwaysAsks() {
  const t = useT();
  const w = useWords();
  const [v, setV] = useState<AlwaysAskView | null>(null);
  useEffect(() => {
    let gone = false;
    api<AlwaysAskView>('/api/v1/settings/always-ask')
      .then((r) => {
        if (!gone) setV(r);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const toggle = (c: string, on: boolean) => {
    if (!v) return;
    const before = v;
    const extra = on ? [...v.extra, c] : v.extra.filter((x) => x !== c);
    setV({ ...v, extra });
    api<AlwaysAskView>('/api/v1/settings/always-ask', { method: 'PUT', body: { extra } })
      .then(setV)
      .catch(() => setV(before));
  };
  return (
    <section className="bk-card panel" aria-labelledby="set-ask" data-testid="always-asks">
      <h2 id="set-ask">{t('settings.alwaysAsks')}</h2>
      <p className="muted">{t('settings.alwaysAsksIntro')}</p>
      <ul className="always-asks">
        <li data-ask-class="money">
          <span>{t('settings.alwaysAsksMoney')}</span>
          <span className="bk-badge">{t('settings.alwaysAsksFixed')}</span>
        </li>
        <li data-ask-class="outbound-message">
          <span>{t('settings.alwaysAsksMessage')}</span>
          <span className="bk-badge">{t('settings.alwaysAsksFixed')}</span>
        </li>
        <li data-ask-class="delete">
          <span>{t('settings.alwaysAsksDelete')}</span>
          <span className="bk-badge">{t('settings.alwaysAsksFixed')}</span>
        </li>
      </ul>
      {v && v.available.length > 0 && (
        <fieldset className="always-asks__add">
          <legend>{t('settings.alwaysAsksAdd')}</legend>
          {v.available.map((c) => (
            <label key={c} className="always-asks__opt">
              <input
                type="checkbox"
                checked={v.extra.includes(c)}
                onChange={(e) => toggle(c, e.target.checked)}
                data-ask-extra={c}
              />
              <span>{t(`settings.alwaysAsksClass.${c}`)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="muted" role="note" data-testid="always-asks-limit">
        {w('settings.alwaysAsksLimit')}
      </p>
    </section>
  );
}
