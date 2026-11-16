/** Server admin (W19): host identity, machine health + alert rules, agent limits, move an agent, diagnostics, audit. */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

type T = (k: string, o?: Record<string, unknown>) => string;
const translations = moduleTranslator(
  'admin',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT(): T {
  return useModuleT(translations).t;
}

const API = '/api/m/admin';
async function call<R>(path: string, init: RequestInit = {}): Promise<R> {
  const r = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as R;
}

interface Identity {
  serverId: string | null;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  node: string;
  uptimeSec: number;
}
interface SampleRow {
  at: number;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  load: number | null;
}
interface Alert {
  id: string;
  rule: { name: string; metric: string; above: number; forSamples: number; cooldownMin: number };
  lastFiredAt: number | null;
}
interface LimitRow {
  agentId: string;
  name: string;
  memMb: number | null;
  cpuPct: number | null;
  usage: { memMb: number; cpuPct: number } | null;
}
interface AuditEntry {
  id: string;
  at: number;
  actorKind: string;
  actorId: string | null;
  action: string;
  target: string | null;
}

const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const grid = { display: 'grid', gap: 12 } as const;

function Section({
  title,
  intro,
  id,
  children,
}: {
  title: string;
  intro?: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-labelledby={`admin-${id}`} data-testid={`admin-${id}`} style={grid}>
      <h2 id={`admin-${id}`} style={{ margin: 0, fontSize: 18 }}>
        {title}
      </h2>
      {intro && <p style={{ margin: 0 }}>{intro}</p>}
      {children}
    </Card>
  );
}

function Host({ t }: { t: T }) {
  const [id, setId] = useState<Identity | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    void call<{ identity: Identity }>('/identity').then((r) => {
      setId(r.identity);
      setName(r.identity.name);
    });
  }, []);
  if (!id) return null;
  const save = async () =>
    setId(
      (await call<{ identity: Identity }>('/identity', { method: 'PUT', body: JSON.stringify({ name }) }))
        .identity,
    );
  return (
    <Section id="host" title={t('host.title')}>
      <div style={row}>
        <Field
          label={t('host.name')}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Button onClick={() => void save()}>{t('host.save')}</Button>
      </div>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          gap: '4px 12px',
          margin: 0,
        }}
      >
        <dt>{t('host.id')}</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
          <code>{id.serverId}</code>
        </dd>
        <dt>{t('host.hostname')}</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{id.hostname}</dd>
        <dt>{t('host.system')}</dt>
        <dd style={{ margin: 0 }}>
          {id.platform} {id.arch} · Node {id.node}
        </dd>
        <dt>{t('host.uptime')}</dt>
        <dd style={{ margin: 0 }}>{t('host.minutes', { count: Math.floor(id.uptimeSec / 60) })}</dd>
      </dl>
    </Section>
  );
}

