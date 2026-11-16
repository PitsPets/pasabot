/**
 * One calm line in a chat when a helper hands work (or a note) to another helper: both small avatars and
 * "Tala asked Taga-hanap to help". Opening it shows what was asked, the short reply (when it came back in the same
 * turn) and a link to that exact request in the other helper's own chat ("Open in Taga-hanap's chat"), where it is a
 * thread. Their messages are never relayed here word for word; the answer comes back as the asker's report.
 */

import type { AgentDTO } from '@pasabot/protocol';
import { AgentAvatar, Icon } from '@pasabot/ui';
import { useT } from '../app/i18n.js';
import { usePrefs } from '../app/prefs.js';
import { type RunActivity, type State, useStore } from '../app/store.js';
import { Markdown } from './markdown.js';
import { handoffKind, isHandoffTool } from './tool-names.js';
import { visibleText } from './visible.js';

type Tool = RunActivity['tools'][number];

/** The agent a tool's `to` names: its id, slug or name (as the collab tools resolve it). */
function findAgent(agents: State['agents'], ref: unknown): AgentDTO | undefined {
  if (typeof ref !== 'string' || !ref) return undefined;
  if (agents[ref]) return agents[ref];
  const low = ref.toLocaleLowerCase();
  return Object.values(agents).find((a) => a.slug === ref || a.name.toLocaleLowerCase() === low);
}

const SHORT = 280;
const short = (s: string) => (s.length > SHORT ? `${s.slice(0, SHORT - 1).trimEnd()}…` : s);

/** The helper's reply in a tool result's short text (JSON, maybe cut off): `null` when there is none. */
export function replyOf(summary: string | undefined): string | null {
  if (!summary) return null;
  try {
    const j = JSON.parse(summary) as { reply?: unknown };
    if (typeof j?.reply === 'string') return j.reply;
  } catch {
    // a summary cut at its length limit is not whole JSON: read the reply up to where it stops
  }
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(summary);
  if (!m) return null;
  const closed = summary[m.index + m[0].length] === '"';
  let text: string;
  try {
    text = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    text = m[1]!.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\$/, '');
  }
  return closed ? text : `${text}…`;
}

/** A helper's own chat (the one the owner has with it): its oldest open direct chat no module opened. */
export function ownChatOf(s: State, agentId: string): string | undefined {
  return Object.values(s.chats)
    .filter(
      (c) =>
        c.kind === 'direct' &&
        !c.archivedAt &&
        !c.settings?.moduleChat &&
        c.members.filter((m) => m.kind === 'agent').length === 1 &&
        c.members.some((m) => m.kind === 'agent' && m.id === agentId),
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
}

/** The task id in a tool result's short text (it comes first, so a cut-off summary still has it). */
export function taskIdIn(summary: string | undefined): string | null {
  const m = summary ? /"taskId"\s*:\s*"([0-9A-Z]{26})"/.exec(summary) : null;
  return m ? m[1]! : null;
}

/** What was asked, from the tool's input (`task`, `text` or `note`). */
const askedOf = (input: unknown): string => {
  const i = (input ?? {}) as { task?: unknown; text?: unknown; note?: unknown };
  const v = i.task ?? i.text ?? i.note;
  return typeof v === 'string' ? v : '';
};

/** The handoff tool calls of a run that name a known helper: each becomes one line (the rest stay plain tools). */
export function useHandoffs(activity: RunActivity | undefined): { tool: Tool; to: AgentDTO }[] {
  const agents = useStore((s) => s.agents);
  if (!activity) return [];
  const out: { tool: Tool; to: AgentDTO }[] = [];
  for (const tool of activity.tools) {
    if (!isHandoffTool(tool.name)) continue;
    const to = findAgent(agents, (tool.input as { to?: unknown } | undefined)?.to);
    if (to) out.push({ tool, to });
  }
  return out;
}

export function HandoffLine({ tool, from, to }: { tool: Tool; from: AgentDTO; to: AgentDTO }) {
  const t = useT();
  // the request is a thread in the other helper's own chat: the link opens that exact thread
  const toChat = useStore((s) => ownChatOf(s, to.id));
  const taskId = taskIdIn(tool.summary);
  const kind = handoffKind(tool.name);
  const asked = askedOf(tool.input);
  const technical = usePrefs((s) => s.advanced);
  // the reply as a person reads it: a brain's task header (an echo of it) is never shown, nor are task ids
  const said = kind === 'ask' ? replyOf(tool.summary) : null;
  const reply = said && !technical ? visibleText(said) || said : said;
  const running = tool.ok === undefined;
  return (
    <details className="handoff" data-testid="handoff">
      <summary>
        <span className="handoff-av" aria-hidden="true">
          <AgentAvatar agentId={from.id} salt={from.avatarSalt} size={22} shape="circle" />
          <AgentAvatar agentId={to.id} salt={to.avatarSalt} size={22} shape="circle" />
        </span>
        <span className="handoff-t">
          {t(kind === 'ask' ? 'chat.handoff.asked' : 'chat.handoff.noted', { from: from.name, to: to.name })}
        </span>
        <span className="handoff-chev" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </summary>
      <div className="handoff-body">
        {asked && (
          <div className="handoff-part">
            <span className="handoff-l">{t('chat.handoff.whatAsked')}</span>
            <div className="handoff-q md" dir="auto">
              <Markdown text={short(asked)} />
            </div>
          </div>
        )}
        {kind === 'ask' && (
          <div className="handoff-part">
            <span className="handoff-l">{t('chat.handoff.reply', { name: to.name })}</span>
            {reply ? (
              <div className="md" dir="auto" data-testid="handoff-reply">
                <Markdown text={short(reply)} />
              </div>
            ) : (
              <span className="muted">
                {running
                  ? t('chat.handoff.waiting', { name: to.name })
                  : tool.ok === false
                    ? t('chat.handoff.failed')
                    : t('chat.handoff.later', { name: to.name })}
              </span>
            )}
          </div>
        )}
        {toChat && (
          <a
            className="handoff-open"
            href={`#/chats/${toChat}${taskId ? `?task=${taskId}` : ''}`}
            data-testid="handoff-open"
          >
            {t('chat.handoff.openThread', { name: to.name })}
          </a>
        )}
      </div>
    </details>
  );
}
