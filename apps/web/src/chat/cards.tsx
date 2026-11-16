/**
 * W40 cards in the web app: the `core.card` block (one card family: needs-your-OK, needs-info, connect, result,
 * something-went-wrong-with-a-way-out, suggestion) drawn with the shared `HelperCard`, the open cards that need an
 * answer for the pinned decision bar, and the suggestion cards (tap to send) on the home screen and after the first
 * reply. A card's state lives on the server (its block); here only an optimistic copy is kept until the server's
 * `message.updated` arrives, so a reload or a phone shows the same card.
 */
import { LIVE_EVENT } from '@pasabot/core/web';
import type { CardAction, CardData, CardText, OpenCardDTO } from '@pasabot/protocol';
import { AgentAvatar, HelperCard, type HelperCardAction } from '@pasabot/ui';
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { ApiError, api, post } from '../app/api.js';
import { useI18n } from '../app/i18n.js';
import { usePrefs } from '../app/prefs.js';
import { navigate } from '../app/router.js';
import { useStore } from '../app/store.js';
import { usePlainWords } from '../app/words.js';
import { fillComposer } from './compose.js';
import { time } from './format.js';

type Words = (key: string, opts?: Record<string, unknown>) => string;

/** a card's words in the reader's language: a key (with its plain wording while "Technical words" is off) or text */
export function cardWords(w: Words, x: CardText | undefined, lang: string): string {
  if (!x) return '';
  if ('text' in x) return x.text;
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x.params ?? {}))
    params[k] = k.endsWith('At') && typeof v === 'number' ? time(v, lang) : v;
  return w(x.key, params);
}

/** where a card's tap goes: the server (settle or do), then the app page it names, or a message sent in the chat */
async function tap(card: CardData, a: CardAction, chatId: string | null): Promise<CardData | null> {
  let next: CardData | null = null;
  if (a.send && chatId) await post(`/api/v1/chats/${chatId}/messages`, { text: a.send, mode: 'steer' });
  if (a.server || a.settle || a.send) {
    const r = await post<{ card: CardData }>(`/api/v1/cards/${card.id}/act`, { action: a.id });
    next = r.card;
  }
  if (a.href) navigate(a.href.slice(1));
  return next;
}

/** One card from its block data. Only the owner answers; everyone else reads it. */
export function CardView({ data, chatId }: { data: CardData; chatId: string | null }) {
  const { lang } = useI18n();
  const w = usePlainWords();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const technical = usePrefs((s) => s.advanced);
  const agent = useStore((s) => (data.agentId ? s.agents[data.agentId] : undefined));
  const [local, setLocal] = useState<CardData>(data);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // the server's copy wins whenever it changes (another device answered, the cause went away)
  useEffect(() => setLocal(data), [data]);
  // the technical words are the owner's only (never in the block every reader gets): fetched for Details
  const [detail, setDetail] = useState<string | null>(null);
  const wantDetail = owner && technical && !!local.hasDetail;
  useEffect(() => {
    if (!wantDetail) return;
    let gone = false;
    api<{ detail: string | null }>(`/api/v1/cards/${local.id}/detail`)
      .then((r) => {
        if (!gone) setDetail(r?.detail ?? null);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [wantDetail, local.id]);
  const act = async (a: CardAction) => {
    setBusy(true);
    setErr(null);
    try {
      const next = await tap(local, a, chatId);
      if (next) setLocal(next);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? w('cards.stale') : w('cards.failed'));
    } finally {
      setBusy(false);
    }
  };
  const actions: HelperCardAction[] = owner
    ? local.actions.map((a) => ({
        id: a.id,
        label: cardWords(w, a.label, lang),
        style: a.style ?? 'secondary',
        onAction: () => void act(a),
      }))
    : [];
  const settled =
    local.settled !== undefined ? cardWords(w, local.settled, lang) : w(`cards.settled.${local.state}`);
  return (
    <HelperCard
      id={local.id}
      variant={local.variant}
      kicker={
        local.needsAnswer && local.state === 'open'
          ? w('cards.needsOk')
          : local.variant === 'suggestion'
            ? w('cards.idea')
            : agent
              ? agent.name
              : undefined
      }
      badge={agent ? <AgentAvatar agentId={agent.id} salt={agent.avatarSalt} size={24} /> : undefined}
      title={cardWords(w, local.title, lang)}
      text={cardWords(w, local.text, lang) || undefined}
      visual={local.visual ? <CardVisualView visual={local.visual} /> : undefined}
      actions={actions}
      state={local.state}
      settledLabel={settled}
      details={wantDetail && detail ? { label: w('cards.details'), text: detail } : undefined}
      busy={busy}
      error={err ?? undefined}
      urgent={local.variant === 'error' && local.needsAnswer && local.state === 'open'}
    />
  );
}

/** A card's preview: a file the helper made (Open / Download) or the live picture of a browser it hands over. */
function CardVisualView({ visual }: { visual: NonNullable<CardData['visual']> }) {
  const w = usePlainWords();
  const { lang } = useI18n();
  if (visual.kind === 'file') {
    const kb = Math.max(1, Math.round(visual.size / 1024));
    let size = `${kb} KB`;
    try {
      size = new Intl.NumberFormat(lang, { style: 'unit', unit: 'kilobyte' }).format(kb);
    } catch {
      // an old browser: the plain number
    }
    return (
      <div className="card-file" data-testid="card-file">
        <span className="card-file__name">{visual.name}</span>
        <span className="muted"> · {size}</span>
        <div className="card-file__acts">
          <a className="bk-btn bk-btn--secondary" href={visual.url} target="_blank" rel="noreferrer">
            {w('cards.open')}
          </a>
          <a className="bk-btn bk-btn--ghost" href={visual.url} download={visual.name}>
            {w('cards.download')}
          </a>
        </div>
      </div>
    );
  }
  return <BrowserLive profileId={visual.profileId} />;
}

/** The browser's live picture: the last frame over REST, then each live frame on the owner topic. */
function BrowserLive({ profileId }: { profileId: string }) {
  const w = usePlainWords();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    api<{ data?: string }>(`/api/m/browser/profiles/${encodeURIComponent(profileId)}/frame`)
      .then((f) => {
        if (!gone && f?.data) setSrc(`data:image/jpeg;base64,${f.data}`);
      })
      .catch(() => {});
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; data: { profileId?: string; data?: string } }>).detail;
      if (d?.type === 'browser.frame' && d.data?.profileId === profileId && d.data.data)
        setSrc(`data:image/jpeg;base64,${d.data.data}`);
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => {
      gone = true;
      window.removeEventListener(LIVE_EVENT, on);
    };
  }, [profileId]);
  return src ? (
    <img src={src} alt={w('cards.browserAlt')} data-testid="card-browser-live" />
  ) : (
    <p className="muted" data-testid="card-browser-wait">
      {w('cards.browserWait')}
    </p>
  );
}

