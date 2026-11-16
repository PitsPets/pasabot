/**
 * W6 web: team controls for multi-agent channels (chat header → sheet: lead, Stop/Resume, Archive, silent-lead
 * retry + backup model), the "Agent tasks" page (work agents gave each other) and the sub-agent span renderer.
 */
import type { WebModule } from '@pasabot/core/web';
import { intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { MessageDTO, RunEventDTO } from '@pasabot/protocol';
import { AgentAvatar, Badge, Button, Card, Field, Segmented, Sheet } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';

const translations = moduleTranslator(
  'collab',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
export const useT = () => useModuleT(translations);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export interface TeamView {
  chatId: string;
  isTeam: boolean;
  lead: string | null;
  agents: { id: string; name: string; avatarSalt?: string }[];
  state: 'active' | 'stopped' | 'archived';
  silentRetry: boolean;
  backup: { providerId: string; model?: string } | null;
}

const muted = { margin: 0, fontSize: 13, color: 'var(--bk-muted)' } as const;

/** The sheet's body; pure props so it renders in tests without a server. */
export function TeamPanel({
  team,
  providers,
  onAction,
  onSettings,
}: {
  team: TeamView;
  providers: { id: string; displayName: string }[];
  onAction(action: 'stop' | 'resume' | 'archive' | { reassign: string }): void;
  onSettings(s: { silentRetry?: boolean; backup?: { providerId: string; model?: string } | null }): void;
}) {
  const { t } = useT();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [backup, setBackup] = useState(team.backup?.providerId ?? '');
  const [model, setModel] = useState(team.backup?.model ?? '');
  return (
    <div style={{ display: 'grid', gap: 16 }} data-testid="collab-team">
      <section style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{t('team.lead')}</h3>
        <p style={muted}>{t('team.leadHint')}</p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {team.agents.map((a) => (
            <li
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minInlineSize: 0 }}>
                <AgentAvatar agentId={a.id} salt={a.avatarSalt} size={24} />
                <span style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{a.name}</span>
              </span>
              {a.id === team.lead ? (
                <Badge tone="primary">{t('team.isLead')}</Badge>
              ) : (
                <Button onClick={() => onAction({ reassign: a.id })}>{t('team.makeLead')}</Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 14 }}>
          <Badge tone={team.state === 'active' ? 'neutral' : 'signal'}>{t(`team.state.${team.state}`)}</Badge>
        </p>
        {team.state === 'active' ? (
          <>
            <Button variant="danger" onClick={() => onAction('stop')}>
              {t('team.stop')}
            </Button>
            <p style={muted}>{t('team.stopHint')}</p>
          </>
        ) : (
          <Button variant="primary" onClick={() => onAction('resume')}>
            {t('team.resume')}
          </Button>
        )}
        {team.state !== 'archived' && (
          <Button
            variant="ghost"
            onClick={() => (confirmArchive ? onAction('archive') : setConfirmArchive(true))}
          >
            {confirmArchive ? t('team.archiveConfirm') : t('team.archive')}
          </Button>
        )}
      </section>
      <section style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{t('team.silentTitle')}</h3>
        <Segmented
          label={t('team.silentRetry')}
          value={team.silentRetry ? 'on' : 'off'}
          options={[
            { value: 'on', label: t('team.on') },
            { value: 'off', label: t('team.off') },
          ]}
          onChange={(v) => onSettings({ silentRetry: v === 'on' })}
        />
        <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
          {t('team.backup')}
          <select
            value={backup}
            onChange={(e) => setBackup(e.target.value)}
            style={{ minBlockSize: 44, fontSize: 15, maxWidth: '100%' }}
          >
            <option value="">{t('team.backupNone')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        {backup && (
          <Field label={t('team.backupModel')} value={model} onChange={(e) => setModel(e.target.value)} />
        )}
        <p style={muted}>{t('team.backupHint')}</p>
        <Button
          onClick={() =>
            onSettings({ backup: backup ? { providerId: backup, ...(model ? { model } : {}) } : null })
          }
        >
          {t('team.save')}
        </Button>
      </section>
    </div>
  );
}

/** Chat header widget: only in channels with more than one agent. */
export function TeamWidget({ chatId }: { chatId: string }) {
  const { t } = useT();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<{ id: string; displayName: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/m/collab/chats/${encodeURIComponent(chatId)}`;
  useEffect(() => {
    let live = true;
    call<TeamView>(`${base}/team`)
      .then((v) => live && setTeam(v))
      .catch(() => live && setTeam(null));
    return () => {
      live = false;
    };
  }, [base]);
  useEffect(() => {
    if (open)
      call<{ providers: { id: string; displayName: string }[] }>('/api/v1/providers')
        .then((r) => setProviders(r.providers))
        .catch(() => setProviders([]));
  }, [open]);
  const run = useCallback(async (p: Promise<TeamView>) => {
    try {
      setErr(null);
      setTeam(await p);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  if (!team?.isTeam) return null;
  const lead = team.agents.find((a) => a.id === team.lead)?.name;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="collab-team-open">
        {lead ? t('team.openLead', { lead }) : t('team.open')}
      </Button>
      <Sheet open={open} title={t('team.title')} onClose={() => setOpen(false)}>
        {err && (
          <p role="alert" style={{ margin: '0 0 8px', fontSize: 14 }}>
            {t('team.error', { message: err })}
          </p>
        )}
        <TeamPanel
          team={team}
          providers={providers}
          onAction={(a) =>
            void run(
              typeof a === 'string'
                ? call<TeamView>(`${base}/${a}`, { method: 'POST', body: '{}' })
                : call<TeamView>(`${base}/reassign`, {
                    method: 'POST',
                    body: JSON.stringify({ agentId: a.reassign }),
                  }),
            )
          }
          onSettings={(s) =>
            void run(call<TeamView>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(s) }))
          }
        />
      </Sheet>
    </>
  );
}

export interface TaskView {
  id: string;
  kind: 'delegate' | 'message' | 'handoff' | 'file';
  from: string;
  to: string;
  text: string;
  trust: string;
  state: string;
  reply: string | null;
  ackRequested: boolean;
  ackedAt: number | null;
  createdAt: number;
}

export function TaskRow({ task, names }: { task: TaskView; names: Record<string, string> }) {
  const { t, lang } = useT();
  const when = new Date(task.createdAt).toLocaleString(intlLocale(lang), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <Card as="article">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Badge tone="outline">{t(`kind.${task.kind}`)}</Badge>
        <strong style={{ fontSize: 15, overflowWrap: 'anywhere' }}>
          {t('task.route', { from: names[task.from] ?? task.from, to: names[task.to] ?? task.to })}
        </strong>
        <Badge tone={task.state === 'done' ? 'neutral' : 'signal'}>{t(`state.${task.state}`)}</Badge>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 15, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {task.text}
      </p>
      {task.reply && (
        <p style={{ margin: '8px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          <strong>{t('task.reply')}:</strong> {task.reply}
        </p>
      )}
      <p style={{ ...muted, marginTop: 8 }}>
        {when} · {t('task.trust', { trust: t(`trust.${task.trust}`) })}
        {task.ackRequested ? ` · ${task.ackedAt ? t('task.acked') : t('task.ackWaiting')}` : ''}
      </p>
    </Card>
  );
}

export function TasksPage() {
  const { t } = useT();
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    call<{ tasks: TaskView[] }>('/api/m/collab/tasks')
      .then((r) => setTasks(r.tasks))
      .catch(() => setTasks([]));
    call<{ agents: { id: string; name: string }[] }>('/api/v1/agents')
      .then((r) => setNames(Object.fromEntries(r.agents.map((a) => [a.id, a.name]))))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  return (
    <div style={{ display: 'grid', gap: 12, padding: 16, maxWidth: 760 }}>
      <h1 style={{ margin: 0, fontSize: 22 }}>{t('page.title')}</h1>
      <p style={muted}>{t('page.intro')}</p>
      <div>
        <Button onClick={load}>{t('page.reload')}</Button>
      </div>
      {tasks && tasks.length === 0 && <p style={{ margin: 0, fontSize: 15 }}>{t('page.empty')}</p>}
      {tasks?.map((x) => (
        <TaskRow key={x.id} task={x} names={names} />
      ))}
    </div>
  );
}

/** Sub-agent span from provider events: `{ id, parentId?, name, state: 'start' | 'end' }`. */
export function SubagentSpan({ event }: { event: RunEventDTO }) {
  const { t } = useT();
  const d = (event.data ?? {}) as { name?: string; state?: string; parentId?: string };
  const name = String(d.name ?? '?');
  return (
    <span
      data-testid="subagent-span"
      data-subagent={d.state}
      style={{
        display: 'inline-block',
        fontSize: 13,
        color: 'var(--bk-muted)',
        marginInlineStart: d.parentId ? 16 : 0,
      }}
    >
      {d.state === 'end' ? t('subagent.end', { name }) : t('subagent.start', { name })}
    </span>
  );
}

// ---------- reactions under a bubble ----------
/** the shell re-dispatches live events it does not keep under this name (`LIVE_EVENT` in @pasabot/core/web) */
const LIVE_EVENT = 'pasabot:event';
type Reaction = { messageId: string; emoji: string; actorKind: string; actorId: string };
type ChatReactions = { reactions: Reaction[]; canReact: boolean; me: string | null };
/** the few emoji the react button offers (any emoji an agent sends still shows) */
export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '🙏'] as const;
/** one fetch per chat, shared by every bubble of it; dropped when a reaction changes */
const reactionCache = new Map<string, Promise<ChatReactions>>();
const chatReactions = (chatId: string) => {
  let p = reactionCache.get(chatId);
  if (!p) {
    p = call<ChatReactions>(`/api/m/collab/chats/${chatId}/reactions`)
      .then((r) => ({ reactions: r.reactions, canReact: !!r.canReact, me: r.me ?? null }))
      .catch(() => {
        reactionCache.delete(chatId);
        return { reactions: [], canReact: false, me: null };
      });
    reactionCache.set(chatId, p);
  }
  return p;
};

const chip = {
  fontSize: 14,
  lineHeight: '20px',
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--bk-soft)',
  border: '1px solid var(--bk-line, transparent)',
} as const;

/**
 * The reactions on one message (people's and agents'), grouped by emoji, plus a react button for people who may
 * act in the chat (owner, members); observers see the reactions but get no button.
 */
export function MessageReactions({ message }: { message: MessageDTO }) {
  const { t } = useT();
  const [state, setState] = useState<ChatReactions>({ reactions: [], canReact: false, me: null });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void chatReactions(message.chatId).then((all) => {
        if (alive) setState({ ...all, reactions: all.reactions.filter((r) => r.messageId === message.id) });
      });
    load();
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; data: { chatId?: string } }>).detail;
      if (d?.type !== 'reaction.changed' || d.data?.chatId !== message.chatId) return;
      reactionCache.delete(message.chatId);
      load();
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => {
      alive = false;
      window.removeEventListener(LIVE_EVENT, on);
    };
  }, [message.chatId, message.id]);
  const list = state.reactions;
  const mine = (emoji: string) =>
    list.some((r) => r.emoji === emoji && r.actorKind === 'user' && r.actorId === state.me);
  const react = async (emoji: string) => {
    setBusy(true);
    try {
      await call(`/api/m/collab/chats/${message.chatId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ messageId: message.id, emoji, on: !mine(emoji) }),
      });
      reactionCache.delete(message.chatId);
      const all = await chatReactions(message.chatId);
      setState({ ...all, reactions: all.reactions.filter((r) => r.messageId === message.id) });
      setPicking(false);
    } catch {
      // refused (e.g. the chat became read-only): the live list stays as it was
    } finally {
      setBusy(false);
    }
  };
  const can = state.canReact && message.authorKind !== 'system';
  if (!list.length && !can) return null;
  const groups = [
    ...list.reduce((m, r) => m.set(r.emoji, (m.get(r.emoji) ?? 0) + 1), new Map<string, number>()),
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {list.length > 0 && (
        <ul
          data-testid="reactions"
          aria-label={t('reactions.group')}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: 0, padding: 0, listStyle: 'none' }}
        >
          {groups.map(([emoji, n]) => (
            <li key={emoji} aria-label={t('reactions.label', { emoji, count: n })} style={chip}>
              {emoji} {n}
            </li>
          ))}
        </ul>
      )}
      {can && (
        <>
          <Button
            size="sm"
            variant="ghost"
            data-testid="react-button"
            aria-expanded={picking}
            aria-label={t('reactions.add')}
            title={t('reactions.add')}
            onClick={() => setPicking((v) => !v)}
            style={{ minHeight: 44, minWidth: 44, fontSize: 14 }}
          >
            {t('reactions.button')}
          </Button>
          {picking && (
            <fieldset
              aria-label={t('reactions.pick')}
              data-testid="react-picker"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                border: 0,
                margin: 0,
                padding: 0,
                minWidth: 0,
              }}
            >
              {QUICK_EMOJI.map((e) => (
                <Button
                  key={e}
                  size="sm"
                  variant="ghost"
                  aria-pressed={mine(e)}
                  aria-label={t(mine(e) ? 'reactions.remove' : 'reactions.react', { emoji: e })}
                  disabled={busy}
                  onClick={() => void react(e)}
                  style={{ minHeight: 44, minWidth: 44, fontSize: 18 }}
                >
                  {e}
                </Button>
              ))}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}

const mod: WebModule = {
  id: 'collab',
  routes: [{ path: '/collab', component: TasksPage, titleKey: 'collab:page.title' }],
  navItems: [
    {
      id: 'collab',
      labelKey: 'collab:nav',
      hintKey: 'collab:find.navHint',
      keywordsKey: 'collab:find.navKeywords',
      to: '/collab',
      icon: 'handshake',
      group: 'automations',
      order: 250,
    },
  ],
  chatHeaderWidgets: [
    { id: 'collab-team', component: TeamWidget, icon: 'users', labelKey: 'collab:team.title' },
  ],
  runEventRenderers: { subagent: SubagentSpan },
  messageFooters: [{ id: 'collab-reactions', component: MessageReactions }],
};
export default mod;
