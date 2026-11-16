/** One message: the owner's bubble, an agent reply (streaming + tool-activity line), or a system card. */
import type { ApprovalDTO, CardData, MessageBlock, MessageDTO } from '@pasabot/protocol';
import { AgentAvatar, Button, Icon } from '@pasabot/ui';
import { memo, useState } from 'react';
import { post } from '../app/api.js';
import { useI18n } from '../app/i18n.js';
import { usePrefs } from '../app/prefs.js';
import { slots } from '../app/slots.js';
import { type RunActivity, useStore } from '../app/store.js';
import { MessageBlockView, MessageFooterSlots, RunEventView } from '../shell/slots.js';
import { FullApprovalCard } from './approvals.js';
import { CardView } from './cards.js';
import { time } from './format.js';
import { HandoffLine, useHandoffs } from './Handoff.js';
import { Markdown } from './markdown.js';
import { FallbackReport, ReportFull, ReportHead, ReportStatus, reportOf } from './threads.js';
import { friendlyToolLine, toolId } from './tool-names.js';
import { bubbleText } from './visible.js';

const ENDED = new Set(['interrupted', 'cancelled', 'failed', 'done']);
export const MessageItem = memo(function MessageItem({
  message: m,
  chatAgentId,
}: {
  message: MessageDTO;
  chatAgentId: string | null;
}) {
  const { t, lang } = useI18n();
  const meId = useStore((s) => s.me?.id);
  const author = useStore((s) => (m.authorKind === 'agent' && m.authorId ? s.agents[m.authorId] : undefined));
  const stream = useStore((s) => s.streams[m.id]);
  const activity = useStore((s) => (m.runId ? s.activity[m.runId] : undefined));
  // a helper handing work to another helper: one calm line each, never their messages relayed word for word
  const handoffs = useHandoffs(activity);
  const technical = usePrefs((s) => s.advanced);

  if (m.authorKind === 'system') {
    return (
      <>
        {m.blocks.length ? (
          m.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; their order within a message is fixed
            <SystemBlock key={`${m.id}-${i}`} block={b} message={m} />
          ))
        ) : (
          <p className="sys-note">{m.body}</p>
        )}
      </>
    );
  }

  if (m.authorKind === 'user' && m.authorId === meId) {
    return (
      <div className="msg-me" data-testid="msg-me" data-message-id={m.id} data-msg-acts="">
        <div className="me" dir="auto">
          {m.body}
        </div>
        {/* the person's own blocks (file previews, ...) sit under their bubble */}
        {m.blocks.length ? (
          <div className="me-blocks">
            {m.blocks.map((b, i) => (
              <MessageBlockView
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; their order within a message is fixed
                key={`${m.id}-${i}`}
                slots={slots}
                block={b}
                fallbackText={t('core:blocks.fallback', { kind: b.kind })}
              />
            ))}
          </div>
        ) : null}
        <MessageActions message={m} />
        <span className="time">{time(m.createdAt, lang)}</span>
      </div>
    );
  }

  // a reply whose run already ended (crash, restart) is never shown as still typing
  const streaming = m.status === 'streaming' && !ENDED.has(activity?.state ?? '');
  const raw = streaming ? (stream ?? m.body) : m.body;
  // a handoff's raw tool result and a brain's task header are for the brain: the handoff line says it plainly (both
  // stay readable with Technical words on); a bubble with no handoff line never goes blank
  const text = bubbleText(raw, {
    technical,
    results: handoffs.map((h) => h.tool.summary),
    lines: author ? handoffs.length : 0,
  });
  const name = author?.name ?? t('chat.someone');
  // W40: a card a helper posted (no run) is the card alone, beside its face; a failed reply keeps only the words it
  // said before it failed (the error is the card's; its raw text is the owner's Details with Technical words on)
  const card = m.blocks.find((b) => b.kind === 'core.card')?.data as CardData | undefined;
  if (card && !m.runId)
    return (
      <div className="msg-ag msg-card" data-testid="msg-card" data-message-id={m.id}>
        <div className="ag">
          {author && <AgentAvatar agentId={author.id} salt={author.avatarSalt} size={32} />}
          <div className="card-wrap">
            <CardView data={card} chatId={m.chatId} />
          </div>
        </div>
        <span className="time l">{time(m.createdAt, lang)}</span>
      </div>
    );
  const failedCard = !!card && m.status === 'error';
  // the asker's report of other helpers' answers: whose answer it carries on top, each full answer under it
  const report = m.authorKind === 'agent' ? reportOf(m) : null;
  // the server leaves a failed reply's body empty when its card explains the error (the raw text is owner-only)
  const shown = text;
  return (
    <div
      className="msg-ag"
      data-testid="msg-agent"
      data-status={m.status}
      data-message-id={m.id}
      data-msg-acts=""
    >
      <div className="ag">
        {author && (
          <AgentAvatar
            agentId={author.id}
            salt={author.avatarSalt}
            size={32}
            state={streaming ? (text ? 'speaking' : 'thinking') : 'idle'}
          />
        )}
        <div
          className={`bub${m.status === 'error' && !failedCard ? ' bub-err' : ''}${failedCard && !shown && !activity?.tools?.length ? ' bub--card' : ''}`}
        >
          {chatAgentId !== m.authorId && <span className="who-name">{name}</span>}
          {report && <ReportHead data={report} />}
          {author &&
            handoffs.map((h) => <HandoffLine key={h.tool.id} tool={h.tool} from={author} to={h.to} />)}
          <ActivityLine
            activity={activity}
            streaming={streaming}
            skip={author ? new Set(handoffs.map((h) => h.tool.id)) : undefined}
          />
          {activity?.spans?.length ? (
            <div className="spans" data-testid="run-spans">
              {activity.spans.map((e) => (
                <RunEventView key={e.n} slots={slots} event={e} />
              ))}
            </div>
          ) : null}
          {shown ? (
            <div className="txt md" data-testid="msg-text" dir="auto">
              <Markdown text={shown} />
            </div>
          ) : streaming ? (
            <span className="typing" role="status">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {t('chat.thinking', { name })}
            </span>
          ) : null}
          {m.status === 'error' && !failedCard && <p className="err-note">{t('chat.replyFailed')}</p>}
          {report && <ReportFull data={report} chatId={m.chatId} said={shown} />}
          {m.blocks.map((b, i) =>
            b.kind === 'collab.report' ? null : b.kind === 'core.card' ? (
              <CardView
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; their order within a message is fixed
                key={`${m.id}-${i}`}
                data={b.data as CardData}
                chatId={m.chatId}
              />
            ) : (
              <MessageBlockView
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; their order within a message is fixed
                key={`${m.id}-${i}`}
                slots={slots}
                block={b}
                fallbackText={t('core:blocks.fallback', { kind: b.kind })}
              />
            ),
          )}
        </div>
      </div>
      <MessageActions message={m} />
      <span className="time l">{time(m.createdAt, lang)}</span>
    </div>
  );
});