// ---------- the open cards that need an answer (the pinned decision bar) ----------
let openCards: OpenCardDTO[] = [];
const openListeners = new Set<() => void>();
const setOpenCards = (list: OpenCardDTO[]) => {
  openCards = list;
  for (const l of openListeners) l();
};
export function useOpenCards(): OpenCardDTO[] {
  return useSyncExternalStore(
    (l) => {
      openListeners.add(l);
      return () => openListeners.delete(l);
    },
    () => openCards,
    () => openCards,
  );
}
/** Keeps the open-card list fresh for the owner: on mount, on every `card.changed`, and every 60 s. */
export function OpenCardsProbe({ owner }: { owner: boolean }) {
  const load = useCallback(() => {
    if (!owner) return;
    api<{ cards: OpenCardDTO[] }>('/api/v1/cards')
      .then((r) => setOpenCards(r.cards ?? []))
      .catch(() => {});
  }, [owner]);
  useEffect(() => {
    if (!owner) {
      setOpenCards([]);
      return;
    }
    load();
    const on = (e: Event) => {
      const t = (e as CustomEvent<{ type: string }>).detail?.type;
      if (t === 'card.changed') load();
    };
    window.addEventListener(LIVE_EVENT, on);
    const iv = setInterval(load, 60_000);
    return () => {
      window.removeEventListener(LIVE_EVENT, on);
      clearInterval(iv);
    };
  }, [owner, load]);
  return null;
}

// ---------- suggestions: "what can I ask next" (home, empty chat, after the first reply) ----------
const IDEAS = ['plan', 'remind', 'write', 'find'] as const;
/**
 * Suggestions as a row of chips: a tap puts the example in the chat's message box (on the home screen, the main
 * helper's chat opens first), where the owner can change it and send it. Nothing is sent for them.
 */
export function SuggestionCards({
  chatId,
  testId = 'suggestions',
  compact,
}: {
  chatId: string | null;
  testId?: string;
  compact?: boolean;
}) {
  const { lang } = useI18n();
  const w = usePlainWords();
  const hintId = useId();
  if (!chatId) return null;
  const fill = (text: string) => {
    if (!location.hash.startsWith(`#/chats/${chatId}`)) navigate(`/chats/${chatId}`);
    fillComposer(chatId, text);
  };
  return (
    <section className="suggest" aria-label={w('cards.suggest.title')} data-testid={testId} lang={lang}>
      <p className="suggest__title">{w('cards.suggest.title')}</p>
      <p className="suggest__hint muted" id={hintId}>
        {w('cards.suggest.hint')}
      </p>
      <div className="suggest__list">
        {IDEAS.slice(0, compact ? 3 : 4).map((k) => {
          const text = w(`cards.suggest.${k}.send`);
          return (
            <button
              key={k}
              type="button"
              className="suggest__chip"
              data-testid={`suggest-${k}`}
              aria-label={`${w('cards.suggest.send')}: ${text}`}
              aria-describedby={hintId}
              onClick={() => fill(text)}
            >
              {w(`cards.suggest.${k}.title`)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
