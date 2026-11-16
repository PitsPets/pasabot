/** Background processes: what agents started through PasaBot tools, with Stop. */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';

interface Proc {
  id: string;
  agentId: string;
  pid: number;
  cmd: string;
  startedAt: number;
  endedAt: number | null;
}

const translations = moduleTranslator(
  'procs',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

function ProcsPage() {
  const t = useT();
  const [procs, setProcs] = useState<Proc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch('/api/m/procs/procs', { credentials: 'same-origin' });
    if (r.ok) {
      setProcs(((await r.json()) as { procs: Proc[] }).procs);
      setErr(null);
    } else setErr(`HTTP ${r.status}`);
  }, []);
  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [load]);
  const stop = async (id: string) => {
    const r = await fetch(`/api/m/procs/procs/${id}/stop`, { method: 'POST', credentials: 'same-origin' });
    if (!r.ok) setErr(`HTTP ${r.status}`);
    await load();
  };
  return (
    <section
      data-slot="route"
      style={{ display: 'grid', gap: 16, maxWidth: 760, paddingInline: 16, marginInline: 'auto' }}
    >
      <h1>{t('page.title')}</h1>
      <p>{t('page.intro')}</p>
      {err && (
        <p role="alert" className="bk-field__error">
          {err}
        </p>
      )}
      {procs.length === 0 && <p>{t('page.empty')}</p>}
      {procs.map((p) => (
        <Card as="article" key={p.id} style={{ display: 'grid', gap: 8 }}>
          <code style={{ overflowWrap: 'anywhere' }}>{p.cmd}</code>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Badge>PID {p.pid}</Badge>
            <span>
              {t('proc.since')} {new Date(p.startedAt).toLocaleString(displayLocale())}
            </span>
            <Button variant="danger" onClick={() => void stop(p.id)}>
              {t('proc.stop')}
            </Button>
          </div>
        </Card>
      ))}
    </section>
  );
}

const mod: WebModule = {
  id: 'procs',
  routes: [{ path: '/procs', component: ProcsPage, titleKey: 'procs:page.title' }],
  navItems: [
    {
      id: 'procs',
      labelKey: 'procs:nav',
      hintKey: 'procs:find.navHint',
      keywordsKey: 'procs:find.navKeywords',
      to: '/procs',
      icon: 'activity',
      group: 'advanced',
      optional: false,
      expert: true,
      order: 310,
    },
  ],
};
export default mod;
