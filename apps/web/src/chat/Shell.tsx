/**
 * Signed-in shell (Simplify spec 2): a compact top bar (brand, "N need you", Stop all, the account menu), a
 * connection banner when the socket is not live, the chats list on the left (plus the person's pinned features and
 * Settings), the chat in the middle and the agent's details on demand. Every other feature lives in Settings.
 * Under 600 px: home is the chats list, a chat is full screen with its own header (Back, name, Stop all, More).
 */
import { AgentAvatar, agentAccentColor, avatarSeed, Badge, Button, Icon, Menu } from '@pasabot/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AgentForm } from '../agents/AgentForm.js';
import { api } from '../app/api.js';
import { Mark } from '../app/chrome.js';
import { type Lang, useI18n, useT } from '../app/i18n.js';
import {
  clearPrefsError,
  dismissTidied,
  loadPrefs,
  movePin,
  setTeamTalk,
  togglePin,
  usePrefs,
} from '../app/prefs.js';
import { match, navigate, useRoute } from '../app/router.js';
import { slots } from '../app/slots.js';
import {
  agentStatus,
  type ChatDTO,
  chatAgentId,
  detachedPending,
  directChatOf,
  live,
  loadChats,
  pendingApprovals,
  type State,
  useStore,
} from '../app/store.js';
import { type Feature, featureHref, settingsPlace } from '../settings/catalog.js';
import { catalog, LookPicker, SettingsNav, SettingsPage, useFeatures } from '../settings/Settings.js';
import { ModuleRoute, TopBarSlots } from '../shell/slots.js';
import { ChatMore } from './ChatMore.js';
import { ChatView } from './ChatView.js';
import { SuggestionCards, useOpenCards } from './cards.js';
import { Details } from './Details.js';
import { DecisionCenter, useModuleDecisions } from './decisions.js';
import { ChatModelPicker } from './ModelPicker.js';
import { plainText } from './markdown.js';
import { isPinnedChat, pinFirst } from './pin.js';
import { signOut } from './SignOut.js';
import { useRowWork } from './threads.js';
import { visibleText } from './visible.js';
import { Welcome } from './Welcome.js';

const DETAILS_KEY = 'pasabot.details';
const NARROW = '(max-width: 600px)';

