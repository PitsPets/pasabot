/**
 * One chat: header, the message log (streaming replies, tool-activity line,
 * approval cards, interrupted-turn cards, module blocks) and the composer with the queued-message chip. Pending
 * decisions are pinned by the one decision bar above every screen (W39), never by a second bar in here; a chat the
 * person may only read shows a disabled composer that says so.
 */
import type { MessageDTO } from '@pasabot/protocol';
import { AgentAvatar, Icon } from '@pasabot/ui';
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { brainState } from '../agents/BrainPicker.js';
import { post } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { useRoute } from '../app/router.js';
import { slots } from '../app/slots.js';
import { agentStatus, chatAgentId, loadMessages, useStore } from '../app/store.js';
import { HeaderWidgetSlots } from '../shell/slots.js';
import { ChatMore } from './ChatMore.js';
import { Composer, usePaused } from './Composer.js';
import { SuggestionCards } from './cards.js';
import { MessageItem } from './MessageItem.js';
import { ChatModelPicker } from './ModelPicker.js';
import { groupThreads, leaveThreads, markThreadsSeen, Thread, taskIdOf, threadOf } from './threads.js';

const EMPTY: MessageDTO[] = [];

export function ChatView({
  chatId,
  onShowDetails,
  detailsOpen,
}: {
  chatId: string;
  onShowDetails(): void;
  detailsOpen: boolean;
}) {
  const t = useT();
  const chat = useStore((s) => s.chats[chatId]);
  const messages = useStore((s) => s.messages[chatId] ?? EMPTY);
  const agentId = chatAgentId(chat);
  const agent = useStore((s) => (agentId ? s.agents[agentId] : undefined));
  const status = useStore((s) => (agentId ? agentStatus(s, agentId) : 'idle'));
  const owner = useStore((s) => s.me?.kind === 'owner');
  // observers read, never write (owners always write); the server refuses a write too
  const readOnly = useStore((s) => {
    const me = s.me;
    if (!me || me.kind === 'owner') return false;
    const row = s.chats[chatId]?.members.find((m) => m.kind === 'user' && m.id === me.id);
    return row?.role === 'observer';
  });
  const provider = useStore((s) => s.providers.find((p) => p.id === agent?.providerId));
  // a helpers' own conversation (Team talk): who asked whom; it reads as theirs, yet the owner can still write
  const teamFrom = useStore((s) => {
    const f = s.chats[chatId]?.settings?.collabFrom;
    return typeof f === 'string' ? (s.agents[f] ?? null) : undefined;
  });
  // requests from other helpers are threads here (who asked, then this helper's work and answer under it)
  const entries = useMemo(() => groupThreads(messages), [messages]);
  const route = useRoute();
  const wantThread = route.query.get('thread');
  const wantTask = route.query.get('task');
  const focusId = useMemo(() => {
    if (wantThread) return wantThread;
    if (!wantTask) return null;
    return messages.find((m) => threadOf(m) && taskIdOf(m) === wantTask)?.id ?? null;
  }, [messages, wantThread, wantTask]);
  // a reply in a thread: the composer says where it goes, and the message points into that thread
  const [replyIn, setReplyIn] = useState<{ id: string; name: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another chat starts with a normal message
  useEffect(() => setReplyIn(null), [chatId]);
  useEffect(() => {
    if (owner && messages.length)
      markThreadsSeen(
        chatId,
        messages.reduce((n, m) => Math.max(n, m.createdAt), 0),
      );
  }, [owner, chatId, messages]);
  // leaving the chat: what came in while it was open stays seen
  useEffect(() => {
    if (!owner) return;
    return () => leaveThreads(chatId);
  }, [owner, chatId]);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [err, setErr] = useState(false);
  // the chat whose messages arrived at least once (the starter ideas never flash before that)
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    setErr(false);
    stick.current = true;
    loadMessages(chatId)
      .then(() => setLoadedFor(chatId))
      .catch(() => setErr(true));
  }, [chatId]);

  // keep the newest message in view unless the reader scrolled up
  const streamsKey = useStore((s) => messages.map((m) => s.streams[m.id]?.length ?? 0).join(','));
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when messages arrive or a stream grows
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamsKey]);
  // ...and when the log itself changes size (the window resized, the composer grew a line, the decision bar came
  // or went), so the newest message is never left under the composer
  const hasChat = !!chat;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attaches when the log element is (re)created
  useEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatId, hasChat]);
  /** a tap on a message shows its actions (React, Listen, Copy) under it; a tap elsewhere hides them */
  const onLogTap = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea')) return;
    const el = target.closest<HTMLElement>('[data-msg-acts]');
    for (const o of logRef.current?.querySelectorAll<HTMLElement>('[data-acts="open"]') ?? [])
      if (o !== el) delete o.dataset.acts;
    if (!el) return;
    if (el.dataset.acts === 'open') delete el.dataset.acts;
    else el.dataset.acts = 'open';
  };
  const onScroll = () => {
    const el = logRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!chat)
    return (
      <div className="page">
        <p className="muted">{err ? t('chat.notFound') : t('core:common.loading')}</p>
      </div>
    );

  // Team talk reads with the helpers' names as they are now, never the names stored when it began
  const title = (teamFrom && agent ? `${teamFrom.name} → ${agent.name}` : chat.title) || agent?.name || '';
  const sub =
    chat.kind === 'channel'
      ? t('chat.members', { count: chat.members.filter((m) => m.kind === 'agent').length })
      : // the brain is on the model pill next to it now (polish B), so the line is just the state
        // an idle agent whose brain is signed out (its last turn or test failed on sign-in) is not "Ready"
        status === 'idle' && provider && brainState(provider) === 'needsSignIn'
        ? t('status.needsSignIn')
        : t(`status.${status}`);

  return (
    <section className="chat bk-card" aria-labelledby="chat-title">
      <header className="ch">
        {/* the heading stays outside the button (a button's content is flattened into its name) */}
        <h1 id="chat-title" className="bk-visually-hidden">
          {title}
        </h1>
        <button
          type="button"
          className="ch-who"
          onClick={onShowDetails}
          aria-expanded={agent ? detailsOpen : undefined}
          disabled={!agent}
          data-testid="chat-who"
        >
          {agent ? (
            <AgentAvatar
              agentId={agent.id}
              salt={agent.avatarSalt}
              size={40}
              state={status === 'working' ? 'thinking' : 'idle'}
              status={status}
              statusLabel={t(`status.${status}`)}
            />
          ) : (
            <span className="bk-icon-tile" style={{ ['--tile' as string]: '40px' }} aria-hidden="true">
              <Icon name="channels" size={24} />
            </span>
          )}
          <span className="ch-t">
            <span className="ch-name">{title}</span>
            <span className="sub">{sub}</span>
          </span>
        </button>
        {agent && chat.kind === 'direct' && <ChatModelPicker agent={agent} />}
        <div className="ch-w">
          <HeaderWidgetSlots slots={slots} chatId={chatId} />
        </div>
        {agent && (
          <button
            type="button"
            className="bk-menu__btn ch-info"
            onClick={onShowDetails}
            aria-expanded={detailsOpen}
            aria-label={t('details.about', { name: agent.name })}
            title={t('details.about', { name: agent.name })}
            data-testid="details-toggle"
          >
            <Icon name="info" />
          </button>
        )}
        <ChatMore chatId={chatId} onToggleDetails={onShowDetails} />
      </header>
      <div className="chat-body">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a tap shows a message's actions; keyboard focus shows them too */}
        <div
          className="log"
          ref={logRef}
          onScroll={onScroll}
          onClick={onLogTap}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('chat.logLabel', { name: title })}
          data-testid="chat-log"
        >
          <h2 className="bk-visually-hidden">{t('chat.logLabel', { name: title })}</h2>
          {teamFrom !== undefined && (
            <p className="team-note" data-testid="team-note">
              <Icon name="users" size={16} />
              <span>
                {t('chat.teamNote', {
                  from: teamFrom?.name ?? t('chat.someone'),
                  to: agent?.name ?? t('chat.someone'),
                })}
              </span>
            </p>
          )}
          {messages.length === 0 && (
            <p className="muted center-note">{t('chat.empty', { name: agent?.name ?? title })}</p>
          )}
          {messages.length === 0 &&
            loadedFor === chatId &&
            agent &&
            chat.kind === 'direct' &&
            !readOnly &&
            teamFrom === undefined && <Starters key={chatId} chatId={chatId} />}
          {entries.map((e) =>
            e.kind === 'msg' ? (
              <MessageItem key={e.m.id} message={e.m} chatAgentId={agentId} />
            ) : (
              <ThreadEntry
                key={e.root.id}
                root={e.root}
                items={e.items}
                focus={focusId === e.root.id}
                canReply={!readOnly}
                chatAgentId={agentId}
                onReply={(name) => setReplyIn({ id: e.root.id, name })}
              />
            ),
          )}
          {/* W40: right after a helper's first reply, "what can I do next" as tap-to-send cards (owner only) */}
          {owner &&
            agent &&
            chat.kind === 'direct' &&
            !readOnly &&
            teamFrom === undefined &&
            suggestHere(messages) && <SuggestionCards key={chatId} chatId={chatId} compact />}
        </div>
      </div>
      <Composer
        chatId={chatId}
        agentId={agentId}
        agentName={agent?.name ?? title}
        working={status !== 'idle'}
        readOnly={readOnly}
        replyIn={replyIn}
        onReplyDone={() => setReplyIn(null)}
      />
    </section>
  );
}

