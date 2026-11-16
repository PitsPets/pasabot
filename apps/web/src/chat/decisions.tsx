/**
 * THE pinned decision bar (W39) and its Review list: every pending decision of any kind, above every screen. Kept out
 * of approvals.tsx so the card helpers stay importable without the router.
 */
import type { DecisionItem } from '@pasabot/core/web';
import type { ApprovalDTO } from '@pasabot/protocol';
import { Button, DecisionBar, Sheet } from '@pasabot/ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n, useT } from '../app/i18n.js';
import { match, navigate, useRoute } from '../app/router.js';
import { slots } from '../app/slots.js';
import { directChatOf, type State, useStore } from '../app/store.js';
import { usePlainWords } from '../app/words.js';
import { DecisionSourceSlots } from '../shell/slots.js';
import { approvalTitle, decide, FullApprovalCard, ReauthSheet } from './approvals.js';
import { CardView, cardWords, OpenCardsProbe, useOpenCards } from './cards.js';

/**
 * Module decisions (budget cap cards, skill-permission proposals, ...) reported by the `decisionSources` slot, kept
 * outside React state so the top-bar counts and the pinned bar read the same list.
 */
let moduleItems: Record<string, DecisionItem[]> = {};
const itemListeners = new Set<() => void>();
let itemsSnapshot: DecisionItem[] = [];
export const reportModuleDecisions = (id: string, items: DecisionItem[]) => {
  if (!items.length && !moduleItems[id]?.length) return;
  moduleItems = { ...moduleItems, [id]: items };
  itemsSnapshot = Object.values(moduleItems).flat();
  for (const l of itemListeners) l();
};
export function useModuleDecisions(): DecisionItem[] {
  return useSyncExternalStore(
    (l) => {
      itemListeners.add(l);
      return () => itemListeners.delete(l);
    },
    () => itemsSnapshot,
    () => itemsSnapshot,
  );
}

/** The chat an approval's card lives in: its link, else a loaded message holding its card, else the agent's direct chat. */
export function approvalChat(s: State, a: ApprovalDTO): string | null {
  const fromHref = a.href ? match('/chats/:id', a.href)?.id : undefined;
  if (fromHref) return fromHref;
  if (!a.runId) return null;
  for (const [chatId, list] of Object.entries(s.messages))
    if (
      list.some((m) =>
        m.blocks.some((b) => b.kind === 'core.approval' && (b.data as { id?: string }).id === a.id),
      )
    )
      return chatId;
  return a.agentId ? (directChatOf(s, a.agentId)?.id ?? null) : null;
}

/** Pending approvals of any kind the signed-in person can see (chat runs, workflows, always-ask), oldest deadline first. */
export const isPendingApproval = (a: ApprovalDTO) => a.state === 'pending';
/** A workflow's approval step (no chat, no run): with nothing else waiting, the bar answers it right there. */
const answerableInBar = (a: ApprovalDTO) => !a.runId && !!a.subject && !a.ask && a.tier < 3;

/**
 * THE pinned decision bar (W39), above every screen: one bar for every pending decision of any kind (approvals of
 * chat runs, workflow steps, always-ask cards, and module decisions such as a budget cap card or a skill-permission
 * proposal), with the count and a Review list where each one is answered or opened. A chat never draws a second bar,
 * and a chat run's approval stays pinned here on every other screen too. Members and guests see the approvals of
 * their chats (only the owner decides); module decisions are the owner's.
 */