const narrowNow = () => typeof matchMedia !== 'undefined' && matchMedia(NARROW).matches;
/** Under 600 px (read live on every render, so a resize and a route change never disagree) */
function useNarrow() {
  return useSyncExternalStore(
    (l) => {
      if (typeof matchMedia === 'undefined') return () => {};
      const m = matchMedia(NARROW);
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    narrowNow,
    () => false,
  );
}

export function Shell() {
  const t = useT();
  const route = useRoute();
  const narrow = useNarrow();
  const chatParams = match('/chats/:id', route.path);
  const chatId = chatParams?.id ?? null;
  const chat = useStore((s) => (chatId ? s.chats[chatId] : undefined));
  const loaded = useStore((s) => s.loaded);
  const role = useStore((s) => s.me?.kind ?? null);
  // never a helpers' own conversation (Team talk): the person's chats only
  const firstChat = useStore((s) => sortedChats(s).find((c) => !isTeamTalk(c))?.id);
  // the details panel is closed by default on every width (spec 2.1) until this person opens it; their choice is
  // remembered per person on this device (a fresh person, or one who never opened it, starts closed)
  const meId = useStore((s) => s.me?.id ?? '');
  const detailsKey = `${DETAILS_KEY}:${meId}`;
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const details =
    opened[detailsKey] ??
    (() => {
      try {
        return !!meId && localStorage.getItem(detailsKey) === '1';
      } catch {
        return false;
      }
    })();
  const toggleDetails = (v: boolean) => {
    setOpened((o) => ({ ...o, [detailsKey]: v }));
    try {
      if (meId) localStorage.setItem(detailsKey, v ? '1' : '0');
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadPrefs();
  }, []);
  // the phone's home is the chats list; a wider window opens the first chat
  useEffect(() => {
    if (route.path === '/' && loaded && firstChat && !narrowNow()) navigate(`/chats/${firstChat}`, true);
    void narrow; // re-checks when the window crosses 600 px
  }, [route.path, loaded, firstChat, narrow]);
  useEffect(() => {
    if (route.path === '/menu') navigate('/settings', true);
  }, [route.path]);
  // a full-screen module page (the team builder's Stage) draws no chrome; leaving it reloads the chats it changed
  const bare = slots.routes.find((r) => r.bare && r.path === route.path);
  const wasBare = useRef(false);
  useEffect(() => {
    if (wasBare.current && !bare) void loadChats();
    wasBare.current = !!bare;
  }, [bare]);
  useResumeStage(role === 'owner', route.path);

  const agentId = chatAgentId(chat);
  const showDetails = !!chat && !!agentId && details;
  const place = chatId ? null : settingsPlace(route.path, catalog);

  let content: React.ReactNode;
  const editParams = match('/agents/:id/edit', route.path);
  if (chatId)
    content = (
      <ChatView chatId={chatId} onShowDetails={() => toggleDetails(!details)} detailsOpen={showDetails} />
    );
  else if (place) content = <SettingsPage place={place} />;
  // only the owner makes agents (the server refuses anyone else): a member or guest gets the plain note, not a form
  else if (route.path === '/agents/new')
    content =
      role && role !== 'owner' ? (
        <div className="page">
          <OwnerOnlyNote />
        </div>
      ) : (
        <AgentForm />
      );
  else if (editParams) content = <AgentForm agentId={editParams.id} />;
  else if (route.path === '/welcome') content = <Welcome />;
  else if (slots.routes.some((r) => r.path === route.path))
    content = (
      <div className="page">
        <ModuleRoute slots={slots} path={route.path} viewer={role} denied={<OwnerOnlyNote />} />
      </div>
    );
  else if (narrow && route.path === '/') content = <SideList home />;
  else content = <Empty />;

  if (bare)
    return (
      <main id="main-content" className="bk-root app-bare" tabIndex={-1}>
        <ModuleRoute slots={slots} path={route.path} viewer={role} denied={<OwnerOnlyNote />} />
      </main>
    );

  return (
    <div
      className="app bk-root"
      data-details={showDetails ? 'open' : 'closed'}
      data-level={chatId ? 'chat' : 'home'}
    >
      <button type="button" className="skip" onClick={() => document.getElementById('main-content')?.focus()}>
        {t('app.skip')}
      </button>
      <TopBar />
      <PhoneTop chatId={chatId} onToggleDetails={() => toggleDetails(!details)} detailsOpen={showDetails} />
      <ConnBanner />
      <div className="main">
        <aside className="side bk-card" aria-label={place ? t('settings.title') : t('nav.sidebar')}>
          {place ? <SettingsNav place={place} /> : <SideList />}
        </aside>
        <main id="main-content" className="center" tabIndex={-1}>
          <DecisionCenter />
          {content}
        </main>
        {showDetails && (
          <DetailsPanel agentId={agentId!} chatId={chatId!} onHide={() => toggleDetails(false)} />
        )}
      </div>
      <PrefsNote />
    </div>
  );
}

/** Under 1100 px the details float over the chat (a side box, a bottom sheet on a phone) */
const FLOATING = '(max-width: 1099px)';
function useFloating() {
  return useSyncExternalStore(
    (l) => {
      if (typeof matchMedia === 'undefined') return () => {};
      const m = matchMedia(FLOATING);
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    () => typeof matchMedia !== 'undefined' && matchMedia(FLOATING).matches,
    () => false,
  );
}

/**
 * The agent's details: a column at 1100 px and up; below that a floating dialog that takes focus (its Hide
 * button), closes on Escape and gives focus back to what opened it. It is not modal: the chat's approval cards,
 * the decision bar and Stop all stay usable while it is open (spec 10).
 */
function DetailsPanel({ agentId, chatId, onHide }: { agentId: string; chatId: string; onHide(): void }) {
  const t = useT();
  const floating = useFloating();
  const ref = useRef<HTMLElement>(null);
  const hide = useRef(onHide);
  hide.current = onHide;
  useEffect(() => {
    if (!floating) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('[data-details-hide]')?.focus();
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // a menu or sheet open elsewhere closes first
      if (document.querySelector('[data-layer="popover"], dialog[open]')) return;
      e.preventDefault();
      hide.current();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (back?.isConnected) back.focus();
    };
  }, [floating]);
  return (
    <aside
      ref={ref}
      className="det"
      role={floating ? 'dialog' : undefined}
      aria-label={t('details.label')}
      data-testid="details-panel"
    >
      <Details agentId={agentId} chatId={chatId} onHide={onHide} />
    </aside>
  );
}

function useNeeds() {
  // module decisions (a budget cap card, a skill-permission proposal) need the owner as much as an agent does
  const mods = useModuleDecisions().length + useOpenCards().length;
  const needs = useStore((s: State) => {
    let n = 0;
    for (const id of Object.keys(s.agents)) if (agentStatus(s, id) === 'waiting') n++;
    // a workflow waiting on an approval needs you as much as an agent does; an approval card counts even when its
    // agent's live status has not caught up yet
    return Math.max(n + detachedPending(s), pendingApprovals(s).length);
  });
  return needs + mods;
}

/** "N need you": only when someone waits; jumps to the oldest waiting approval. */
function NeedsPill({ compact }: { compact?: boolean }) {
  const t = useT();
  const needs = useNeeds();
  if (needs <= 0) return null;
  const text = t('counts.needs', { count: needs });
  const jump = () => {
    const first = document.querySelector<HTMLElement>(
      '[data-approval][data-state="pending"], .bk-hcard[data-state="open"]',
    );
    first?.scrollIntoView({ block: 'center' });
    first?.focus();
  };
  return (
    <button type="button" className="count-btn" onClick={jump} aria-label={text}>
      <Badge tone="signal" data-testid="count-needs">
        <Icon name="hand" size={16} />
        {compact ? (
          <>
            <span aria-hidden="true">{needs}</span>
            <span className="bk-visually-hidden">{text}</span>
          </>
        ) : (
          <span>{text}</span>
        )}
      </Badge>
    </button>
  );
}

/** The header lockup (logo build notes: 32 px high on desktop, 28 px on the phone), with the idle glance. */
function Brand({ size = 32 }: { size?: number }) {
  return (
    <a className="brand" href="#/" data-testid="brand">
      <Mark size={size} animated />
      <b>PasaBot</b>
    </a>
  );
}

function TopBar() {
  const role = useStore((s) => s.me?.kind ?? null);
  // Stop all is red only while something is working or waiting (paused shows its own chip); calm otherwise
  const busy = useStore((s) => Object.keys(s.agents).some((id) => agentStatus(s, id) !== 'idle'));
  return (
    <header className="top">
      <Brand />
      <NeedsPill />
      <div className="tr">
        <TopBarSlots slots={slots} viewer={role} idle={!busy} />
        <AccountMenu />
      </div>
    </header>
  );
}

/**
 * Phone header: the home bar, or (in a chat) Back + who + the brain (its icon) + More, with Stop all while a helper is
 * working or waiting on a decision (and Start again while everything is paused): the helper's name gets the room.
 */
function PhoneTop({
  chatId,
  onToggleDetails,
  detailsOpen,
}: {
  chatId: string | null;
  onToggleDetails(): void;
  detailsOpen: boolean;
}) {
  const t = useT();
  const role = useStore((s) => s.me?.kind ?? null);
  const chat = useStore((s) => (chatId ? s.chats[chatId] : undefined));
  const agentId = chatAgentId(chat);
  const agent = useStore((s) => (agentId ? s.agents[agentId] : undefined));
  const agents = useStore((s) => s.agents);
  const status = useStore((s) => (agentId ? agentStatus(s, agentId) : 'idle'));
  // anything running or waiting anywhere: Stop all is there to stop it
  const busy = useStore((s) => Object.keys(s.agents).some((id) => agentStatus(s, id) !== 'idle'));
  if (chatId && chat)
    return (
      <header className="ptop ptop--chat">
        <a className="ptop-back" href="#/" aria-label={t('settings.back')} title={t('settings.back')}>
          <Icon name="back" />
        </a>
        {/* a phone header has no room for one more icon (the model pill would shrink to a letter): the agent's own
            name and face are the details button, labelled as such */}
        <button
          type="button"
          className="ptop-who"
          onClick={onToggleDetails}
          disabled={!agent}
          aria-expanded={agent ? detailsOpen : undefined}
          aria-label={agent ? t('details.about', { name: agent.name }) : undefined}
          data-testid="phone-details-toggle"
        >
          {agent && <AgentAvatar agentId={agent.id} salt={agent.avatarSalt} size={32} status={status} />}
          <span className="ptop-name">
            <b>{teamTalkTitle(chat, agents) || chat.title || agent?.name}</b>
            <span>{t(`status.${status}`)}</span>
          </span>
        </button>
        {agent && chat.kind === 'direct' && <ChatModelPicker agent={agent} />}
        <NeedsPill compact />
        {/* not drawn while idle (paused shows Start again), but mounted: the More menu's Stop all reaches it */}
        <TopBarSlots slots={slots} compact idle={!busy} hideIdle viewer={role} />
        <ChatMore chatId={chatId} onToggleDetails={onToggleDetails} testId="phone-chat-more" phone />
      </header>
    );
  return (
    <header className="ptop">
      <Brand size={28} />
      <NeedsPill compact />
      {/* the home bar has room: Stop all keeps its visible label, right next to the account button; calm (not red)
          while nothing is working or waiting, as on the desktop top bar */}
      <TopBarSlots slots={slots} viewer={role} idle={!busy} />
      <AccountMenu />
    </header>
  );
}

/** Not live: a strip under the top bar that pushes content down (never covers Stop all). */
function ConnBanner() {
  const t = useT();
  const conn = useStore((s) => s.conn);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const down = conn === 'reconnecting' || conn === 'offline';
  useEffect(() => {
    if (!down) return setSince(null);
    setSince((s) => s ?? Date.now());
    const i = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(i);
  }, [down]);
  if (!down) return <div className="conn-slot" />;
  const long = conn === 'offline' || (since !== null && now - since > 30_000);
  return (
    <div className="conn-slot">
      <div className={long ? 'conn-banner conn-banner--long' : 'conn-banner'} role="status">
        <Icon name="cloud-off" />
        <span className="grow">{long ? t('conn.bannerLong') : t('conn.banner')}</span>
        <Button size="sm" onClick={() => live.retryNow()}>
          <Icon name="refresh" size={16} />
          <span>{t('conn.tryNow')}</span>
        </Button>
      </div>
    </div>
  );
}

/** A failed pin or hide is rolled back; say so briefly. */
function PrefsNote() {
  const t = useT();
  const err = usePrefs((s) => s.error);
  useEffect(() => {
    if (!err) return;
    const i = setTimeout(clearPrefsError, 4000);
    return () => clearTimeout(i);
  }, [err]);
  if (!err) return null;
  return (
    <p className="prefs-note bk-card" role="alert">
      <Icon name="alert" />
      <span>{t('settings.saveFailed')}</span>
    </p>
  );
}

/** Avatar button: who you are, the connection, language, look, Settings, this device, sign out. */
function AccountMenu() {
  const { t, lang, setLang, languages, meta } = useI18n();
  const me = useStore((s) => s.me);
  const conn = useStore((s) => s.conn);
  const [langs, setLangs] = useState(false);
  if (!me) return null;
  const initial = (me.displayName.trim()[0] ?? '?').toLocaleUpperCase();
  const status = t(`conn.${conn}`);
  return (
    <Menu
      label={`${t('account.menu')} · ${status}`}
      triggerClass="acc-btn"
      triggerTitle={`${t('account.menu')} · ${status}`}
      triggerTestId="account-menu"
      trigger={
        <>
          <span className="acc-face" aria-hidden="true">
            {initial}
          </span>
          <span className="acc-dot" data-testid="conn" data-state={conn} aria-hidden="true" />
        </>
      }
      testId="account-pop"
      onOpenChange={(v) => !v && setLangs(false)}
      header={
        <div className="acc-head">
          <span className="acc-face acc-face--big" aria-hidden="true">
            {initial}
          </span>
          <span className="acc-who">
            <b>{me.displayName}</b>
            <span className="muted">{t(`account.role.${me.kind}`)}</span>
            <span className="acc-state" data-state={conn}>
              <i aria-hidden="true" />
              {status}
            </span>
          </span>
        </div>
      }
    >
      {(close) => (
        <div className="acc-body">
          {/* menu items always sit in a role=menu; the Look switch between the two menus is a plain group */}
          <div role="menu" aria-label={t('settings.language')} className="acc-menu">
            <button
              type="button"
              role="menuitem"
              className="bk-menu__item"
              aria-expanded={langs}
              onClick={() => setLangs(!langs)}
              data-testid="account-language"
            >
              <Icon name="globe" />
              <span className="bk-menu__label">{t('settings.language')}</span>
              <span className="muted small">{meta.name}</span>
            </button>
            {langs && (
              <fieldset className="acc-langs" aria-label={t('settings.language')}>
                {languages.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    role="menuitemradio"
                    aria-checked={l.code === lang}
                    className="bk-menu__item"
                    lang={l.code}
                    dir={l.dir}
                    onClick={() => {
                      setLang(l.code as Lang);
                      close();
                    }}
                  >
                    <Icon name={l.code === lang ? 'check-circle' : 'dot'} />
                    <span className="bk-menu__label">{l.name}</span>
                  </button>
                ))}
              </fieldset>
            )}
          </div>
          <div className="acc-look">
            <span className="row-ic">
              <Icon name="sun-moon" />
              <span>{t('account.look')}</span>
            </span>
            <LookPicker />
          </div>
          <div role="menu" aria-label={t('account.menu')} className="acc-menu">
            <button
              type="button"
              role="menuitem"
              className="bk-menu__item"
              onClick={() => {
                close();
                navigate('/settings');
              }}
            >
              <Icon name="settings" />
              <span className="bk-menu__label">{t('nav.settings')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="bk-menu__item"
              onClick={() => {
                close();
                navigate('/devices');
              }}
            >
              <Icon name="device" />
              <span className="bk-menu__label">{t('account.thisDevice')}</span>
            </button>
            <button type="button" role="menuitem" className="bk-menu__item" onClick={() => void signOut()}>
              <Icon name="log-out" />
              <span className="bk-menu__label">{t('settings.signOut')}</span>
            </button>
          </div>
        </div>
      )}
    </Menu>
  );
}