const METRICS = ['cpu', 'mem', 'disk', 'load'] as const;
function Health({ t }: { t: T }) {
  const [latest, setLatest] = useState<SampleRow | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [form, setForm] = useState({
    name: '',
    metric: 'cpu',
    above: '90',
    forSamples: '1',
    cooldownMin: '30',
  });
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [m, a] = await Promise.all([
      call<{ samples: SampleRow[] }>(`/metrics?since=${Date.now() - 24 * 3600_000}`),
      call<{ alerts: Alert[] }>('/alerts'),
    ]);
    setLatest(m.samples[0] ?? null);
    setAlerts(a.alerts);
  }, []);
  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 30_000);
    return () => clearInterval(h);
  }, [load]);
  const sample = async () => {
    await call('/metrics/sample', { method: 'POST' });
    await load();
  };
  const add = async () => {
    try {
      await call('/alerts', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          metric: form.metric,
          above: Number(form.above),
          forSamples: Number(form.forSamples),
          cooldownMin: Number(form.cooldownMin),
        }),
      });
      setErr(null);
      setForm({ ...form, name: '' });
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };
  const remove = async (id: string) => {
    await fetch(`${API}/alerts/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    await load();
  };
  const unit = (m: string) => (m === 'load' ? '' : '%');
  return (
    <>
      <Section id="metrics" title={t('metrics.title')}>
        {latest ? (
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}
          >
            {METRICS.map((m) => (
              <div key={m} data-testid={`metric-${m}`} style={{ display: 'grid', gap: 2 }}>
                <span>{t(`metrics.${m}`)}</span>
                <strong style={{ fontSize: 22 }}>
                  {latest[m] ?? '—'}
                  {latest[m] !== null ? unit(m) : ''}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ margin: 0 }}>{t('metrics.none')}</p>
        )}
        <div style={row}>
          <Button onClick={() => void sample()}>{t('metrics.sample')}</Button>
          {latest && (
            <span>
              {t('metrics.at')} {new Date(latest.at).toLocaleTimeString(displayLocale())}
            </span>
          )}
        </div>
      </Section>
      <Section id="alerts" title={t('alerts.title')} intro={t('alerts.intro')}>
        {alerts.length === 0 && <p style={{ margin: 0 }}>{t('alerts.empty')}</p>}
        {alerts.map((a) => (
          <div key={a.id} data-testid="alert-rule" style={row}>
            <strong>{a.rule.name}</strong>
            <Badge>
              {t('alerts.rule', {
                metric: t(`metrics.${a.rule.metric}`),
                above: `${a.rule.above}${unit(a.rule.metric)}`,
              })}
            </Badge>
            <span>
              {a.lastFiredAt
                ? `${t('alerts.fired')}: ${new Date(a.lastFiredAt).toLocaleString(displayLocale())}`
                : t('alerts.never')}
            </span>
            <Button variant="danger" onClick={() => void remove(a.id)}>
              {t('alerts.remove')}
            </Button>
          </div>
        ))}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Field
            label={t('alerts.name')}
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
          <label className="bk-field">
            <span className="bk-field__label">{t('alerts.metric')}</span>
            <select
              className="bk-input"
              value={form.metric}
              onChange={(e) => setForm({ ...form, metric: e.target.value })}
              style={{ minHeight: 44, maxWidth: '100%' }}
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {t(`metrics.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <Field
            label={t('alerts.above')}
            type="number"
            inputMode="decimal"
            value={form.above}
            onChange={(e) => setForm({ ...form, above: e.currentTarget.value })}
          />
          <Field
            label={t('alerts.forSamples')}
            type="number"
            min={1}
            max={60}
            value={form.forSamples}
            onChange={(e) => setForm({ ...form, forSamples: e.currentTarget.value })}
          />
          <Field
            label={t('alerts.cooldown')}
            type="number"
            min={0}
            value={form.cooldownMin}
            onChange={(e) => setForm({ ...form, cooldownMin: e.currentTarget.value })}
          />
        </div>
        {err && (
          <p role="alert" className="bk-field__error">
            {err}
          </p>
        )}
        <div>
          <Button variant="primary" disabled={!form.name.trim()} onClick={() => void add()}>
            {t('alerts.add')}
          </Button>
        </div>
      </Section>
    </>
  );
}

function LimitEditor({ t, l, onSaved }: { t: T; l: LimitRow; onSaved(): void }) {
  const [mem, setMem] = useState(l.memMb?.toString() ?? '');
  const [cpu, setCpu] = useState(l.cpuPct?.toString() ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    try {
      await call(`/limits/${l.agentId}`, {
        method: 'PUT',
        body: JSON.stringify({ memMb: mem ? Number(mem) : null, cpuPct: cpu ? Number(cpu) : null }),
      });
      setMsg(t('limits.saved'));
      onSaved();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  return (
    <div data-testid="limit-row" style={{ ...grid, borderTop: '1px solid var(--bk-line)', paddingTop: 12 }}>
      <strong>{l.name}</strong>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <Field
          label={t('limits.mem')}
          type="number"
          min={64}
          value={mem}
          onChange={(e) => setMem(e.currentTarget.value)}
        />
        <Field
          label={t('limits.cpu')}
          type="number"
          min={1}
          value={cpu}
          onChange={(e) => setCpu(e.currentTarget.value)}
        />
      </div>
      <div style={row}>
        <Button onClick={() => void save()}>{t('limits.save')}</Button>
        {msg && <span role="status">{msg}</span>}
        {l.usage && <span>{t('limits.usage', { mem: l.usage.memMb, cpu: l.usage.cpuPct })}</span>}
      </div>
    </div>
  );
}

function Agents({ t }: { t: T }) {
  const [rows, setRows] = useState<LimitRow[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => setRows((await call<{ agents: LimitRow[] }>('/limits')).agents), []);
  useEffect(() => {
    void load();
  }, [load]);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      await call('/agents/import', { method: 'POST', body: await f.text() });
      setNote({ ok: true, text: t('bundle.imported') });
      await load();
    } catch {
      setNote({ ok: false, text: t('bundle.failed') });
    }
  };
  return (
    <>
      <Section id="limits" title={t('limits.title')} intro={t('limits.intro')}>
        {rows.length === 0 && <p style={{ margin: 0 }}>{t('limits.empty')}</p>}
        {rows.map((l) => (
          <LimitEditor key={l.agentId} t={t} l={l} onSaved={() => void load()} />
        ))}
      </Section>
      <Section id="bundle" title={t('bundle.title')} intro={t('bundle.intro')}>
        <div style={row}>
          {rows.map((l) => (
            <a
              key={l.agentId}
              className="bk-btn bk-btn--secondary"
              href={`${API}/agents/${encodeURIComponent(l.agentId)}/export`}
              download
            >
              {t('bundle.export', { name: l.name })}
            </a>
          ))}
        </div>
        <label className="bk-field">
          <span className="bk-field__label">{t('bundle.import')}</span>
          <input
            className="bk-input"
            type="file"
            accept="application/json,.json"
            style={{ minHeight: 44, maxWidth: '100%' }}
            onChange={(e) => void onFile(e.currentTarget.files?.[0])}
          />
        </label>
        {note && (
          <p
            role={note.ok ? 'status' : 'alert'}
            className={note.ok ? undefined : 'bk-field__error'}
            style={{ margin: 0 }}
          >
            {note.text}
          </p>
        )}
      </Section>
    </>
  );
}

