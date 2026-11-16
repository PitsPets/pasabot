/** Routines page: the list, a create form, run / test / pause / delete / rotate, the activity feed, the iCal link. */

import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from './i18n.js';

interface Routine {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  trigger: { kind: string; spec: Record<string, unknown> };
  target: 'chat' | 'thread' | 'workflow';
  runEvenOffline?: boolean;
  nextAt: number | null;
  lastFire: { result: string; at: number; note?: string | null } | null;
}
interface Fire {
  id: string;
  routineName?: string;
  at: number;
  source: string;
  result: string;
  chatId: string | null;
  error?: string | null;
  note?: string | null;
}
/** A pending fire whose item the core holds (usage limit, unreachable brain) is "Held", never "Running". */
const shown = (f: { result: string; note?: string | null }) =>
  f.result === 'pending' && f.note?.startsWith('held: ') ? 'held' : f.result;
interface Agent {
  id: string;
  name: string;
}
interface Hook {
  path: string;
  secret: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message ?? `HTTP ${r.status}`);
  }
  return (r.status === 204 ? null : await r.json()) as T;
}
const base = '/api/m/routines';
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(displayLocale()) : '—');
const wrap = { overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const };

function NewHook({ hook, onDone }: { hook: Hook; onDone(): void }) {
  const t = useT();
  return (
    <Card as="section" role="status" style={{ display: 'grid', gap: 8 }}>
      <strong>{t('hook.title')}</strong>
      <p>{t('hook.once')}</p>
      <code style={wrap}>{`${location.origin}${hook.path}`}</code>
      <code style={wrap}>{hook.secret}</code>
      <Button variant="primary" onClick={onDone}>
        {t('hook.saved')}
      </Button>
    </Card>
  );
}