/** Chats in the list's order: someone waiting first, then the newest. */
function sortedChats(s: State): ChatDTO[] {
  const last = (c: ChatDTO) => {
    const m = s.messages[c.id];
    return m?.length ? m[m.length - 1]!.createdAt : c.createdAt;
  };
  const waits = (c: ChatDTO) => {
    const a = chatAgentId(c);
    return a && agentStatus(s, a) === 'waiting' ? 1 : 0;
  };
  return Object.values(s.chats)
    .filter((c) => !c.archivedAt)
    .sort((a, b) => waits(b) - waits(a) || last(b) - last(a));
}

/** A helpers' own conversation (one helper gave another work): it lives under "Team talk", not among the chats. */
const isTeamTalk = (c: ChatDTO) => typeof c.settings?.collabFrom === 'string';

/**
 * The team builder's agent id (the orchestrator module), for the owner: its chat leads the list. Read again only when
 * the number of agents changes (a team builder made or removed); null without the module or for anyone else.
 */
function useTeamBuilderId(owner: boolean): string | null {
  const n = useStore((s) => Object.keys(s.agents).length);
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!owner || n === 0) return;
    let live = true;
    api<{ agentId: string | null }>('/api/m/orchestrator/state')
      .then((r) => live && setId(r.agentId ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [owner, n]);
  return owner ? id : null;
}