/**
 * The run's tool use in one short line: friendly names ("Checked the team · Searched the web"); the raw tool ids
 * only with the "Technical words" switch on. Tools already shown as a helper-to-helper line (`skip`) are left out.
 */
function ActivityLine({
  activity,
  streaming,
  skip,
}: {
  activity?: RunActivity;
  streaming: boolean;
  skip?: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const technical = usePrefs((s) => s.advanced);
  const tools = (activity?.tools ?? []).filter((x) => !skip?.has(x.id));
  if (!activity || tools.length === 0) return null;
  const secs =
    activity.startedAt && activity.finishedAt
      ? Math.max(1, Math.round((activity.finishedAt - activity.startedAt) / 1000))
      : null;
  let line: string;
  if (technical) {
    const names = [...new Set(tools.map((x) => toolId(x.name)))].slice(0, 3).join(', ');
    line = t('chat.activity', { count: tools.length, names });
  } else {
    line = friendlyToolLine(
      t,
      tools.map((x) => x.name),
    );
  }
  return (
    <span className="act" data-testid="activity" data-technical={technical ? '' : undefined}>
      <span className={`dots${streaming ? ' live' : ''}`} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {line}
      {secs ? ` · ${t('chat.seconds', { count: secs })}` : ''}
    </span>
  );
}

function SystemBlock({ block, message }: { block: MessageBlock; message: MessageDTO }) {
  const { t } = useI18n();
  if (block.kind === 'core.approval') return <ApprovalBlock data={block.data as ApprovalDTO} />;
  if (block.kind === 'core.card')
    return (
      <div className="card-wrap card-wrap--sys" data-testid="msg-card">
        <CardView data={block.data as CardData} chatId={message.chatId} />
      </div>
    );
  // helpers' work (collab): the calm status line, the server's own report, the "stopped here" line
  if (block.kind === 'collab.status')
    return <ReportStatus data={block.data as Parameters<typeof ReportStatus>[0]['data']} />;
  if (block.kind === 'collab.report')
    return (
      <FallbackReport
        data={block.data as Parameters<typeof FallbackReport>[0]['data']}
        chatId={message.chatId}
        messageId={message.id}
      />
    );
  if (block.kind === 'collab.note')
    return (
      <p className="sys-note" data-testid="collab-stopped">
        {t('chat.report.stopped')}
      </p>
    );
  if (block.kind === 'core.interrupted') {
    const d = block.data as { queueItemId: string; partial?: string };
    return <InterruptedCard queueItemId={d.queueItemId} partial={d.partial} />;
  }
  return (
    <MessageBlockView
      slots={slots}
      block={block}
      fallbackText={t('core:blocks.fallback', { kind: block.kind })}
    />
  );
}

function ApprovalBlock({ data }: { data: ApprovalDTO }) {
  const { t } = useI18n();
  const live = useStore((s) => s.approvals[data.id]) ?? data;
  const agent = useStore((s) => (live.agentId ? s.agents[live.agentId] : undefined));
  return (
    <div className="ask-wrap" data-testid="approval-card">
      <FullApprovalCard a={live} agentName={agent?.name ?? t('chat.someone')} />
    </div>
  );
}

function InterruptedCard({ queueItemId, partial }: { queueItemId: string; partial?: string }) {
  const { t } = useI18n();
  const item = useStore((s) => {
    for (const list of Object.values(s.queues)) {
      const f = list.find((q) => q.id === queueItemId);
      if (f) return f;
    }
    return undefined;
  });
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const act = async (verb: 'retry' | 'skip') => {
    setBusy(true);
    try {
      await post(`/api/v1/queue/${queueItemId}/${verb}`);
      setGone(true);
    } catch {
      setGone(true);
    } finally {
      setBusy(false);
    }
  };
  const open = !gone && (!item || item.state === 'interrupted');
  return (
    <section
      className="interrupted bk-card"
      data-testid="interrupted-card"
      aria-label={t('core:queue.interrupted')}
    >
      <p className="int-title">{t('core:queue.interrupted')}</p>
      {partial && (
        <blockquote className="int-partial" data-testid="interrupted-partial">
          <span className="int-partial-l">{t('chat.partialLabel')}</span>
          {partial}
        </blockquote>
      )}
      {open ? (
        <>
          <p className="muted">{t('core:queue.interruptedHint')}</p>
          <div className="row">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act('retry')}>
              {t('core:common.retry')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => act('skip')}>
              {t('core:common.skip')}
            </Button>
          </div>
        </>
      ) : (
        <p className="muted">{t('chat.interruptedHandled')}</p>
      )}
    </section>
  );
}

/**
 * A message's actions (Simplify spec 2.1): the module footers (React, Listen) and Copy, shown on hover or keyboard
 * focus on a desktop and after a tap on a phone; reactions already given stay visible as chips.
 */
function MessageActions({ message }: { message: MessageDTO }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(message.body)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="msg-acts">
      <MessageFooterSlots slots={slots} message={message} />
      {message.body && (
        <button type="button" className="msg-act" onClick={copy} data-testid="msg-copy">
          <Icon name={copied ? 'check-circle' : 'copy'} size={16} />
          <span>{copied ? t('chat.copied') : t('chat.copy')}</span>
        </button>
      )}
    </div>
  );
}