function Audit({ t }: { t: T }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [more, setMore] = useState(false);
  const load = useCallback(
    async (before?: number) => {
      const q = new URLSearchParams({ limit: '50' });
      if (filter) q.set('action', filter);
      if (before) q.set('before', String(before));
      const r = await call<{ entries: AuditEntry[] }>(`/audit?${q}`);
      setEntries((old) => (before ? [...old, ...r.entries] : r.entries));
      setMore(r.entries.length === 50);
    },
    [filter],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Section id="audit" title={t('audit.title')}>
      <Field
        label={t('audit.filter')}
        value={filter}
        maxLength={80}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {entries.length === 0 && <p style={{ margin: 0 }}>{t('audit.empty')}</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {entries.map((e) => (
          <li
            key={e.id}
            data-testid="audit-entry"
            style={{ display: 'grid', gap: 2, overflowWrap: 'anywhere' }}
          >
            <span style={row}>
              <code>{e.action}</code>
              <span>{new Date(e.at).toLocaleString(displayLocale())}</span>
            </span>
            <span>
              {t('audit.by', { actor: e.actorId ? `${e.actorKind} ${e.actorId}` : e.actorKind })}
              {e.target ? ` · ${e.target}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {more && (
        <div>
          <Button onClick={() => void load(entries.at(-1)?.at)}>{t('audit.older')}</Button>
        </div>
      )}
    </Section>
  );
}

function AdminPage() {
  const t = useT();
  return (
    <section
      data-slot="route"
      style={{
        display: 'grid',
        gap: 16,
        maxWidth: 860,
        paddingInline: 16,
        marginInline: 'auto',
        paddingBottom: 32,
      }}
    >
      <h1>{t('page.title')}</h1>
      <p style={{ margin: 0 }}>{t('page.intro')}</p>
      <Host t={t} />
      <Health t={t} />
      <Agents t={t} />
      <Section id="diag" title={t('diag.title')} intro={t('diag.intro')}>
        <div>
          <a className="bk-btn bk-btn--secondary" href={`${API}/diagnostics`} download>
            {t('diag.download')}
          </a>
        </div>
      </Section>
      <Audit t={t} />
    </section>
  );
}

const mod: WebModule = {
  id: 'admin',
  routes: [{ path: '/admin', component: AdminPage, titleKey: 'admin:page.title' }],
  navItems: [
    {
      id: 'admin',
      labelKey: 'admin:nav',
      hintKey: 'admin:find.navHint',
      keywordsKey: 'admin:find.navKeywords',
      to: '/admin',
      icon: 'wrench',
      group: 'advanced',
      optional: false,
      // the server's identity, run limits, records and troubleshooting files: technical setup only (W30), so with
      // Technical words off it waits behind one plain line instead of being rewritten into words that mean nothing
      expert: true,
      order: 800,
    },
  ],
};
export default mod;