/**
 * An owner who left the team builder's Stage half-way (closed the app, reloaded) lands back on it when the app opens
 * on its home or a chat: once per app load, only while the Stage is open (not skipped for now, not finished). W40:
 * while its "A few things need your OK" screen is open, an owner who went off to connect something comes back to it
 * from the home screen (every time, until they Continue), never from a chat (the helper's own checklist is there).
 */
function useResumeStage(owner: boolean, path: string) {
  const checked = useRef(false);
  useEffect(() => {
    if (!owner) return;
    const first = !checked.current;
    if (!first && path !== '/') return;
    checked.current = true;
    if (path !== '/' && !path.startsWith('/chats/')) return;
    api<{ stage?: string | null; oks?: boolean }>('/api/m/orchestrator/state')
      .then((r) => {
        const stage = slots.routes.find((x) => x.bare && x.path === STAGE_PATH);
        const here = location.hash.replace(/^#/, '').split('?')[0] || '/';
        const back = first
          ? here === '/' || (here.startsWith('/chats/') && !r.oks)
          : here === '/' && r.oks === true;
        if (r.stage === 'open' && stage && back) navigate(STAGE_PATH, true);
      })
      .catch(() => {});
  }, [owner, path]);
}
/** the team builder's Stage (orchestrator module) */
const STAGE_PATH = '/team-setup';

/** The sidebar (and the phone's home): New, the chats, Team talk, the pinned features, Settings. */
function SideList({ home }: { home?: boolean }) {
  const t = useT();
  const route = useRoute();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const agents = useStore((s) => s.agents);
  const order = useStore((s) =>
    sortedChats(s)
      .map((c) => c.id)
      .join(','),
  );
  const chats = useStore((s) => s.chats);
  const builder = useTeamBuilderId(owner);
  const pinned = (c: ChatDTO) => isPinnedChat(c, chatAgentId(c), builder);
  const list = useMemo(() => {
    const all = order ? order.split(',').map((id) => chats[id]!) : [];
    // the team builder is pinned first, then the helpers (each in the usual order: someone waiting, then the newest);
    // a search only filters this list, so the pinned chat stays first there too
    return pinFirst(all, (c) => isPinnedChat(c, chatAgentId(c), builder));
  }, [order, chats, builder]);
  const [q, setQ] = useState('');
  const current = match('/chats/:id', route.path)?.id;
  // first run, step 2: the agent being set up joins the list only once "Get me started" is pressed
  const settingUp = route.path === '/welcome' ? route.query.get('chat') : null;
  const visible = settingUp ? list.filter((c) => c.id !== settingUp) : list;
  const found = q.trim()
    ? visible.filter((c) => chatTitle(c, agents).toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()))
    : visible;
  const shown = found.filter((c) => !isTeamTalk(c));
  const team = found.filter(isTeamTalk);
  return (
    <div className={home ? 'page side-page' : 'side-in'} data-testid="chats-list">
      <TidiedCard />
      <div className="ttl">
        <h2 className="row-ic">
          <Icon name="chats" />
          <span>{t('nav.chats')}</span>
        </h2>
        {owner && <NewMenu />}
      </div>
      {visible.length > 6 && (
        <input
          className="bk-input chat-filter"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('nav.searchChats')}
          aria-label={t('nav.searchChats')}
        />
      )}
      {visible.length === 0 && !home && <p className="muted pad">{t('agents.empty')}</p>}
      {visible.length === 0 && home && (
        <div className="side-empty">
          <h2 className="row-ic side-empty-t">
            <Icon name="agent" />
            <span>{t('agents.emptyTitle')}</span>
          </h2>
          <p className="muted">{t('agents.emptyIntro')}</p>
          {owner && (
            <Button variant="primary" onClick={() => navigate('/agents/new')}>
              <Icon name="plus" />
              <span>{t('nav.newAgent')}</span>
            </Button>
          )}
        </div>
      )}
      <ul className="plain">
        {shown.map((c) => (
          <li key={c.id}>
            <ChatRow chat={c} current={current === c.id} pinned={pinned(c)} />
          </li>
        ))}
      </ul>
      {team.length > 0 && (
        <TeamTalk
          chats={team}
          current={current}
          // a search that finds a helpers' conversation, or that conversation being open, shows the group
          forceKey={q.trim() || team.some((c) => c.id === current) ? `${q.trim()}\n${current ?? ''}` : null}
        />
      )}
      <Pinned />
      <div className="side-foot">
        <a
          className="room"
          href="#/settings"
          aria-current={route.path.startsWith('/settings') ? 'page' : undefined}
          data-testid="nav-settings"
        >
          <span className="ic" aria-hidden="true">
            <Icon name="settings" />
          </span>
          {t('nav.settings')}
        </a>
      </div>
    </div>
  );
}

