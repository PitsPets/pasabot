/**
 * Composer: Enter sends, Shift+Enter breaks the line. While the agent is working a new message is always added to the
 * running turn (steer); the other two ways (send after it finishes, stop it and send this) sit in a small menu beside
 * Send, so nobody has to pick a queueing strategy to type. Queued items show as a chip.
 * A chat the person may only read (an observer) gets a disabled composer with a plain read-only note (W39).
 */
import { displayLocale } from '@pasabot/i18n';
import type { QueueItemDTO } from '@pasabot/protocol';
import { Button, Icon, Menu } from '@pasabot/ui';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, post } from '../app/api.js';
import { useI18n, useT } from '../app/i18n.js';
import { slots } from '../app/slots.js';
import { useStore } from '../app/store.js';
import { ComposerActionSlots } from '../shell/slots.js';
import { COMPOSE_EVENT, takeComposerText } from './compose.js';

/**
 * Stop all's paused state, as the safety module announces it (`<html data-paused data-paused-since>` and the
 * `pasabot:paused` event); `pasabot:resume` asks its on-screen stop control to open the Start-again sheet.
 */
const PAUSED_EVENT = 'pasabot:paused';
const RESUME_EVENT = 'pasabot:resume';
type Paused = { stopped: boolean; since: number | null };
const readPaused = (): Paused => {
  const d = typeof document === 'undefined' ? undefined : document.documentElement.dataset;
  const since = Number(d?.pausedSince);
  return { stopped: d?.paused === '1', since: Number.isFinite(since) && since > 0 ? since : null };
};
export function usePaused(): Paused {
  const [p, setP] = useState(readPaused);
  useEffect(() => {
    const on = () => setP(readPaused());
    window.addEventListener(PAUSED_EVENT, on);
    on();
    return () => window.removeEventListener(PAUSED_EVENT, on);
  }, []);
  return p;
}

/** "since 9:54 PM" today, "since Nov 13, 9:54 PM" on another day, in the app's language */
function pausedSince(ms: number, lang: string): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(
    displayLocale(lang),
    today
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
}

/** Everything is paused (Stop all): say so above the box, and Send waits until it is started again. */
function PausedBanner({ since, id }: { since: number | null; id: string }) {
  const { t, lang } = useI18n();
  const owner = useStore((s) => s.me?.kind === 'owner');
  return (
    <div className="comp-paused" role="status" data-testid="paused-banner" id={id}>
      <span className="grow">
        {since ? t('chat.paused.since', { when: pausedSince(since, lang) }) : t('chat.paused.now')}{' '}
        <span>{owner ? t('chat.paused.hint') : t('chat.paused.hintMember')}</span>
      </span>
      {owner && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => window.dispatchEvent(new CustomEvent(RESUME_EVENT))}
        >
          {t('chat.paused.start')}
        </Button>
      )}
    </div>
  );
}

type Mode = 'steer' | 'queue' | 'interrupt';
const EMPTY: QueueItemDTO[] = [];
const SHOWN = new Set(['queued', 'held', 'failed']);

