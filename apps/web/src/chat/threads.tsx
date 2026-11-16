/**
 * Helpers' work, threaded (ws/threads; owner: "dapat nasa main chat na rin nila ang message ng orchestrator,
 * nakalagay lang kung sino nag-message, parang thread").
 *
 * - In a helper's own chat, a request another helper sent is a THREAD: a small face + "From Mayumi" (set by the
 *   server, never by a model), the request, and the helper's work and answer under it (folded to "Mayumi asked ·
 *   Ligaya answered" when long). The owner can reply in it (their reply is theirs, marked as such).
 * - In the asker's chat: one calm status line ("Ligaya is working on it…") until the report comes, and the report
 *   itself says whose answer it is, with each full answer one tap away and the files they made.
 * - The chats list: "Working for Mayumi" on a helper's row while it works on another helper's request, and a dot
 *   when a request came in since the owner last opened that chat.
 *
 * Only the block data the server set is read here (`collab.thread`, `collab.status`, `collab.report`); a thread
 * label counts only on a message whose author is the asker it names.
 */
import type { CardData, MessageBlock, MessageDTO } from '@pasabot/protocol';
import { AgentAvatar, HelperCard, Icon } from '@pasabot/ui';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../app/api.js';
import { useI18n } from '../app/i18n.js';
import { slots } from '../app/slots.js';
import { type State, useStore } from '../app/store.js';
import { MessageBlockView } from '../shell/slots.js';
import { CardView } from './cards.js';
import { time } from './format.js';
import { Markdown } from './markdown.js';
import { foldAddsSomething } from './report-fold.js';

// ---------- block data ----------
export interface ThreadInfo {
  from: string;
  to: string;
  kind: string;
}
interface StatusData {
  batchId: string;
  asker: string;
  phase: 'working' | 'reporting' | 'done';
  items: { taskId: string; agentId: string; state: string }[];
}
export interface ReportItem {
  taskId: string;
  agentId: string;
  state: string;
  answer: string;
  chatId: string | null;
  messageId: string | null;
  blocks: MessageBlock[];
}
export interface ReportData {
  batchId: string;
  mode: 'report' | 'fallback';
  items: ReportItem[];
  still: string[];
}
const dataOf = <T,>(m: MessageDTO, kind: string): T | null =>
  (m.blocks.find((b) => b.kind === kind)?.data as T | undefined) ?? null;

/** The request a helper sent, when this message is one: labelled by the server, written as that same asker. */
export function threadOf(m: MessageDTO): ThreadInfo | null {
  const d = dataOf<ThreadInfo>(m, 'collab.thread');
  if (!d || m.authorKind !== 'agent' || d.from !== m.authorId) return null;
  return d;
}
export const taskIdOf = (m: MessageDTO): string | null =>
  dataOf<{ taskId?: string }>(m, 'collab.task')?.taskId ?? null;
export const reportOf = (m: MessageDTO) => dataOf<ReportData>(m, 'collab.report');
export const statusOf = (m: MessageDTO) => dataOf<StatusData>(m, 'collab.status');
export const isStoppedNote = (m: MessageDTO) => !!dataOf<{ key?: string }>(m, 'collab.note');

// ---------- grouping ----------
export type LogEntry =
  | { kind: 'msg'; m: MessageDTO }
  | { kind: 'thread'; root: MessageDTO; items: MessageDTO[] };

/**
 * The chat's messages with each thread gathered under its request: a message joins a thread when it answers one of
 * its messages (`replyTo`) or belongs to a run that already did (that run's approval and cards).
 */
export function groupThreads(messages: readonly MessageDTO[]): LogEntry[] {
  const out: LogEntry[] = [];
  const groups = new Map<string, MessageDTO[]>();
  const rootOf = new Map<string, string>();
  const runRoot = new Map<string, string>();
  for (const m of messages) {
    if (threadOf(m)) {
      const items: MessageDTO[] = [];
      groups.set(m.id, items);
      rootOf.set(m.id, m.id);
      out.push({ kind: 'thread', root: m, items });
      continue;
    }
    const r = (m.replyTo ? rootOf.get(m.replyTo) : undefined) ?? (m.runId ? runRoot.get(m.runId) : undefined);
    if (r) {
      groups.get(r)!.push(m);
      rootOf.set(m.id, r);
      if (m.runId) runRoot.set(m.runId, r);
      continue;
    }
    out.push({ kind: 'msg', m });
  }
  return out;
}

