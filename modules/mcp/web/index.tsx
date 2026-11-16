/**
 * W13 web: the MCP servers page (`/mcp`). The owner adds a server (a command on this machine or a web address),
 * keeps secrets write-only, tests it, turns it on, and sets who may use it: every agent, agents of one trust
 * level, or one agent (`none` / `use` / `manage`). Levels are owner-only (7.4).
 */

import type { WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

import { Badge, BrandTile, Button, Card, Field, Segmented, safeHref } from '@pasabot/ui';
import { type CSSProperties, useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const translations = moduleTranslator(
  'mcp',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

type Level = 'none' | 'use' | 'manage';
type LevelRow = { agentId: string; level: Level } | { role: string; level: Level };
export interface ServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  secretKeys: string[];
  secretHeaderKeys: string[];
  tier: number;
  enabled: boolean;
  lastTest: { ok: boolean; at: number; tools?: number; error?: string } | null;
  tools: string[];
  source: string | null;
  levels: LevelRow[];
  /** 7.1 "Always asks": each tool's default class (classifier or connector), the owner's correction, the result */
  classes?: { tool: string; auto: string | null; override: string | null; class: string | null }[];
}
const CLASSES = ['money', 'outbound-message', 'delete', 'publish'] as const;
interface Agent {
  id: string;
  name: string;
  trustLevel: string;
  archivedAt?: number | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/m/mcp${path}`, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message ?? `HTTP ${r.status}`);
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}

const muted: CSSProperties = { margin: 0, color: 'var(--bk-muted)', fontSize: 14 };
const wrap: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };
const selectStyle: CSSProperties = { minHeight: 44, maxWidth: '100%' };

function LevelSelect({
  label,
  value,
  inherit,
  onChange,
  testId,
}: {
  label: string;
  value: Level | '';
  inherit?: string;
  onChange(v: Level | ''): void;
  testId?: string;
}) {
  const t = useT();
  return (
    <label className="bk-field" style={{ minWidth: 0 }}>
      <span className="bk-field__label">{label}</span>
      <select
        className="bk-input"
        style={selectStyle}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value as Level | '')}
      >
        {inherit !== undefined && <option value="">{t('level.inherit', { level: inherit })}</option>}
        <option value="none">{t('level.none')}</option>
        <option value="use">{t('level.use')}</option>
        <option value="manage">{t('level.manage')}</option>
      </select>
    </label>
  );
}

/** Who may use one server: everyone, per trust level, per agent. Saved on every change. */
function Access({ server, agents, onSaved }: { server: ServerView; agents: Agent[]; onSaved(): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const roleOf = (role: string) =>
    (server.levels.find((l) => 'role' in l && l.role === role)?.level ?? '') as Level | '';
  const agentOf = (id: string) =>
    (server.levels.find((l) => 'agentId' in l && l.agentId === id)?.level ?? '') as Level | '';
  const save = async (next: LevelRow[]) => {
    setError(null);
    try {
      await call('PUT', `/servers/${encodeURIComponent(server.id)}/levels`, { levels: next });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setRole = (role: string, level: Level | '') =>
    void save([
      ...server.levels.filter((l) => !('role' in l && l.role === role)),
      ...(level ? [{ role, level }] : []),
    ]);
  const setAgent = (agentId: string, level: Level | '') =>
    void save([
      ...server.levels.filter((l) => !('agentId' in l && l.agentId === agentId)),
      ...(level ? [{ agentId, level }] : []),
    ]);
  const all = roleOf('all') || 'none';
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 10, minWidth: 0 }}>
      <legend style={{ fontWeight: 600, padding: 0, marginBottom: 6 }}>{t('access.title')}</legend>
      <p style={muted}>{t('access.hint')}</p>
      <div
        style={{
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
        }}
      >
        <LevelSelect
          label={t('access.all')}
          value={roleOf('all') || 'none'}
          onChange={(v) => setRole('all', v === 'none' ? '' : v)}
          testId={`mcp-level-all-${server.id}`}
        />
        {agents.map((a) => {
          const inherited = roleOf(a.trustLevel) || all;
          return (
            <LevelSelect
              key={a.id}
              label={a.name}
              value={agentOf(a.id)}
              inherit={t(`level.${inherited}`)}
              onChange={(v) => setAgent(a.id, v)}
              testId={`mcp-level-${server.id}-${a.name}`}
            />
          );
        })}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The person's "Technical words" switch (mirrored on `<html data-advanced>`, `pasabot:advanced` on change). Off: no
 * transport, command line, address or key names on a server card.
 */
function useTechnical(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
    () => false,
  );
}

function ServerCard({ s, agents, reload }: { s: ServerView; agents: Agent[]; reload(): void }) {
  const t = useT();
  const tech = useTechnical();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const where = s.transport === 'stdio' ? [s.command, ...s.args].filter(Boolean).join(' ') : (s.url ?? '');
  const link = s.transport === 'http' ? safeHref(s.url ?? '') : undefined;
  return (
    <Card as="article" data-mcp-server={s.id} style={{ padding: 16, display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }}>
          {/* a connector's server carries the connector's mark; any other server the tool-server glyph */}
          <BrandTile
            id={s.source?.startsWith('connector:') ? s.id : 'mcp-server'}
            size={32}
            fallback="server"
          />
          <h2 style={{ margin: 0, fontSize: 18, ...wrap }}>{s.name}</h2>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>
          <Badge tone={s.enabled ? 'primary' : 'outline'}>{t(s.enabled ? 'server.on' : 'server.off')}</Badge>
          {tech && <Badge tone="outline">{t(`transport.${s.transport}`)}</Badge>}
          {s.source?.startsWith('connector:') && <Badge tone="outline">{t('server.fromConnector')}</Badge>}
          {s.lastTest &&
            (s.lastTest.ok ? (
              <Badge data-mcp-test="ok">{t('server.tools', { count: s.lastTest.tools ?? 0 })}</Badge>
            ) : (
              <Badge tone="outline" data-mcp-test="failed">
                {t('server.testFailed')}
              </Badge>
            ))}
        </div>
        {!tech ? null : link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            style={{ ...wrap, fontSize: 14, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
          >
            {where}
          </a>
        ) : (
          <code style={{ ...wrap, fontSize: 13 }}>{where}</code>
        )}
        {tech && s.secretKeys.length + s.secretHeaderKeys.length > 0 && (
          <p style={muted}>
            {t('server.secrets', { names: [...s.secretKeys, ...s.secretHeaderKeys].join(', ') })}
          </p>
        )}
        {s.lastTest && !s.lastTest.ok && s.lastTest.error && (
          <p style={{ ...muted, ...wrap }} role="status">
            {s.lastTest.error}
          </p>
        )}
        {s.tools.length > 0 && !s.classes?.length && (
          <p style={{ ...muted, ...wrap }}>{s.tools.join(' · ')}</p>
        )}
      </div>
      {!!s.classes?.length && <ToolClasses server={s} onSaved={reload} />}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button
          disabled={busy}
          onClick={() => void act(() => call('POST', `/servers/${encodeURIComponent(s.id)}/test`))}
        >
          {t('server.test')}
        </Button>
        <Button
          variant={s.enabled ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() =>
            void act(() => call('PATCH', `/servers/${encodeURIComponent(s.id)}`, { enabled: !s.enabled }))
          }
        >
          {t(s.enabled ? 'server.turnOff' : 'server.turnOn')}
        </Button>
        {confirm ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void act(() => call('DELETE', `/servers/${encodeURIComponent(s.id)}`))}
          >
            {t('server.removeConfirm')}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            {t('server.remove')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {error}
        </p>
      )}
      <Access server={s} agents={agents} onSaved={reload} />
    </Card>
  );
}

/**
 * The owner's per-tool action class (7.1 "Always asks"): money and outbound messages ask every time, at every trust
 * level. The default comes from the tool's own name and description when it was listed; the owner corrects it here.
 */
function ToolClasses({ server, onSaved }: { server: ServerView; onSaved(): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = async (tool: string, v: string) => {
    setBusy(true);
    setError(null);
    try {
      await call('PUT', `/servers/${encodeURIComponent(server.id)}/classes`, {
        tools: { [tool]: v === 'default' ? null : v },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const label = (c: string | null) => (c ? t(`classes.${c}`) : t('classes.none'));
  return (
    <section style={{ display: 'grid', gap: 8, minWidth: 0 }} data-mcp-classes={server.id}>
      <h3 style={{ margin: 0, fontSize: 16 }}>{t('classes.title')}</h3>
      <p style={muted}>{t('classes.hint')}</p>
      {server.classes!.map((c) => {
        const id = `cls-${server.id}-${c.tool}`;
        return (
          <div
            key={c.tool}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }}
          >
            <label htmlFor={id} style={{ ...wrap, flex: '1 1 160px', fontSize: 14 }}>
              <code>{c.tool}</code>
            </label>
            <select
              id={id}
              className="bk-input"
              style={{ ...selectStyle, flex: '1 1 200px' }}
              value={c.override ?? 'default'}
              disabled={busy}
              data-mcp-class={c.tool}
              onChange={(e) => void set(c.tool, e.target.value)}
            >
              <option value="default">{t('classes.default', { class: label(c.auto) })}</option>
              {CLASSES.map((k) => (
                <option key={k} value={k}>
                  {t(`classes.${k}`)}
                </option>
              ))}
              <option value="none">{t('classes.none')}</option>
            </select>
            {(c.class === 'money' || c.class === 'outbound-message') && (
              <Badge tone="primary">{t('classes.alwaysAsks')}</Badge>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {error}
        </p>
      )}
    </section>
  );
}

type Pair = { key: string; value: string };
function AddServer({ onAdded, onCancel }: { onAdded(): void; onCancel(): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [secrets, setSecrets] = useState<Pair[]>([{ key: '', value: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const filled = secrets.filter((p) => p.key.trim() && p.value);
      const plainEnv = Object.fromEntries(
        env
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]),
      );
      await call('POST', '/servers', {
        name,
        transport,
        ...(transport === 'stdio'
          ? {
              command,
              args: args
                .split('\n')
                .map((a) => a.trim())
                .filter(Boolean),
              env: plainEnv,
              secrets: Object.fromEntries(filled.map((p) => [p.key.trim(), p.value])),
            }
          : {
              url,
              secretHeaders: Object.fromEntries(filled.map((p) => [p.key.trim(), p.value])),
            }),
      });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="mcp-add-form" style={{ padding: 16, display: 'grid', gap: 12, minWidth: 0 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t('add.title')}</h2>
      <Field label={t('add.name')} value={name} onChange={(e) => setName(e.target.value)} />
      <Segmented
        label={t('add.transport')}
        value={transport}
        options={[
          { value: 'stdio', label: t('transport.stdio') },
          { value: 'http', label: t('transport.http') },
        ]}
        onChange={(v) => setTransport(v as 'stdio' | 'http')}
      />
      {transport === 'stdio' ? (
        <>
          <Field
            label={t('add.command')}
            hint={t('add.commandHint')}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <Field
            label={t('add.args')}
            hint={t('add.argsHint')}
            multiline
            rows={3}
            value={args}
            onChange={(e) => setArgs((e.target as HTMLTextAreaElement).value)}
          />
          <Field
            label={t('add.env')}
            hint={t('add.envHint')}
            multiline
            rows={2}
            value={env}
            onChange={(e) => setEnv((e.target as HTMLTextAreaElement).value)}
          />
        </>
      ) : (
        <Field label={t('add.url')} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      )}
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 8, minWidth: 0 }}>
        <legend style={{ fontWeight: 600, padding: 0, marginBottom: 6 }}>
          {t(transport === 'stdio' ? 'add.secrets' : 'add.secretHeaders')}
        </legend>
        <p style={muted}>{t('add.secretsHint')}</p>
        {secrets.map((p, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs
            key={i}
            style={{
              display: 'grid',
              gap: 8,
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
            }}
          >
            <Field
              label={t(transport === 'stdio' ? 'add.secretName' : 'add.headerName')}
              value={p.key}
              onChange={(e) =>
                setSecrets(secrets.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
              }
            />
            <Field
              label={t('add.secretValue')}
              type="password"
              autoComplete="off"
              value={p.value}
              onChange={(e) =>
                setSecrets(secrets.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
            />
          </div>
        ))}
        <div>
          <Button onClick={() => setSecrets([...secrets, { key: '', value: '' }])}>
            {t('add.anotherSecret')}
          </Button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {t('add.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('add.cancel')}
        </Button>
      </div>
    </Card>
  );
}

export function McpPage() {
  const t = useT();
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    call<{ servers: ServerView[] }>('GET', '/servers')
      .then((r) => setServers(r.servers))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    load();
    fetch('/api/v1/agents', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((j: { agents?: Agent[] } | Agent[]) =>
        setAgents((Array.isArray(j) ? j : (j.agents ?? [])).filter((a) => !a.archivedAt)),
      )
      .catch(() => setAgents([]));
    const onLive = (e: Event) => {
      const type = (e as CustomEvent<{ type: string }>).detail?.type;
      if (type === 'mcp.changed') load();
    };
    window.addEventListener('pasabot:event', onLive);
    return () => window.removeEventListener('pasabot:event', onLive);
  }, [load]);
  return (
    <section
      data-testid="mcp-page"
      style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 860, minWidth: 0 }}
    >
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        <p style={{ ...muted, fontSize: 15 }}>{t('page.intro')}</p>
      </header>
      {!adding && (
        <div>
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t('add.open')}
          </Button>
        </div>
      )}
      {adding && (
        <AddServer
          onAdded={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {error}
        </p>
      )}
      {servers === null ? (
        !error && <p style={{ margin: 0 }}>{t('loading')}</p>
      ) : servers.length === 0 ? (
        <p style={muted}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {servers.map((s) => (
            <ServerCard key={s.id} s={s} agents={agents} reload={load} />
          ))}
        </div>
      )}
    </section>
  );
}

const mod: WebModule = {
  id: 'mcp',
  routes: [{ path: '/mcp', component: McpPage, titleKey: 'mcp:page.title' }],
  navItems: [
    {
      id: 'mcp',
      labelKey: 'mcp:nav',
      hintKey: 'mcp:find.navHint',
      keywordsKey: 'mcp:find.navKeywords',
      to: '/mcp',
      icon: 'blocks',
      group: 'tools',
      order: 330,
    },
  ],
};
export default mod;