/**
 * "Team talk": the helpers' conversations with each other, folded into one row at the bottom of the chats (closed by
 * default, remembered per person). Opening the group lists them; each still opens as a normal chat.
 */
function TeamTalk({
  chats,
  current,
  forceKey,
}: {
  chats: ChatDTO[];
  current: string | undefined;
  /**
   * Set while a search is typed or a helpers' conversation is open (the search and the open chat): the group opens
   * by itself. A click while it is forced open folds it until the search or the open chat changes.
   */
  forceKey: string | null;
}) {
  const t = useT();
  const saved = usePrefs((s) => s.teamTalk);
  const [foldedAt, setFoldedAt] = useState<string | null>(null);
  // a new search or another open chat forgets the fold: the group opens by itself again
  const [seenKey, setSeenKey] = useState(forceKey);
  if (seenKey !== forceKey) {
    setSeenKey(forceKey);
    setFoldedAt(null);
  }
  const open = forceKey !== null ? saved || foldedAt !== forceKey : saved;
  const toggle = () => {
    const next = !open;
    // remember what the person now sees, and while forced open keep it folded for this search / chat
    if (forceKey !== null) setFoldedAt(next ? null : forceKey);
    void setTeamTalk(next);
  };
  return (
    <div className="team-talk" data-testid="team-talk">
      <button
        type="button"
        className="pal team-talk-btn"
        aria-expanded={open}
        aria-controls={open ? 'team-talk-list' : undefined}
        onClick={toggle}
        data-testid="team-talk-toggle"
      >
        <span className="team-talk-ic" aria-hidden="true">
          <Icon name="users" size={20} />
        </span>
        <span className="t">
          <span className="n">{t('nav.teamTalk')}</span>
          <span className="r">{t('nav.teamTalkHint')}</span>
        </span>
        <span className="team-talk-n" data-testid="team-talk-count">
          {chats.length}
        </span>
        <span className="team-talk-chev" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </button>
      {open && (
        <ul className="plain team-talk-list" id="team-talk-list" data-testid="team-talk-list">
          {chats.map((c) => (
            <li key={c.id}>
              <ChatRow chat={c} current={current === c.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const chatTitle = (c: ChatDTO, agents: State['agents']) =>
  teamTalkTitle(c, agents) ||
  c.title ||
  c.members
    .filter((m) => m.kind === 'agent')
    .map((m) => agents[m.id]?.name)
    .filter(Boolean)
    .join(' & ');

/**
 * Two helpers' own conversation (team talk) is titled with their names as they are now ("Mayumi → Dalisay"), never
 * the names stored when it began (a helper renamed since keeps its new name here); null for any other chat.
 */
function teamTalkTitle(c: ChatDTO, agents: State['agents']): string | null {
  const from = c.settings?.collabFrom;
  if (typeof from !== 'string') return null;
  const a = agents[from]?.name;
  const b = agents[chatAgentId(c) ?? '']?.name;
  return a && b ? `${a} → ${b}` : null;
}

/**
 * The last finished message of a chat as one short line (none until the chat's messages are loaded). A tool's raw
 * result (JSON) and the header the server writes for a helper's brain ("Task from agent …, Task id …") are never a
 * preview: the words around them are, else the message before (Technical words on: shown as they are).
 */
function lastText(
  list: readonly { body: string; status: string }[] | undefined,
  technical: boolean,
): string | null {
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
    const m = list![i]!;
    // the words only: a reply's Markdown markers (**bold**, list dashes) never show in the preview
    const text = m.status === 'final' ? plainText(technical ? m.body : visibleText(m.body)) : '';
    if (text) return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }
  return null;
}

function ChatRow({ chat: c, current, pinned }: { chat: ChatDTO; current: boolean; pinned?: boolean }) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const agentId = c.kind === 'direct' ? chatAgentId(c) : null;
  const agent = agentId ? agents[agentId] : undefined;
  const status = useStore((s) => (agentId ? agentStatus(s, agentId) : 'idle'));
  const needs = useStore(
    (s) =>
      Object.values(s.approvals).filter(
        (a) => a.state === 'pending' && (agentId ? a.agentId === agentId : false),
      ).length,
  );
  // the row's second line: the last message while the agent is free, else its state (spec 2.2); while it works on
  // another helper's request, for whom ("Working for Mayumi"), and a dot when a request came in since last opened
  const technical = usePrefs((s) => s.advanced);
  const last = useStore((s) => lastText(s.messages[c.id], technical));
  const owner = useStore((s) => s.me?.kind === 'owner');
  const work = useRowWork(owner && !!agent, agentId, c.id);
  const title = chatTitle(c, agents);
  const preview = status === 'idle' && last ? last : null;
  const forName = work.from ? agents[work.from]?.name : undefined;
  const line =
    status === 'working' && forName
      ? t('nav.workingFor', { name: forName })
      : (preview ?? t(`status.${status}`));
  const unread = work.unread && !current;
  if (agent)
    return (
      <a
        className="pal"
        href={`#/chats/${c.id}`}
        aria-current={current ? 'page' : undefined}
        data-testid="roster-agent"
        data-status={status}
        data-pinned={pinned ? 'true' : undefined}
      >
        <AgentAvatar
          agentId={agent.id}
          salt={agent.avatarSalt}
          size={36}
          shape="circle"
          state={status === 'working' ? 'thinking' : 'idle'}
          status={status}
          statusLabel={t(`status.${status}`)}
        />
        <span className="t">
          <span className="n">{title}</span>
          <span
            className={`r${status === 'waiting' ? ' wait' : ''}`}
            data-testid={
              preview ? 'chat-preview' : forName && status === 'working' ? 'working-for' : undefined
            }
          >
            {line}
          </span>
        </span>
        {/* the team builder's chat is always first and cannot be unpinned: a small pin mark, read out as "Pinned" */}
        {pinned && <Icon name="pin" size={16} title={t('nav.pinned')} className="row-pin" />}
        {unread && (
          <span className="row-dot" data-testid="row-unread" title={t('nav.newRequest')}>
            <span className="bk-visually-hidden">{t('nav.newRequest')}</span>
          </span>
        )}
        {needs > 0 && <Badge tone="signal">{needs}</Badge>}
      </a>
    );
  const members = c.members
    .filter((m) => m.kind === 'agent')
    .map((m) => agents[m.id])
    .filter(Boolean);
  return (
    <a
      className="pal"
      href={`#/chats/${c.id}`}
      aria-current={current ? 'page' : undefined}
      data-testid="chat-link"
    >
      <span className="mini" aria-hidden="true">
        {members.slice(0, 2).map((m) => (
          <i key={m!.id} style={{ background: agentAccentColor(avatarSeed(m!.id, m!.avatarSalt)).hex }} />
        ))}
        {members.length === 0 && <Icon name="channels" />}
      </span>
      <span className="t">
        <span className="n">{title}</span>
        <span className="r">{t('chat.members', { count: members.length })}</span>
      </span>
    </a>
  );
}

function NewMenu() {
  const t = useT();
  const groupRoute = slots.routes.find((r) => r.path === '/collab');
  return (
    <Menu
      label={t('nav.new')}
      triggerClass="bk-btn bk-btn--secondary bk-btn--sm new-btn"
      triggerTestId="nav-new"
      trigger={
        <>
          <Icon name="plus" size={18} />
          <span>{t('nav.new')}</span>
        </>
      }
      items={[
        { id: 'agent', icon: 'agent', label: t('nav.newAgent'), href: '#/agents/new', testId: 'new-agent' },
        ...(groupRoute
          ? [
              {
                id: 'group',
                icon: 'channels',
                label: t('nav.newGroup'),
                href: '#/collab',
                testId: 'new-group',
              },
            ]
          : []),
      ]}
    />
  );
}

function TidiedCard() {
  const t = useT();
  const show = usePrefs((s) => s.loaded && !s.tidied);
  const n = useStore((s) => Object.keys(s.agents).length);
  // only for people who already have a team (an existing install), never on a brand-new one
  if (!show || n === 0) return null;
  return (
    <div className="tidied bk-card" data-testid="tidied-card">
      <p className="row-ic">
        <Icon name="sparkle" />
        <span>{t('settings.tidied')}</span>
      </p>
      <div className="row">
        <Button
          size="sm"
          onClick={() => {
            void dismissTidied();
            navigate('/settings');
          }}
        >
          <Icon name="settings" size={16} />
          <span>{t('nav.openSettings')}</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void dismissTidied()}>
          {t('settings.gotIt')}
        </Button>
      </div>
    </div>
  );
}

function Pinned() {
  const t = useT();
  const route = useRoute();
  const pins = usePrefs((s) => s.pins);
  const features = useFeatures();
  const byId = new Map(features.map((f) => [f.id, f]));
  const list = pins.map((id) => byId.get(id)).filter((f): f is Feature => !!f);
  const shown = list.map((f) => f.id);
  if (!list.length) return null;
  return (
    <section className="pinned" aria-labelledby="pinned-h" data-testid="pinned">
      <h2 id="pinned-h" className="pin-h">
        {t('nav.pinned')}
      </h2>
      <ul className="plain">
        {list.map((f, i) => {
          const href = featureHref(f);
          const here = `#${route.path}` === href;
          return (
            <li key={f.id} className="pin-row" data-testid={`pinned-${f.id}`}>
              <a className="room" href={href} aria-current={here ? 'page' : undefined}>
                <span className="ic" aria-hidden="true">
                  <Icon name={f.icon} />
                </span>
                <span className="ellipsis">{t(f.labelKey)}</span>
              </a>
              <Menu
                label={t('nav.pinMenu', { feature: t(f.labelKey) })}
                triggerClass="bk-menu__btn pin-more"
                trigger={<Icon name="more" size={18} />}
                items={[
                  ...(i > 0
                    ? [
                        {
                          id: 'up',
                          icon: 'back',
                          label: t('nav.moveUp'),
                          onSelect: () => movePin(f.id, -1, shown),
                        },
                      ]
                    : []),
                  ...(i < list.length - 1
                    ? [
                        {
                          id: 'down',
                          icon: 'chevron',
                          label: t('nav.moveDown'),
                          onSelect: () => movePin(f.id, 1, shown),
                        },
                      ]
                    : []),
                  {
                    id: 'unpin',
                    icon: 'pin',
                    label: t('nav.unpin'),
                    onSelect: () => void togglePin(f.id, false),
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Empty() {
  const t = useT();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const loaded = useStore((s) => s.loaded);
  const n = useStore((s) => Object.keys(s.agents).length);
  // W40: "what can I do next": suggestion cards that send to the main helper (else the first helper's chat)
  const builder = useTeamBuilderId(owner);
  const home = useStore((s) => {
    const id = builder ?? Object.values(s.agents).find((a) => !a.archivedAt)?.id;
    return id ? (directChatOf(s, id)?.id ?? null) : null;
  });
  if (!loaded) return <p className="page muted">{t('core:common.loading')}</p>;
  return (
    <div className="page empty">
      <span className="empty-ic" aria-hidden="true">
        <Icon name={n ? 'chats' : 'agent'} size={24} />
      </span>
      <h1>{n ? t('chat.selectTitle') : t('agents.emptyTitle')}</h1>
      <p className="muted">{n ? t('chat.select') : t('agents.emptyIntro')}</p>
      {owner && !n && (
        <Button variant="primary" onClick={() => navigate('/agents/new')}>
          <Icon name="plus" />
          <span>{t('agents.emptyCta')}</span>
        </Button>
      )}
      {owner && n > 0 && home && <SuggestionCards chatId={home} testId="home-suggestions" />}
    </div>
  );
}

/** A module page the signed-in role may not open (W39): a plain note instead of forms that would only fail. */
function OwnerOnlyNote() {
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