const listOf = (lang: string, names: string[]) => {
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
};
const nameIn = (agents: State['agents'], id: string, fallback: string) => agents[id]?.name ?? fallback;

// ---------- a thread in the receiving helper's chat ----------
export function Thread({
  root,
  items,
  focus,
  canReply,
  onReply,
  render,
}: {
  root: MessageDTO;
  items: MessageDTO[];
  focus: boolean;
  canReply: boolean;
  onReply(): void;
  render(m: MessageDTO): React.ReactNode;
}) {
  const { t, lang } = useI18n();
  const th = threadOf(root)!;
  const from = useStore((s) => s.agents[th.from]);
  const to = useStore((s) => s.agents[th.to]);
  const fromName = from?.name ?? t('chat.someone');
  const toName = to?.name ?? t('chat.someone');
  const working = items.some((m) => m.status === 'streaming');
  const answered = items.some(
    (m) => m.authorKind === 'agent' && m.authorId === th.to && m.status !== 'streaming',
  );
  const size = items.reduce((n, m) => n + m.body.length, 0);
  // a long finished thread folds to one line; one being worked on (or opened from a link) stays open
  const long = !working && (items.length > 2 || size > 600);
  const [open, setOpen] = useState(!long || focus);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'center' }));
  }, [focus]);
  return (
    <section
      ref={ref}
      className={`thread${focus ? ' thread--focus' : ''}`}
      data-testid="thread"
      data-thread-id={root.id}
      aria-label={t('chat.thread.label', { name: fromName })}
    >
      <div className="thread-from" data-testid="thread-from">
        {from && <AgentAvatar agentId={from.id} salt={from.avatarSalt} size={20} shape="circle" />}
        <span className="thread-from-t">{t('chat.thread.from', { name: fromName })}</span>
        <span className="time">{time(root.createdAt, lang)}</span>
      </div>
      {root.body && (
        <div className="thread-ask md" dir="auto" data-testid="thread-ask">
          <Markdown text={root.body} />
        </div>
      )}
      {long && !open ? (
        <button
          type="button"
          className="thread-sum"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          data-testid="thread-expand"
        >
          {to && <AgentAvatar agentId={to.id} salt={to.avatarSalt} size={20} shape="circle" />}
          <span className="thread-sum-t">
            {answered
              ? t('chat.thread.summary', { from: fromName, to: toName })
              : t('chat.thread.working', { name: toName })}
          </span>
          <span className="thread-sum-more">{t('chat.thread.show')}</span>
          <Icon name="chevron" size={16} />
        </button>
      ) : (
        <div className="thread-items" data-testid="thread-items">
          {items.map((m) => (
            <div key={m.id}>{render(m)}</div>
          ))}
          {long && (
            <button
              type="button"
              className="thread-fold"
              aria-expanded={true}
              onClick={() => setOpen(false)}
              data-testid="thread-fold"
            >
              {t('chat.thread.hide')}
            </button>
          )}
        </div>
      )}
      {canReply && (
        <button type="button" className="thread-reply" onClick={onReply} data-testid="thread-reply">
          <Icon name="chats" size={16} />
          <span>{t('chat.thread.reply')}</span>
        </button>
      )}
    </section>
  );
}

// ---------- the asker's chat: the calm status line, the report, the server's own card ----------
const FINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
/** a helper's task that was stopped (Stop all, the asker's Stop): said as stopped, never as a failure */
const STOPPED = new Set(['cancelled', 'interrupted']);

