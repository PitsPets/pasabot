/** W7 web: the message search screen (`/search`) and its nav item. Results open the chat they came from. */
import type { WebModule } from '@pasabot/core/web';
import { intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Card, Field } from '@pasabot/ui';
import { useEffect, useState } from 'react';

const translations = moduleTranslator(
  'search',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

interface Hit {
  messageId: string;
  chatId: string;
  chatTitle: string;
  authorKind: string;
  snippet: string;
  createdAt: number;
}

const CSS = `
.sr-page{display:grid;gap:12px;padding:16px;max-width:760px;margin:0 auto;box-sizing:border-box;width:100%}
.sr-page h1{font-size:22px;margin:0}
.sr-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.sr-hit{display:grid;gap:4px;min-height:44px;padding:10px 12px;border:1px solid var(--bk-line);border-radius:12px;background:var(--bk-panel);color:var(--bk-ink);text-decoration:none}
.sr-hit strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-hit span{font-size:14px;overflow-wrap:anywhere}
.sr-hit small{font-size:12px;color:var(--bk-muted)}
.sr-note{font-size:14px;color:var(--bk-muted);margin:0}
`;

export function SearchPage() {
  const { t, lang } = useT();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setHits(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/m/search/messages?q=${encodeURIComponent(text)}`, {
          credentials: 'same-origin',
          signal: ctl.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setHits(((await r.json()) as { hits: Hit[] }).hits);
        setErr(null);
      } catch (e) {
        if (!ctl.signal.aborted) setErr(t('error', { reason: (e as Error).message }));
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, t]);
  const when = (ms: number) =>
    new Date(ms).toLocaleString(intlLocale(lang), {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  return (
    <section className="sr-page" data-testid="search-page">
      <style>{CSS}</style>
      <h1>{t('title')}</h1>
      <Field
        label={t('label')}
        type="search"
        value={q}
        placeholder={t('placeholder')}
        autoFocus
        onChange={(e: { target: { value: string } }) => setQ(e.target.value)}
      />
      {err ? <p className="sr-note">{err}</p> : null}
      {hits && !hits.length ? <p className="sr-note">{t('empty')}</p> : null}
      {hits?.length ? (
        <Card>
          <p className="sr-note" role="status">
            {t('count', { count: hits.length })}
          </p>
          <ul className="sr-list">
            {hits.map((h) => (
              <li key={h.messageId}>
                <a className="sr-hit" href={`#/chats/${h.chatId}`} data-testid="search-hit">
                  <strong>{h.chatTitle || t('untitled')}</strong>
                  <span>{h.snippet}</span>
                  <small>
                    {t(`author.${h.authorKind}`)} · {when(h.createdAt)}
                  </small>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {!hits ? <p className="sr-note">{t('hint')}</p> : null}
    </section>
  );
}

const mod: WebModule = {
  id: 'search',
  routes: [
    { path: '/search', component: SearchPage, titleKey: 'search:title', roles: ['owner', 'member', 'guest'] },
  ],
  navItems: [
    {
      id: 'search',
      labelKey: 'search:nav',
      hintKey: 'search:find.navHint',
      keywordsKey: 'search:find.navKeywords',
      to: '/search',
      icon: 'search',
      group: 'memory',
      optional: false,
      order: 150,
      roles: ['owner', 'member', 'guest'],
    },
  ],
};
export default mod;