export function Composer({
  chatId,
  agentId,
  agentName,
  working,
  readOnly = false,
  replyIn = null,
  onReplyDone,
}: {
  chatId: string;
  agentId: string | null;
  agentName: string;
  working: boolean;
  readOnly?: boolean;
  /** a reply in a thread (a request another helper sent): where it goes, and whose request it answers */
  replyIn?: { id: string; name: string } | null;
  onReplyDone?(): void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  // the server said this chat is read-only for us (a role changed while the chat was open)
  const [refused, setRefused] = useState(false);
  const locked = readOnly || refused;
  const paused = usePaused();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new chat starts unrefused
  useEffect(() => setRefused(false), [chatId]);
  const inputId = useId();
  // a suggestion the owner tapped lands here to change and send (never sent for them)
  useEffect(() => {
    const take = () => {
      const t = takeComposerText(chatId);
      if (t === null) return;
      setText(t);
      requestAnimationFrame(() => {
        const el = document.getElementById(inputId) as HTMLTextAreaElement | null;
        el?.focus();
        el?.setSelectionRange(t.length, t.length);
      });
    };
    take();
    const on = (e: Event) => {
      if ((e as CustomEvent<{ chatId: string }>).detail?.chatId === chatId) take();
    };
    window.addEventListener(COMPOSE_EVENT, on);
    return () => window.removeEventListener(COMPOSE_EVENT, on);
  }, [chatId, inputId]);
  // "Reply in thread": the cursor goes to the composer, which now says where the reply goes
  useEffect(() => {
    if (replyIn) (document.getElementById(inputId) as HTMLTextAreaElement | null)?.focus();
  }, [replyIn, inputId]);
  /** sends go out one after another, in the order typed; a message typed while one is in flight is never lost */
  const outbox = useRef<Promise<void>>(Promise.resolve());

  const send = (e?: FormEvent, mode: Mode = 'steer') => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || locked || paused.stopped) return;
    setText('');
    setNote(null);
    const how = working ? mode : 'steer';
    const thread = replyIn;
    onReplyDone?.();
    outbox.current = outbox.current.then(async () => {
      try {
        const r = await post<{ steered?: boolean }>(`/api/v1/chats/${chatId}/messages`, {
          text: body,
          mode: how,
          ...(thread ? { replyTo: thread.id } : {}),
        });
        if (r.steered) setNote(t('chat.steered', { name: agentName }));
      } catch (err) {
        // nothing typed since: the unsent text comes back so it can be sent again
        setText((cur) => (cur.trim() ? cur : body));
        if (err instanceof ApiError && err.code === 'read_only') {
          setRefused(true);
          setNote(null);
          return;
        }
        setNote(err instanceof ApiError && err.status === 503 ? t('chat.queueFull') : t('errors.generic'));
      }
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  if (locked)
    return (
      <div className="comp" data-testid="composer-readonly">
        <div className="field">
          <label htmlFor={inputId} className="bk-visually-hidden">
            {t('chat.readOnlyLabel')}
          </label>
          <textarea
            id={inputId}
            className="ph"
            rows={1}
            value=""
            placeholder={t('chat.readOnlyLabel')}
            disabled
            aria-describedby={`${inputId}-ro`}
            data-testid="composer"
          />
        </div>
        <p className="comp-note" id={`${inputId}-ro`} role="note" data-testid="readonly-note">
          {t('chat.readOnlyNote')}
        </p>
      </div>
    );

  return (
    <div className="comp">
      {agentId && <QueueChip agentId={agentId} chatId={chatId} agentName={agentName} />}
      {paused.stopped && <PausedBanner since={paused.since} id={`${inputId}-paused`} />}
      {replyIn && (
        <p className="comp-thread" data-testid="composer-thread">
          <Icon name="chats" size={16} />
          <span className="grow">{t('chat.thread.replying', { name: replyIn.name })}</span>
          <button
            type="button"
            className="comp-thread-x"
            onClick={onReplyDone}
            data-testid="composer-thread-clear"
          >
            {t('chat.thread.stopReply')}
          </button>
        </p>
      )}
      <form className="field" onSubmit={send}>
        <label htmlFor={inputId} className="bk-visually-hidden">
          {t('chat.placeholder', { name: agentName })}
        </label>
        <textarea
          id={inputId}
          className="ph"
          dir="auto"
          rows={1}
          value={text}
          placeholder={t('chat.placeholder', { name: agentName })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          data-testid="composer"
          maxLength={100_000}
        />
        <ComposerActionSlots slots={slots} chatId={chatId} />
        {working && agentId && text.trim() && !paused.stopped && (
          <Menu
            label={t('chat.mode.more')}
            trigger={<Icon name="chevron" size={16} className="bk-icon--down" />}
            triggerClass="go-more"
            triggerTestId="send-more"
            align="end"
            items={[
              { id: 'queue', label: t('chat.mode.queue'), onSelect: () => send(undefined, 'queue') },
              {
                id: 'interrupt',
                label: t('chat.mode.interrupt'),
                onSelect: () => send(undefined, 'interrupt'),
              },
            ]}
          />
        )}
        <button
          type="submit"
          className="go"
          aria-label={t('chat.send')}
          title={working && !paused.stopped ? t('chat.mode.steer') : undefined}
          disabled={!text.trim() || paused.stopped}
          aria-describedby={paused.stopped ? `${inputId}-paused` : undefined}
        >
          <Icon name="send" />
        </button>
      </form>
      {note && (
        <p className="comp-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function QueueChip({ agentId, chatId, agentName }: { agentId: string; chatId: string; agentName: string }) {
  const t = useT();
  const all = useStore((s) => s.queues[agentId] ?? EMPTY);
  const items = all.filter((q) => q.chatId === chatId && SHOWN.has(q.state));
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (items.length === 0) return null;
  const queued = items.filter((i) => i.state !== 'failed').length;
  const failed = items.length - queued;
  const act = async (id: string, verb: 'retry' | 'skip' | 'cancel') => {
    await post(`/api/v1/queue/${id}/${verb}`).catch(() => {});
  };
  return (
    <div className="qd-wrap">
      <button
        type="button"
        className="qd"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        data-testid="queue-chip"
      >
        <b>{queued ? t('chat.queued', { count: queued }) : t('chat.failedCount', { count: failed })}</b>
        <span>{t('chat.queueHint', { name: agentName })}</span>
      </button>
      {open && (
        <ul className="qlist plain" id={listId}>
          {items.map((q, i) => (
            <li key={q.id} className="row" data-testid="queue-item" data-state={q.state}>
              <span className="grow">
                {t('chat.queueItem', { n: i + 1 })} · {t(`chat.qstate.${q.state}`)}
              </span>
              {q.state === 'failed' && (
                <Button size="sm" onClick={() => act(q.id, 'retry')}>
                  {t('core:common.retry')}
                </Button>
              )}
              {q.state === 'interrupted' && (
                <Button size="sm" onClick={() => act(q.id, 'skip')}>
                  {t('core:common.skip')}
                </Button>
              )}
              {(q.state === 'queued' || q.state === 'held') && (
                <Button size="sm" variant="ghost" onClick={() => act(q.id, 'cancel')}>
                  {t('core:common.cancel')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