export function DecisionCenter() {
  const t = useT();
  const route = useRoute();
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const role = useStore((s) => s.me?.kind ?? null);
  const owner = role === 'owner';
  const mods = useModuleDecisions();
  // W40: cards that need an answer (sign in again, a key, "a few things need your OK"), from the server's list
  const cards = useOpenCards();
  const { lang } = useI18n();
  const w = usePlainWords();
  const chatOf = useStore((s) =>
    Object.values(s.approvals)
      .filter(isPendingApproval)
      .map((a) => `${a.id}=${approvalChat(s, a) ?? ''}`)
      .join(','),
  );
  const chatIds = Object.fromEntries(chatOf ? chatOf.split(',').map((x) => x.split('=')) : []) as Record<
    string,
    string
  >;
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  // the Review list shows the first few cards; the rest behind "N more"
  const [allCards, setAllCards] = useState(false);
  // the server refused the approve because a screen helper just acted: the bar says so instead of the title
  const [screenWait, setScreenWait] = useState<string | null>(null);
  const report = useCallback(reportModuleDecisions, []);
  const currentChat = match('/chats/:id', route.path)?.id ?? null;
  const list = Object.values(approvals)
    .filter(isPendingApproval)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  const items = [...mods].sort(
    (a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER),
  );
  const count = list.length + items.length + cards.length;
  const onlyCards = !list.length && !items.length && cards.length > 0;
  // the only decisions are cards already in the open chat: they are on the screen, a bar above them says it twice
  const cardsHere = onlyCards && cards.every((c) => c.chatId === currentChat);
  const shownCards = allCards ? cards : cards.slice(0, CARDS_SHOWN);
  // once nothing is waiting the Review list is done: a later decision shows in the bar, it does not pop the list open
  useEffect(() => {
    if (!count) setReview(false);
    if (!count) setAllCards(false);
  }, [count]);
  const nameOf = (a: ApprovalDTO) => (a.agentId ? agents[a.agentId]?.name : undefined) ?? t('chat.someone');
  const sources = (
    <>
      <DecisionSourceSlots slots={slots} viewer={role} report={report} />
      <OpenCardsProbe owner={owner} />
    </>
  );
  const onlyHere =
    list.length > 0 &&
    !items.length &&
    !cards.length &&
    list.every((a) => !a.ask && chatIds[a.id] === currentChat);

  const sheet = (
    <Sheet open={review && count > 0} title={t('approval.review')} onClose={() => setReview(false)}>
      <div className="stack" data-testid="decision-review">
        <p className="muted">{owner ? t('decisions.intro') : t('decisions.ownerOnly')}</p>
        <ul className="plain stack" aria-label={t('decisions.title')}>
          {list.map((a) => (
            <li key={a.id} data-decision-kind="approval" data-decision-id={a.id}>
              {/* an always-ask card is always shown in full here: the owner sees exactly what will happen */}
              {!a.ask && chatIds[a.id] && chatIds[a.id] === currentChat ? (
                <div className="row">
                  <span className="grow">{approvalTitle(t, a, nameOf(a))}</span>
                  <Button
                    onClick={() => {
                      setReview(false);
                      jumpToCard(a.id);
                    }}
                  >
                    {t('decisions.showInChat')}
                  </Button>
                </div>
              ) : (
                <>
                  <FullApprovalCard a={a} agentName={nameOf(a)} />
                  {chatIds[a.id] && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setReview(false);
                        navigate(`/chats/${chatIds[a.id]}`);
                      }}
                    >
                      {t('decisions.openChat')}
                    </Button>
                  )}
                </>
              )}
            </li>
          ))}
          {shownCards.map((c) => (
            <li key={c.id} data-decision-kind="card" data-decision-id={c.id}>
              <CardView data={c.card} chatId={c.chatId} />
              <Button
                variant="ghost"
                onClick={() => {
                  setReview(false);
                  navigate(`/chats/${c.chatId}`);
                  setTimeout(() => jumpTo(`card-${c.id}`), 300);
                }}
              >
                {t('decisions.openChat')}
              </Button>
            </li>
          ))}
          {shownCards.length < cards.length && (
            <li>
              <Button variant="ghost" onClick={() => setAllCards(true)} data-testid="decision-more">
                {w('cards.more', { count: cards.length - shownCards.length })}
              </Button>
            </li>
          )}
          {items.map((i) => {
            const R = i.review;
            return (
              <li key={i.id} data-decision-kind="module" data-decision-id={i.id}>
                <p className="decision-item__title">
                  <b>{i.title}</b>
                  {i.text ? ` · ${i.text}` : ''}
                </p>
                {R && <R />}
                {i.href && (
                  <a
                    className="bk-btn bk-btn--secondary"
                    href={i.href.startsWith('#/') ? i.href : '#/'}
                    onClick={() => setReview(false)}
                  >
                    {t('decisions.open')}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Sheet>
  );
  // the probes and the re-auth sheet keep one place in the tree whether or not the bar shows (a probe that remounted
  // on every count change would reload its module's list in a loop)
  if (!count || cardsHere)
    return (
      <>
        {sources}
        {null}
        <ReauthSheet />
      </>
    );
  const first = list[0];
  const firstText = first
    ? first.ask
      ? `${t(`approval.askClass.${first.ask.class}`)} · ${approvalTitle(t, first, nameOf(first))}`
      : approvalTitle(t, first, nameOf(first))
    : (items[0]?.title ?? (cards[0] ? cardWords(w, cards[0].card.title, lang) : ''));
  const answer = async (d: 'approve' | 'deny') => {
    if (!first) return;
    setBusy(true);
    try {
      setScreenWait((await decide(first, d)) === 'busy' ? first.id : null);
    } finally {
      setBusy(false);
    }
  };
  const inline = owner && count === 1 && !!first && answerableInBar(first);
  return (
    <>
      {sources}
      <div
        className="decisions-detached"
        data-approval
        data-state="pending"
        data-testid="detached-decisions"
        tabIndex={-1}
      >
        {inline ? (
          <DecisionBar
            title={t('approval.waiting', { count })}
            text={screenWait && screenWait === first?.id ? t('approval.screenBusy') : firstText}
            actionLabel={t('approval.approve')}
            onAction={() => void answer('approve')}
            secondary={{ label: t('approval.deny'), onAction: () => void answer('deny') }}
            busy={busy}
          />
        ) : (
          <DecisionBar
            title={onlyCards ? t('cards.stillNeed', { count }) : t('approval.waiting', { count })}
            text={firstText}
            actionLabel={t('approval.review')}
            // the only decisions are cards in the open chat: Review goes to the first card, as before
            onAction={() => (onlyHere && first ? jumpToCard(first.id) : setReview(true))}
            busy={busy}
          />
        )}
        {sheet}
      </div>
      <ReauthSheet />
    </>
  );
}

const CARDS_SHOWN = 3;
function jumpToCard(id: string) {
  jumpTo(`approval-${id}`);
}
function jumpTo(elId: string) {
  const el = document.getElementById(elId);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el?.focus({ preventScroll: true });
}