export function ReportStatus({ data }: { data: StatusData }) {
  const { t, lang } = useI18n();
  const agents = useStore((s) => s.agents);
  if (data.phase === 'done') return null;
  const busy = data.items.filter((i) => !FINAL.has(i.state)).map((i) => nameIn(agents, i.agentId, '…'));
  const names = [...new Set(busy)];
  const text = names.length
    ? names.length === 1
      ? t('chat.report.workingOne', { name: names[0] })
      : t('chat.report.workingMany', { names: listOf(lang, names) })
    : data.phase === 'reporting'
      ? t('chat.report.reading', { name: nameIn(agents, data.asker, t('chat.someone')) })
      : null;
  if (!text) return null;
  const first = data.items.find((i) => !FINAL.has(i.state)) ?? data.items[0];
  const who = first ? agents[first.agentId] : undefined;
  return (
    <p className="report-status" role="status" data-testid="report-status">
      {who && (
        <AgentAvatar agentId={who.id} salt={who.avatarSalt} size={20} shape="circle" state="thinking" />
      )}
      <span className="dots live" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{text}</span>
    </p>
  );
}

/** "Answer from Ligaya" on top of the asker's report: whose words it carries, set by the server. */
export function ReportHead({ data }: { data: ReportData }) {
  const { t, lang } = useI18n();
  const agents = useStore((s) => s.agents);
  const ids = [...new Set(data.items.map((i) => i.agentId))];
  const names = ids.map((id) => nameIn(agents, id, t('chat.someone')));
  // a report with no answer yet (only who is still working): no "Answer from …"
  if (!ids.length) return null;
  return (
    <span className="report-from" data-testid="report-from">
      <span className="handoff-av" aria-hidden="true">
        {ids
          .slice(0, 3)
          .map((id) =>
            agents[id] ? (
              <AgentAvatar key={id} agentId={id} salt={agents[id]!.avatarSalt} size={20} shape="circle" />
            ) : null,
          )}
      </span>
      <span>
        {names.length === 1
          ? t('chat.report.fromOne', { name: names[0] })
          : t('chat.report.fromMany', { names: listOf(lang, names) })}
      </span>
    </span>
  );
}

function ItemBlocks({ item, chatId }: { item: ReportItem; chatId: string }) {
  const { t } = useI18n();
  if (!item.blocks?.length) return null;
  return (
    <div className="report-blocks">
      {item.blocks.map((b, i) =>
        b.kind === 'core.card' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: carried blocks have no id; their order is fixed
          <CardView key={i} data={b.data as CardData} chatId={chatId} />
        ) : (
          <MessageBlockView
            // biome-ignore lint/suspicious/noArrayIndexKey: carried blocks have no id; their order is fixed
            key={i}
            slots={slots}
            block={b}
            fallbackText={t('core:blocks.fallback', { kind: b.kind })}
          />
        ),
      )}
    </div>
  );
}

function OpenThread({ item }: { item: ReportItem }) {
  const { t } = useI18n();
  const name = useStore((s) => s.agents[item.agentId]?.name) ?? t('chat.someone');
  if (!item.chatId) return null;
  return (
    <a
      className="handoff-open"
      href={`#/chats/${item.chatId}${item.messageId ? `?thread=${item.messageId}` : ''}`}
      data-testid="report-open-thread"
    >
      {t('chat.report.openThread', { name })}
    </a>
  );
}

/** The way to each helper's thread, without a fold (nothing more to read here). */
function OpenThreads({ items }: { items: readonly ReportItem[] }) {
  const links = items.filter((i) => i.chatId);
  if (!links.length) return null;
  return (
    <div className="report-links" data-testid="report-links">
      {links.map((it) => (
        <OpenThread key={it.taskId} item={it} />
      ))}
    </div>
  );
}

