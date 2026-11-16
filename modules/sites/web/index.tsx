/**
 * W18 web: the Sites screen (`/sites`). The owner sees every live site an agent published (who, how many files,
 * size, when it expires), opens it on the sites origin, renews it, makes it public or private, removes it, and sets
 * the tunnel address public sites show. Site URLs come from the server and pass `safeHref` before they are links.
 */
import type { WebModule } from '@pasabot/core/web';
import { intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card, Field, safeHref } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';

const translations = moduleTranslator(
  'sites',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

export interface SiteView {
  id: string;
  slug: string;
  title: string;
  agent: { id: string; name: string | null };
  public: boolean;
  bytes: number;
  files: number;
  expiresAt: number;
  url: string;
  publicUrl: string | null;
  paths: { path: string; size: number }[];
}

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

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;
const when = (ms: number, lang: string) =>
  new Date(ms).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' });
const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;

export function SiteCard({
  site,
  canPublic,
  onChange,
}: {
  site: SiteView;
  canPublic: boolean;
  onChange: () => void;
}) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const base = `/api/m/sites/sites/${encodeURIComponent(site.id)}`;
  const href = safeHref(site.url);
  const publicHref = site.publicUrl ? safeHref(site.publicUrl) : undefined;
  return (
    <Card as="article" data-site={site.slug} style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, overflowWrap: 'anywhere' }}>{site.title}</h2>
        <span style={{ fontSize: 13, color: 'var(--bk-muted)', overflowWrap: 'anywhere' }}>{site.slug}</span>
      </div>
      <div style={{ ...row, gap: 6, fontSize: 13 }}>
        <Badge data-site-agent>
          {site.agent.name ? t('site.by', { name: site.agent.name }) : t('site.byRemoved')}
        </Badge>
        <Badge tone="outline">{t('site.files', { count: site.files })}</Badge>
        <Badge tone="outline">{size(site.bytes)}</Badge>
        <Badge tone={site.public ? 'primary' : 'outline'} data-site-visibility>
          {site.public ? t('site.public') : t('site.private')}
        </Badge>
      </div>
      <p data-site-expires style={{ margin: 0, fontSize: 14 }}>
        {t('site.expires', { when: when(site.expiresAt, lang) })}
      </p>
      {publicHref && (
        <p style={{ margin: 0, fontSize: 14, overflowWrap: 'anywhere' }}>
          {t('site.openPublic')}:{' '}
          <a href={publicHref} target="_blank" rel="noopener noreferrer" data-site-public-url>
            {site.publicUrl}
          </a>
        </p>
      )}
      <details>
        <summary
          style={{ cursor: 'pointer', fontSize: 14, minBlockSize: 44, display: 'flex', alignItems: 'center' }}
        >
          {t('site.list')}
        </summary>
        <ul style={{ margin: 0, paddingInlineStart: 20, fontSize: 14 }}>
          {site.paths.map((p) => (
            <li key={p.path} style={{ overflowWrap: 'anywhere' }}>
              {p.path} <span style={{ color: 'var(--bk-muted)' }}>({size(p.size)})</span>
            </li>
          ))}
        </ul>
      </details>
      <div style={row}>
        {href && (
          <a
            className="bk-btn bk-btn--primary bk-btn--sm"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            data-site-open
          >
            {t('site.open')}
          </a>
        )}
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void act(() => call(`${base}/renew`, { method: 'POST', body: JSON.stringify({ days: 7 }) }))
          }
        >
          {t('site.renew')}
        </Button>
        <Button
          size="sm"
          disabled={busy || (!site.public && !canPublic)}
          onClick={() =>
            void act(() =>
              call(`${base}/public`, { method: 'POST', body: JSON.stringify({ public: !site.public }) }),
            )
          }
        >
          {site.public ? t('site.makePrivate') : t('site.makePublic')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('site.confirmRemove', { title: site.title })))
              void act(() => call(base, { method: 'DELETE' }));
          }}
        >
          {t('site.remove')}
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {error}
        </p>
      )}
    </Card>
  );
}

export function SitesPage() {
  const { t } = useT();
  const [sites, setSites] = useState<SiteView[] | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tunnelMsg, setTunnelMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ sites: SiteView[]; publicBaseUrl: string }>('/api/m/sites/sites');
      setSites(r.sites);
      setBaseUrl(r.publicBaseUrl);
      setError(null);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);
  useEffect(() => {
    void load().then((r) => r && setDraft(r.publicBaseUrl));
  }, [load]);

  const saveTunnel = async () => {
    try {
      const r = await call<{ publicBaseUrl: string }>('/api/m/sites/settings', {
        method: 'PUT',
        body: JSON.stringify({ publicBaseUrl: draft }),
      });
      setDraft(r.publicBaseUrl);
      setTunnelMsg({ ok: true, text: t('tunnel.saved') });
      await load();
    } catch (e) {
      setTunnelMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <section data-sites-page style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 860, minWidth: 0 }}>
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        <p style={{ margin: 0, color: 'var(--bk-muted)', fontSize: 15 }}>{t('page.intro')}</p>
      </header>
      <div style={row}>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t('refresh')}
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {t('error', { reason: error })}
        </p>
      )}
      {sites === null ? (
        !error && <p style={{ margin: 0 }}>{t('loading')}</p>
      ) : sites.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--bk-muted)' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          {sites.map((s) => (
            <SiteCard key={s.id} site={s} canPublic={baseUrl !== ''} onChange={() => void load()} />
          ))}
        </div>
      )}
      <Card as="section" style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t('tunnel.title')}</h2>
        <Field
          label={t('tunnel.label')}
          hint={t('tunnel.hint')}
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          value={draft}
          onChange={(e: { target: { value: string } }) => setDraft(e.target.value)}
        />
        {!baseUrl && <p style={{ margin: 0, fontSize: 14, color: 'var(--bk-muted)' }}>{t('tunnel.none')}</p>}
        <div>
          <Button variant="primary" size="sm" onClick={() => void saveTunnel()}>
            {t('tunnel.save')}
          </Button>
        </div>
        {tunnelMsg && (
          <p
            role={tunnelMsg.ok ? 'status' : 'alert'}
            style={{ margin: 0, fontSize: 14, color: tunnelMsg.ok ? undefined : 'var(--bk-danger)' }}
          >
            {tunnelMsg.text}
          </p>
        )}
      </Card>
    </section>
  );
}

const mod: WebModule = {
  id: 'sites',
  routes: [{ path: '/sites', component: SitesPage, titleKey: 'sites:page.title' }],
  navItems: [
    {
      id: 'sites',
      labelKey: 'sites:nav',
      hintKey: 'sites:find.navHint',
      keywordsKey: 'sites:find.navKeywords',
      to: '/sites',
      icon: 'globe',
      group: 'tools',
      order: 340,
    },
  ],
};
export default mod;
