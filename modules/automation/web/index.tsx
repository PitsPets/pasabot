/**
 * W21 web: Settings → Automation. Per agent: the automation switch, a "new token" form (the raw token is shown
 * once, with a copy button and a `pasabot run` example), and the token list with Revoke. Owner session only (the
 * server refuses anyone else). Strings come from this module's locale files; the shell sets <html lang>.
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';

const translations = moduleTranslator(
  'automation',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

interface AgentRow {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  activeTokens: number;
}
interface TokenRow {
  id: string;
  agentId: string;
  label: string;
  active: boolean;
  remoteOk: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
const API = '/api/m/automation';
async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
const when = (ms: number) => new Date(ms).toLocaleString(displayLocale());
const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;

function NewToken({ agent, onCreated }: { agent: AgentRow; onCreated: () => void }) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('90');
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ token: string }>('/tokens', {
        body: {
          agentId: agent.id,
          label: label.trim() || 'script',
          remoteOk: remote,
          expiresInDays: days === 'never' ? null : Number(days),
        },
      });
      setMade(r.token);
      setLabel('');
      setRemote(false);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (made)
    return (
      <div role="status" data-testid="automation-new-token" style={{ display: 'grid', gap: 8 }}>
        <strong>{t('created.title')}</strong>
        <span>{t('created.body')}</span>
        <code data-testid="automation-token-value" style={{ overflowWrap: 'anywhere', fontSize: 14 }}>
          {made}
        </code>
        <div style={row}>
          <Button
            onClick={() =>
              void navigator.clipboard
                ?.writeText(made)
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            {copied ? t('created.copied') : t('created.copy')}
          </Button>
          <Button variant="primary" onClick={() => setMade(null)}>
            {t('created.done')}
          </Button>
        </div>
        <span>{t('created.usage')}</span>
        <code
          style={{ overflowWrap: 'anywhere', fontSize: 14 }}
        >{`pasabot run ${agent.slug} "sum 2+2" --wait`}</code>
      </div>
    );
  return (
    <form
      style={{ display: 'grid', gap: 8 }}
      aria-label={t('form.title', { name: agent.name })}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <strong>{t('form.title', { name: agent.name })}</strong>
      <Field
        label={t('form.label')}
        hint={t('form.labelHint')}
        value={label}
        maxLength={60}
        onChange={(e: { target: { value: string } }) => setLabel(e.target.value)}
      />
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="bk-field__label">{t('form.expiry')}</span>
        <select
          className="bk-input"
          value={days}
          style={{ minHeight: 44 }}
          onChange={(e) => setDays(e.target.value)}
        >
          <option value="30">{t('form.days30')}</option>
          <option value="90">{t('form.days90')}</option>
          <option value="365">{t('form.days365')}</option>
          <option value="never">{t('form.never')}</option>
        </select>
      </label>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44 }}>
        <input
          type="checkbox"
          style={{ width: 22, height: 22, flex: 'none' }}
          checked={remote}
          onChange={(e) => setRemote(e.target.checked)}
        />
        <span>{t('form.remote')}</span>
      </label>
      <span style={{ fontSize: 14 }}>{t('form.remoteHint')}</span>
      {err && (
        <p role="alert" className="bk-field__error">
          {err}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('form.creating') : t('form.create')}
        </Button>
      </div>
    </form>
  );
}

function AgentCard({
  agent,
  tokens,
  reload,
}: {
  agent: AgentRow;
  tokens: TokenRow[];
  reload: () => Promise<void>;
}) {
  const t = useT();
  // shown at once; the server's answer (reload) settles it
  const [enabled, setEnabled] = useState(agent.enabled);
  useEffect(() => setEnabled(agent.enabled), [agent.enabled]);
  const toggle = async (on: boolean) => {
    setEnabled(on);
    await call(`/agents/${agent.id}`, { method: 'PUT', body: { enabled: on } }).catch(() => {});
    await reload();
  };
  const revoke = async (id: string) => {
    await call(`/tokens/${id}/revoke`, { body: {} }).catch(() => {});
    await reload();
  };
  return (
    <Card as="article" data-testid={`automation-agent-${agent.slug}`} style={{ display: 'grid', gap: 12 }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, fontSize: 15 }}>
        <input
          type="checkbox"
          style={{ width: 22, height: 22, flex: 'none' }}
          checked={enabled}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {t('agent.switch', { name: agent.name })}
        </span>
        <Badge>{enabled ? t('agent.on') : t('agent.off')}</Badge>
      </label>
      {enabled && agent.enabled && <NewToken agent={agent} onCreated={() => void reload()} />}
      {tokens.length > 0 && (
        <section style={{ display: 'grid', gap: 8 }} aria-label={t('list.title')}>
          <strong>{t('list.title')}</strong>
          {tokens.map((tk) => (
            <div
              key={tk.id}
              data-testid="automation-token-row"
              style={{
                ...row,
                justifyContent: 'space-between',
                borderTop: '1px solid var(--bk-line, #8883)',
                paddingTop: 8,
              }}
            >
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span style={{ overflowWrap: 'anywhere', fontWeight: 600 }}>{tk.label}</span>
                <span style={{ fontSize: 14 }}>
                  {tk.expiresAt ? t('list.expires', { when: when(tk.expiresAt) }) : t('list.noExpiry')} ·{' '}
                  {tk.lastUsedAt ? t('list.lastUsed', { when: when(tk.lastUsedAt) }) : t('list.neverUsed')} ·{' '}
                  {tk.remoteOk ? t('list.remote') : t('list.localOnly')}
                </span>
              </div>
              {tk.active ? (
                <Button variant="danger" onClick={() => void revoke(tk.id)}>
                  {t('list.revoke')}
                </Button>
              ) : (
                <Badge>{t('list.revoked')}</Badge>
              )}
            </div>
          ))}
        </section>
      )}
    </Card>
  );
}

function AutomationSettings() {
  const t = useT();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    try {
      const [a, tk] = await Promise.all([
        call<{ agents: AgentRow[] }>('/agents'),
        call<{ tokens: TokenRow[] }>('/tokens'),
      ]);
      setAgents(a.agents);
      setTokens(tk.tokens);
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div data-testid="automation-settings" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <p>{t('intro')}</p>
      {err && (
        <p role="alert" className="bk-field__error">
          {t('loadError')}
        </p>
      )}
      {agents?.length === 0 && <p>{t('noAgents')}</p>}
      {agents?.map((a) => (
        <AgentCard key={a.id} agent={a} tokens={tokens.filter((x) => x.agentId === a.id)} reload={load} />
      ))}
    </div>
  );
}

const mod: WebModule = {
  id: 'automation',
  settingsSections: [
    {
      id: 'automation',
      labelKey: 'automation:settings',
      hintKey: 'automation:find.settingsHint',
      keywordsKey: 'automation:find.settingsKeywords',
      component: AutomationSettings,
      order: 650,
      icon: 'key-token',
      group: 'automations',
      expert: true,
    },
  ],
};
export default mod;