/** Each full answer, one tap away, with what the helper made and the way to its thread. */
export function ReportFull({ data, chatId, said }: { data: ReportData; chatId: string; said: string }) {
  const { t, lang } = useI18n();
  const agents = useStore((s) => s.agents);
  const still = data.still.map((id) => nameIn(agents, id, '…'));
  const fold = foldAddsSomething(data.items, said);
  return (
    <>
      {still.length > 0 && (
        <p className="muted report-still" data-testid="report-still">
          {still.length === 1
            ? t('chat.report.stillOne', { name: still[0] })
            : t('chat.report.stillMany', { names: listOf(lang, still) })}
        </p>
      )}
      {!fold ? (
        <OpenThreads items={data.items} />
      ) : (
        <details className="handoff report-full" data-testid="report-full">
          <summary>
            <span className="handoff-t">
              {data.items.length === 1 ? t('chat.report.fullOne') : t('chat.report.fullMany')}
            </span>
            <span className="handoff-chev" aria-hidden="true">
              <Icon name="chevron" size={16} />
            </span>
          </summary>
          <div className="handoff-body">
            {data.items.map((it) => (
              <ReportAnswer key={it.taskId} item={it} chatId={chatId} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function ReportAnswer({ item, chatId }: { item: ReportItem; chatId: string }) {
  const { t } = useI18n();
  const who = useStore((s) => s.agents[item.agentId]);
  const name = who?.name ?? t('chat.someone');
  return (
    <div className="handoff-part" data-testid="report-answer">
      <span className="handoff-l report-who">
        {who && <AgentAvatar agentId={who.id} salt={who.avatarSalt} size={20} shape="circle" />}
        {item.state === 'done'
          ? t('chat.report.finished', { name })
          : STOPPED.has(item.state)
            ? t('chat.report.stoppedOne', { name })
            : t('chat.report.failed', { name })}
      </span>
      {item.answer && (
        <div className="md" dir="auto">
          <Markdown text={item.answer} />
        </div>
      )}
      <ItemBlocks item={item} chatId={chatId} />
      <OpenThread item={item} />
    </div>
  );
}

const firstLines = (s: string) => {
  const one = s.split('\n').filter(Boolean).slice(0, 2).join(' ');
  return one.length > 160 ? `${one.slice(0, 159).trimEnd()}…` : one;
};

/**
 * The server's own report, when the asker could not give one: the shared helper card, "Ligaya finished: …", and the
 * full answer one tap away.
 */
export function FallbackReport({
  data,
  chatId,
  messageId,
}: {
  data: ReportData;
  chatId: string;
  messageId: string;
}) {
  const { t, lang } = useI18n();
  const agents = useStore((s) => s.agents);
  const ids = [...new Set(data.items.map((i) => i.agentId))];
  const names = ids.map((id) => nameIn(agents, id, t('chat.someone')));
  const first = data.items[0];
  const who = first ? agents[first.agentId] : undefined;
  const line = (it: ReportItem) => {
    const name = nameIn(agents, it.agentId, t('chat.someone'));
    return it.state === 'done'
      ? `${t('chat.report.finished', { name })} ${firstLines(it.answer)}`
      : STOPPED.has(it.state)
        ? t('chat.report.stoppedOne', { name })
        : t('chat.report.failed', { name });
  };
  const still = data.still.map((id) => nameIn(agents, id, '…'));
  const stillLine = still.length
    ? still.length === 1
      ? t('chat.report.stillOne', { name: still[0] })
      : t('chat.report.stillMany', { names: listOf(lang, still) })
    : undefined;
  // the card's own lines already show each answer's first lines: the fold is there only when there is more
  const said = data.items.map((it) => (it.state === 'done' ? firstLines(it.answer) : '')).join(' ');
  const fold = foldAddsSomething(data.items, said);
  return (
    <HelperCard
      id={messageId}
      variant="result"
      state="open"
      testId="report-fallback"
      kicker={
        names.length === 0
          ? undefined
          : names.length === 1
            ? t('chat.report.fromOne', { name: names[0] })
            : t('chat.report.fromMany', { names: listOf(lang, names) })
      }
      badge={
        who ? <AgentAvatar agentId={who.id} salt={who.avatarSalt} size={20} shape="circle" /> : undefined
      }
      title={first ? line(first) : (stillLine ?? t('chat.someone'))}
      text={
        [...data.items.slice(1).map(line), ...(first && stillLine ? [stillLine] : [])].join(' · ') ||
        undefined
      }
      visual={
        !fold ? (
          <OpenThreads items={data.items} />
        ) : (
          <details className="handoff report-full" data-testid="report-full">
            <summary>
              <span className="handoff-t">{t('chat.report.openFull')}</span>
              <span className="handoff-chev" aria-hidden="true">
                <Icon name="chevron" size={16} />
              </span>
            </summary>
            <div className="handoff-body">
              {data.items.map((it) => (
                <ReportAnswer key={it.taskId} item={it} chatId={chatId} />
              ))}
            </div>
          </details>
        )
      }
      actions={[]}
      settledLabel=""
    />
  );
}

// ---------- the chats list: who works for whom, and new requests ----------
interface Work {
  working: {
    taskId: string;
    from: string;
    to: string;
    chatId: string | null;
    state: string;
    createdAt: number;
  }[];
  latest: { chatId: string; at: number }[];
}
let work: Work = { working: [], latest: [] };
const subs = new Set<() => void>();
let loading = false;
let again = false;
let started = false;
const SEEN_KEY = 'pasabot.threads.seen';
let seen: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
})();
const emit = () => {
  for (const s of subs) s();
};
async function refresh() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    work = await api<Work>('/api/m/collab/working');
    // a request that came in while the owner had that chat open is seen already
    if (openChat) see(openChat, openAt);
    emit();
  } catch {
    // not the owner, or the module is off: nothing to show
  } finally {
    loading = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}
function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('pasabot:event', (e) => {
    if ((e as CustomEvent<{ type: string }>).detail?.type === 'collab.tasks') void refresh();
  });
  void refresh();
}
/** the chat the owner has open now: whatever comes in there is seen as it comes */
let openChat: string | null = null;
let openAt = 0;
const see = (chatId: string, newest = 0) => {
  // the newest request the server knows of, or the newest message shown (whichever is later: the list may not have
  // caught up yet); both are the server's clock
  const at = Math.max(work.latest.find((l) => l.chatId === chatId)?.at ?? 0, newest);
  if (!at || (seen[chatId] ?? 0) >= at) return false;
  seen = { ...seen, [chatId]: at };
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // a private window: the dot just shows again next time
  }
  return true;
};
/** The owner has this chat open: its requests so far, and any that come in while it is open, are seen (this device). */
export function markThreadsSeen(chatId: string, newest: number) {
  const moved = openChat !== chatId;
  if (moved) openAt = 0;
  openChat = chatId;
  openAt = Math.max(openAt, newest);
  if (see(chatId, openAt) || moved) emit();
}
/** The owner left this chat. */
export function leaveThreads(chatId: string) {
  if (openChat !== chatId) return;
  see(chatId, openAt);
  openChat = null;
  openAt = 0;
  emit();
}
const snapshot = () => work;
export function useCollabWork(owner: boolean): Work {
  useEffect(() => {
    if (owner) start();
  }, [owner]);
  const w = useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    snapshot,
    snapshot,
  );
  return owner ? w : { working: [], latest: [] };
}
/** "Working for Mayumi" and the new-request dot of one helper's row. */
export function useRowWork(owner: boolean, agentId: string | null, chatId: string) {
  const w = useCollabWork(owner);
  const [n, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    subs.add(l);
    return () => {
      subs.delete(l);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `n` changes when the seen marks (outside React) do
  return useMemo(() => {
    // the request it works on now (running, or waiting for the owner's OK) before one still waiting its turn
    const mine = agentId ? w.working.filter((x) => x.to === agentId && x.from !== agentId) : [];
    const forWhom = mine.find((x) => x.state === 'running' || x.state === 'waiting') ?? mine[0];
    const at = w.latest.find((l) => l.chatId === chatId)?.at ?? 0;
    // a row that already says "Working for …" needs no dot as well; the open chat is seen as it comes
    return {
      from: forWhom?.from ?? null,
      unread: !forWhom && chatId !== openChat && at > (seen[chatId] ?? 0),
    };
  }, [w, agentId, chatId, n]);
}