function CreateForm({ agents, onCreated }: { agents: Agent[]; onCreated(h: Hook | null): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState('');
  const [kind, setKind] = useState('schedule');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [target, setTarget] = useState<'chat' | 'thread' | 'workflow'>('chat');
  const [workflowId, setWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (target !== 'workflow') return;
    void call<{ workflows: { id: string; name: string }[] }>('GET', `${base}/workflow-targets`)
      .then((r) => setWorkflows(r.workflows))
      .catch(() => setWorkflows([]));
  }, [target]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const spec = kind === 'schedule' ? { cron, tz } : {};
      const out = await call<{ webhook: Hook | null }>('POST', `${base}/routines`, {
        agentId: agentId || agents[0]?.id,
        name,
        prompt,
        target,
        ...(target === 'workflow' ? { workflowId: workflowId || workflows[0]?.id } : {}),
        trigger: { kind, spec },
        ...(offline ? { runEvenOffline: true } : {}),
      });
      setName('');
      setPrompt('');
      onCreated(out.webhook);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const select = (label: string, value: string, set: (v: string) => void, opts: [string, string][]) => (
    <label className="bk-field">
      <span className="bk-field__label">{label}</span>
      <select
        className="bk-input"
        value={value}
        onChange={(e) => set(e.target.value)}
        style={{ minHeight: 44 }}
      >
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Card as="section" style={{ display: 'grid', gap: 12 }}>
      <h2>{t('create.title')}</h2>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Field
          label={t('create.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
        />
        {select(
          t('create.agent'),
          agentId || agents[0]?.id || '',
          setAgentId,
          agents.map((a) => [a.id, a.name]),
        )}
        <Field
          multiline
          label={t('create.prompt')}
          hint={t('create.promptHint')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          rows={3}
        />
        {select(t('create.trigger'), kind, setKind, [
          ['schedule', t('kind.schedule')],
          ['manual', t('kind.manual')],
          ['webhook', t('kind.webhook')],
        ])}
        {kind === 'schedule' && (
          <>
            <Field
              label={t('create.cron')}
              hint={t('create.cronHint')}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
            <Field label={t('create.tz')} value={tz} onChange={(e) => setTz(e.target.value)} />
          </>
        )}
        {select(t('create.target'), target, (v) => setTarget(v as 'chat' | 'thread' | 'workflow'), [
          ['chat', t('target.chat')],
          ['thread', t('target.thread')],
          ['workflow', t('target.workflow')],
        ])}
        {target === 'workflow' &&
          (workflows.length ? (
            select(
              t('create.workflow'),
              workflowId || workflows[0]!.id,
              setWorkflowId,
              workflows.map((w) => [w.id, w.name]),
            )
          ) : (
            <p className="muted">{t('create.noWorkflows')}</p>
          ))}
        {target !== 'workflow' && (
          <label
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minHeight: 44, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              data-testid="routine-run-offline"
              checked={offline}
              onChange={(e) => setOffline(e.target.checked)}
              style={{ width: 24, height: 24, margin: '10px 0', flex: 'none' }}
            />
            <span style={{ display: 'grid', gap: 2, paddingTop: 10 }}>
              <span>{t('create.offline')}</span>
              <span style={{ fontSize: 13, color: 'var(--bk-muted)' }}>{t('create.offlineHint')}</span>
            </span>
          </label>
        )}
        {err && (
          <p role="alert" className="bk-field__error">
            {err}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !agents.length || (target === 'workflow' && !workflows.length)}
        >
          {t('create.submit')}
        </Button>
      </form>
    </Card>
  );
}

function RoutinesPage() {
  const t = useT();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [fires, setFires] = useState<Fire[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hook, setHook] = useState<Hook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [r, a, ag] = await Promise.all([
        call<{ routines: Routine[] }>('GET', `${base}/routines`),
        call<{ fires: Fire[] }>('GET', `${base}/activity?limit=30`),
        call<{ agents: Agent[] } | Agent[]>('GET', '/api/v1/agents'),
      ]);
      setRoutines(r.routines);
      setFires(a.fires);
      setAgents(Array.isArray(ag) ? ag : ag.agents);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    await load();
  };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <section
      data-slot="route"
      style={{ display: 'grid', gap: 16, maxWidth: 760, paddingInline: 16, marginInline: 'auto' }}
    >
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h1>{t('page.title')}</h1>
        <a className="bk-btn bk-btn--ghost" href={`${base}/calendar.ics`} download="pasabot-routines.ics">
          {t('page.calendar')}
        </a>
      </header>
      <p>{t('page.intro')}</p>
      {err && (
        <p role="alert" className="bk-field__error">
          {err}
        </p>
      )}
      {hook && <NewHook hook={hook} onDone={() => setHook(null)} />}
      {routines.length === 0 && <p>{t('page.empty')}</p>}
      {routines.map((r) => (
        <Card as="article" key={r.id} style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <strong style={wrap}>{r.name}</strong>
            <Badge>{t(`kind.${r.trigger.kind}`)}</Badge>
            {!r.enabled && <Badge>{t('state.paused')}</Badge>}
          </div>
          <p style={wrap}>
            {agentName(r.agentId)} · {t(`target.${r.target}`)}
            {r.trigger.kind === 'schedule' &&
              ` · ${String(r.trigger.spec.cron)} (${String(r.trigger.spec.tz)})`}
          </p>
          <p>
            {t('routine.next')}: {when(r.nextAt)} · {t('routine.last')}:{' '}
            {r.lastFire ? `${t(`result.${shown(r.lastFire)}`)} ${when(r.lastFire.at)}` : '—'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button onClick={() => act(() => call('POST', `${base}/routines/${r.id}/run`))}>
              {t('action.run')}
            </Button>
            <Button onClick={() => act(() => call('POST', `${base}/routines/${r.id}/test`))}>
              {t('action.test')}
            </Button>
            <Button
              onClick={() => act(() => call('PATCH', `${base}/routines/${r.id}`, { enabled: !r.enabled }))}
            >
              {r.enabled ? t('action.pause') : t('action.resume')}
            </Button>
            {(r.trigger.kind === 'webhook' || r.trigger.kind === 'github') && (
              <Button
                onClick={() =>
                  act(async () => {
                    if (!confirm(t('action.rotateConfirm'))) return;
                    const out = await call<{ webhook: Hook }>(
                      'POST',
                      `${base}/routines/${r.id}/rotate-secret`,
                    );
                    setHook(out.webhook);
                  })
                }
              >
                {t('action.rotate')}
              </Button>
            )}
            <Button
              variant="danger"
              onClick={() =>
                act(async () =>
                  confirm(t('action.deleteConfirm')) ? call('DELETE', `${base}/routines/${r.id}`) : null,
                )
              }
            >
              {t('action.delete')}
            </Button>
          </div>
        </Card>
      ))}
      <CreateForm agents={agents} onCreated={(h) => act(async () => setHook(h))} />
      <Card as="section" style={{ display: 'grid', gap: 8 }}>
        <h2>{t('activity.title')}</h2>
        {fires.length === 0 && <p>{t('activity.empty')}</p>}
        <ul style={{ display: 'grid', gap: 8, padding: 0, listStyle: 'none' }}>
          {fires.map((f) => (
            <li
              key={f.id}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minHeight: 44 }}
            >
              <Badge>{t(`result.${shown(f)}`)}</Badge>
              <span style={wrap}>{f.routineName || '—'}</span>
              <span>
                {t(`source.${f.source}`)} · {when(f.at)}
              </span>
              {f.result === 'silent' && (
                <span data-testid="routine-fire-silent" style={{ fontSize: 13, color: 'var(--bk-muted)' }}>
                  {t('activity.silent')}
                </span>
              )}
              {f.result === 'skipped' && f.error && (
                <span
                  data-testid="routine-fire-why"
                  style={{ fontSize: 13, color: 'var(--bk-muted)', ...wrap }}
                >
                  {f.error.startsWith('rate limited') ? t('activity.rateLimited') : f.error}
                </span>
              )}
              {f.note && (
                <span
                  data-testid="routine-fire-note"
                  style={{ fontSize: 13, color: 'var(--bk-muted)', ...wrap }}
                >
                  {f.note.startsWith('primary offline: ran on ')
                    ? t('activity.offlineFallback', { to: f.note.slice('primary offline: ran on '.length) })
                    : f.note}
                </span>
              )}
              {f.chatId && (
                <a
                  href={`#/chats/${f.chatId}`}
                  style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                >
                  {t('activity.open')}
                </a>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

const mod: WebModule = {
  id: 'routines',
  routes: [{ path: '/routines', component: RoutinesPage, titleKey: 'routines:page.title' }],
  navItems: [
    {
      id: 'routines',
      labelKey: 'routines:nav',
      hintKey: 'routines:find.navHint',
      keywordsKey: 'routines:find.navKeywords',
      to: '/routines',
      icon: 'clock',
      group: 'automations',
      order: 300,
      active: {
        labelKey: 'routines:find.stillOn',
        count: async () =>
          (await call<{ routines: Routine[] }>('GET', `${base}/routines`)).routines.filter((r) => r.enabled)
            .length,
      },
    },
  ],
};
export default mod;
