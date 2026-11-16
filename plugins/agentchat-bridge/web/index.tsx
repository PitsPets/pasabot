/**
 * W25 web: Settings → Agent board. Connect the owner's agent message board as an `agentchat` channel binding
 * (board address as a setting, token write-only into the vault, the board agents allowed to talk), and see each
 * bridge's status and its chats. Linking, pausing and removing stay in Settings → Channels (same binding).
 */
import type { WebModule } from '@pasabot/core/web';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from './i18n.js';

const KIND = 'agentchat';
interface Binding {
  id: string;
  kind: string;
  label: string;
  agentId: string;
  status: string;
  allowedSenders: string[];
  options?: Record<string, string | boolean>;
  places: { id: string; title: string; kind: string; chatId: string | null }[];
}
interface Agent {
  id: string;
  name: string;
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
const base = '/api/m/channels';
const wrap = { overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const, minWidth: 0 };
const muted = { margin: 0, fontSize: 14, color: 'var(--bk-muted)', ...wrap };
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 8, alignItems: 'center' };
const parseIds = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function AddBoard({ agents, onDone, onCancel }: { agents: Agent[]; onDone(): void; onCancel(): void }) {
  const t = useT();
  const [boardUrl, setBoardUrl] = useState('');
  const [token, setToken] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [allowed, setAllowed] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      data-testid="agentchat-add-form"
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await call('POST', `${base}/bindings`, {
            kind: KIND,
            agentId,
            label: label.trim() || undefined,
            secrets: { token: token.trim() },
            options: { boardUrl: boardUrl.trim() },
            allowedSenders: parseIds(allowed),
          });
          setToken('');
          onDone();
        } catch (x) {
          setErr(x instanceof Error ? x.message : String(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>{t('add.title')}</strong>
      <Field
        label={t('add.url')}
        hint={t('add.urlHint')}
        type="url"
        inputMode="url"
        spellCheck={false}
        required
        maxLength={500}
        value={boardUrl}
        onChange={(e) => setBoardUrl(e.currentTarget.value)}
      />
      <Field
        label={t('add.token')}
        hint={t('add.tokenHint')}
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        value={token}
        onChange={(e) => setToken(e.currentTarget.value)}
      />
      <label className="bk-field">
        <span className="bk-field__label">{t('add.agent')}</span>
        <select
          className="bk-input"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          style={{ minHeight: 44, maxWidth: '100%' }}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <Field
        multiline
        rows={2}
        label={t('add.allowed')}
        hint={t('add.allowedHint')}
        value={allowed}
        onChange={(e) => setAllowed(e.currentTarget.value)}
      />
      <Field
        label={t('add.label')}
        maxLength={80}
        value={label}
        onChange={(e) => setLabel(e.currentTarget.value)}
      />
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button variant="primary" type="submit" disabled={busy || !boardUrl.trim() || !token.trim()}>
          {t('add.submit')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('add.cancel')}
        </Button>
      </div>
    </form>
  );
}

function Bridge({ b, agents }: { b: Binding; agents: Agent[] }) {
  const t = useT();
  const tone =
    b.status === 'connected'
      ? 'primary'
      : b.status === 'auth_failed' || b.status === 'error'
        ? 'signal'
        : 'neutral';
  const address = typeof b.options?.boardUrl === 'string' ? b.options.boardUrl : '';
  return (
    <Card as="article" data-testid="agentchat-bridge" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <h4 style={{ margin: 0, fontSize: 17, ...wrap }}>{b.label || t('settings.title')}</h4>
        <Badge tone={tone} data-testid="agentchat-status">
          {t(`status.${b.status}`, { defaultValue: b.status })}
        </Badge>
      </div>
      <dl style={{ display: 'grid', gap: 6, margin: 0, minWidth: 0 }}>
        <div style={row}>
          <dt style={muted}>{t('bridge.address')}</dt>
          <dd style={{ margin: 0, ...wrap }}>{address}</dd>
        </div>
        <div style={row}>
          <dt style={muted}>{t('bridge.agent')}</dt>
          <dd style={{ margin: 0, ...wrap }}>{agents.find((a) => a.id === b.agentId)?.name ?? '—'}</dd>
        </div>
        <div style={row}>
          <dt style={muted}>{t('bridge.allowed')}</dt>
          <dd style={{ margin: 0, ...wrap }} data-testid="agentchat-allowed">
            {b.allowedSenders.length ? b.allowedSenders.join(', ') : t('bridge.allowedNone')}
          </dd>
        </div>
      </dl>
      <section style={{ display: 'grid', gap: 8, minWidth: 0 }} aria-label={t('bridge.chats')}>
        <strong>{t('bridge.chats')}</strong>
        {b.places.length === 0 ? (
          <p style={muted}>{t('bridge.chatsNone')}</p>
        ) : (
          <ul style={{ display: 'grid', gap: 4, padding: 0, margin: 0, listStyle: 'none' }}>
            {b.places.map((p) => (
              <li key={p.id} style={{ ...row, minHeight: 44 }}>
                <span style={wrap}>{p.title || p.id}</span>
                {p.chatId && (
                  <a
                    href={`#/chats/${p.chatId}`}
                    style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                  >
                    {t('bridge.openChat')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}

function AgentBoardSettings() {
  const t = useT();
  const [bridges, setBridges] = useState<Binding[] | null>(null);
  const [installed, setInstalled] = useState(true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      const [d, ag] = await Promise.all([
        call<{ bindings: Binding[]; kinds: { kind: string }[] }>('GET', `${base}/bindings`),
        call<{ agents: Agent[] } | Agent[]>('GET', '/api/v1/agents'),
      ]);
      setInstalled(d.kinds.some((k) => k.kind === KIND));
      setBridges(d.bindings.filter((b) => b.kind === KIND));
      setAgents(Array.isArray(ag) ? ag : ag.agents);
      setErr(null);
    } catch (x) {
      const msg = x instanceof Error ? x.message : String(x);
      // no channels module on this server: the bridge cannot run, show nothing
      if (msg === 'HTTP 404') setInstalled(false);
      else setErr(msg);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  if (!installed) return null;
  return (
    <section
      data-testid="agentchat-settings"
      aria-labelledby="agentchat-title"
      style={{ display: 'grid', gap: 12, minWidth: 0 }}
    >
      <h3 id="agentchat-title" style={{ margin: 0 }}>
        {t('settings.title')}
      </h3>
      <p style={muted}>{t('settings.intro')}</p>
      <p style={muted}>{t('settings.trust')}</p>
      {err && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', ...wrap }}>
          {t('settings.error', { reason: err })}
        </p>
      )}
      {bridges?.map((b) => (
        <Bridge key={b.id} b={b} agents={agents} />
      ))}
      {!!bridges?.length && <p style={muted}>{t('settings.manage')}</p>}
      {bridges &&
        (adding ? (
          agents.length ? (
            <Card style={{ minWidth: 0 }}>
              <AddBoard
                agents={agents}
                onCancel={() => setAdding(false)}
                onDone={() => {
                  setAdding(false);
                  void load();
                }}
              />
            </Card>
          ) : (
            <p style={muted}>{t('settings.noAgents')}</p>
          )
        ) : (
          <div>
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t('add.open')}
            </Button>
          </div>
        ))}
    </section>
  );
}

const mod: WebModule = {
  id: 'agentchat-bridge',
  settingsSections: [
    {
      id: 'agentchat-bridge',
      labelKey: 'agentchat-bridge:settings.title',
      hintKey: 'agentchat-bridge:find.settingsHint',
      keywordsKey: 'agentchat-bridge:find.settingsKeywords',
      icon: 'plug',
      group: 'advanced',
      component: AgentBoardSettings,
      order: 190,
      expert: true,
    },
  ],
};
export default mod;