/** One thread: the request another helper sent, and this helper's work and answer under it. */
function ThreadEntry({
  root,
  items,
  focus,
  canReply,
  chatAgentId,
  onReply,
}: {
  root: MessageDTO;
  items: MessageDTO[];
  focus: boolean;
  canReply: boolean;
  chatAgentId: string | null;
  onReply(name: string): void;
}) {
  const from = useStore((s) => s.agents[threadOf(root)!.from]?.name ?? '');
  return (
    <Thread
      root={root}
      items={items}
      focus={focus}
      canReply={canReply}
      onReply={() => onReply(from)}
      render={(m) => <MessageItem message={m} chatAgentId={chatAgentId} />}
    />
  );
}

/** the empty chat's ideas (FIRST-TIMER fix 16): a tap sends it as her first message; they are gone once one exists */
const STARTERS = ['can', 'week', 'message', 'dinner'] as const;
function Starters({ chatId }: { chatId: string }) {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  // Stop all: nothing is sent until it is started again, so the ideas wait too (the composer says why)
  const paused = usePaused().stopped;
  if (sent) return null;
  const say = (text: string) => {
    setSent(true);
    setFailed(false);
    post(`/api/v1/chats/${chatId}/messages`, { text, mode: 'steer' }).catch(() => {
      // nothing went out: the ideas come back so she can tap again
      setSent(false);
      setFailed(true);
    });
  };
  return (
    <section className="starters" aria-label={t('chat.startersLabel')} data-testid="starters">
      <p className="muted">{t('chat.startersTitle')}</p>
      <div className="tap-chips">
        {STARTERS.map((k) => {
          const text = t(`chat.starters.${k}`);
          return (
            <button
              key={k}
              type="button"
              className="bk-btn bk-btn--secondary starter"
              data-testid={`starter-${k}`}
              disabled={paused}
              onClick={() => say(text)}
            >
              {text}
            </button>
          );
        })}
      </div>
      {failed && (
        <p className="bk-field__error" role="alert">
          {t('errors.generic')}
        </p>
      )}
    </section>
  );
}

/**
 * "What can I ask next": in a chat the owner has not written in yet that already holds the helper's own cards (the
 * team's summary and setup cards right after onboarding), and right under a helper's first finished reply.
 */
function suggestHere(messages: readonly MessageDTO[]): boolean {
  const mine = messages.filter((m) => m.authorKind === 'user');
  if (!mine.length) return messages.length > 0;
  const replies = messages.filter((m) => m.authorKind === 'agent' && m.status === 'final' && m.runId);
  return replies.length === 1 && mine.length === 1 && messages[messages.length - 1] === replies[0];
}
