/** ACP agents (Settings): registry index, search, install, remove, status. Owner only. */

import type { WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

import { Badge, Button, Card, Field, safeHref } from '@pasabot/ui';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

interface IndexAgent {
  id: string;
  name: string;
  description: string;
  version: string;
  homepage?: string;
  distribution: { type: 'command' | 'npm' };
  installed: boolean;
  installedVersion: string | null;
  allowed: boolean;
}
interface InstalledAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  command: string[];
  providerId: string;
  status: { installed: boolean; version?: string; hint?: string };
}

const API = '/api/m/acp-registry';
const translations = moduleTranslator(
  'acp-registry',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok)
    throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { code: j.error ?? String(r.status) });
  return j;
}

const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;

export function AcpAgentsSection() {
  const t = useT();
  const [source, setSource] = useState('');
  const [saved, setSaved] = useState(false);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState<IndexAgent[] | null>(null);
  const [installed, setInstalled] = useState<InstalledAgent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // the owner may type before the stored index arrives: a late load never overwrites what they typed
  const edited = useRef(false);

  const explain = useCallback(
    (e: unknown) => {
      const code = (e as { code?: string }).code ?? 'error';
      if (code === 'forbidden') setForbidden(true);
      const key = `error.${code}`;
      const msg = t(key);
      setErr(msg === key || msg.endsWith(key) ? t('error.generic', { code }) : msg);
    },
    [t],
  );

  const loadInstalled = useCallback(async () => {
    try {
      setInstalled((await call<{ agents: InstalledAgent[] }>('GET', '/installed')).agents);
    } catch (e) {
      explain(e);
    }
  }, [explain]);
  const search = useCallback(
    async (query: string) => {
      try {
        setIndex(
          (await call<{ agents: IndexAgent[] }>('GET', `/index?q=${encodeURIComponent(query)}`)).agents,
        );
        setErr(null);
      } catch (e) {
        setIndex(null);
        if ((e as { code?: string }).code !== 'no_index') explain(e);
      }
    },
    [explain],
  );

  useEffect(() => {
    void (async () => {
      try {
        const s = await call<{ indexSource: string }>('GET', '/settings');
        if (!edited.current) setSource(s.indexSource);
        if (s.indexSource) await search('');
        await loadInstalled();
      } catch (e) {
        explain(e);
      }
    })();
  }, [explain, loadInstalled, search]);

  const saveSource = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    try {
      await call('PUT', '/settings', { indexSource: source.trim() });
      setSaved(true);
      setErr(null);
      if (source.trim()) await search(q);
      else setIndex(null);
    } catch (x) {
      explain(x);
    }
  };
  const install = async (id: string) => {
    setBusy(id);
    try {
      await call('POST', '/installed', { id });
      setErr(null);
      await Promise.all([loadInstalled(), search(q)]);
    } catch (x) {
      explain(x);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (a: InstalledAgent) => {
    if (typeof window !== 'undefined' && !window.confirm(t('installed.confirmRemove', { name: a.name })))
      return;
    setBusy(a.id);
    try {
      await call('DELETE', `/installed/${encodeURIComponent(a.id)}`);
      setErr(null);
      await Promise.all([loadInstalled(), source ? search(q) : Promise.resolve()]);
    } catch (x) {
      explain(x);
    } finally {
      setBusy(null);
    }
  };

  if (forbidden) return <p>{t('settings.ownerOnly')}</p>;
  return (
    <div data-testid="acp-registry" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <p>{t('settings.intro')}</p>
      {err && (
        <p role="alert" className="bk-field__error">
          {err}
        </p>
      )}
      <form onSubmit={saveSource} style={{ display: 'grid', gap: 8 }}>
        <Field
          label={t('index.label')}
          hint={t('index.hint')}
          value={source}
          onChange={(e) => {
            edited.current = true;
            setSource(e.currentTarget.value);
            setSaved(false);
          }}
          spellCheck={false}
          autoCapitalize="off"
        />
        <div style={row}>
          <Button type="submit" variant="primary">
            {t('index.save')}
          </Button>
          {saved && <span role="status">{t('index.saved')}</span>}
        </div>
      </form>

      <section style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t('installed.title')}</h3>
        {installed.length === 0 && <p>{t('installed.empty')}</p>}
        {installed.map((a) => (
          <Card as="article" key={a.id} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
            <div style={row}>
              <strong>{a.name}</strong>
              <Badge tone={a.status.installed ? 'primary' : 'outline'}>
                {a.status.installed ? t('installed.ready') : t('installed.missing')}
              </Badge>
              {(a.status.version || a.version) && (
                <span>{t('installed.version', { version: a.status.version || a.version })}</span>
              )}
            </div>
            {a.description && <span>{a.description}</span>}
            <span>
              {t('installed.provider')}: <code>{a.providerId}</code>
            </span>
            <span style={{ overflowWrap: 'anywhere' }}>
              {t('installed.command')}: <code>{a.command.join(' ')}</code>
            </span>
            {a.status.hint && <span className="bk-field__hint">{a.status.hint}</span>}
            <div style={row}>
              <Button variant="danger" disabled={busy === a.id} onClick={() => void remove(a)}>
                {busy === a.id ? t('installed.removing') : t('installed.remove')}
              </Button>
            </div>
          </Card>
        ))}
      </section>

      <section style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t('search.available')}</h3>
        {index === null ? (
          <p>{t('index.none')}</p>
        ) : (
          <>
            <Field
              label={t('search.label')}
              placeholder={t('search.placeholder')}
              type="search"
              value={q}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setQ(v);
                void search(v);
              }}
            />
            {index.length === 0 && <p>{t('search.empty')}</p>}
            {index.map((a) => (
              <Card as="article" key={a.id} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
                <div style={row}>
                  <strong>{a.name}</strong>
                  {a.version && <Badge tone="outline">{a.version}</Badge>}
                  {a.installed && <Badge tone="primary">{t('search.installed')}</Badge>}
                </div>
                {a.description && <span>{a.description}</span>}
                {safeHref(a.homepage) && (
                  <a
                    href={safeHref(a.homepage)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {a.homepage}
                  </a>
                )}
                {a.allowed ? (
                  <div style={row}>
                    <Button
                      variant={a.installed ? 'secondary' : 'primary'}
                      disabled={busy === a.id}
                      onClick={() => void install(a.id)}
                      aria-label={`${a.installed ? t('search.reinstall') : t('search.install')} ${a.name}`}
                    >
                      {busy === a.id
                        ? t('search.installing')
                        : a.installed
                          ? t('search.reinstall')
                          : t('search.install')}
                    </Button>
                  </div>
                ) : (
                  <span className="bk-field__hint">{t('search.remoteCommand')}</span>
                )}
              </Card>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

const mod: WebModule = {
  id: 'acp-registry',
  settingsSections: [
    {
      id: 'acp-agents',
      labelKey: 'acp-registry:settings.title',
      hintKey: 'acp-registry:find.settingsHint',
      keywordsKey: 'acp-registry:find.settingsKeywords',
      component: AcpAgentsSection,
      order: 200,
      icon: 'agent',
      group: 'agents',
      optional: false,
      expert: true,
    },
  ],
};
export default mod;
