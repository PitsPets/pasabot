/**
 * App root: decides between first-run setup, sign-in, device pairing and the signed-in shell. Signed out, a module
 * route marked `public` (an invite's accept page, W23) renders too. Offline with nothing to show (the service
 * worker served the cached shell), it says so and offers a retry instead of a sign-in form that cannot work.
 */
import { Button } from '@pasabot/ui';
import { useEffect, useState } from 'react';
import { Login } from '../auth/Login.js';
import { Pair } from '../auth/Pair.js';
import { Setup } from '../auth/Setup.js';
import { Shell } from '../chat/Shell.js';
import { ApiError, api } from './api.js';
import { useI18n } from './i18n.js';
import { navigate, useRoute } from './router.js';
import { slots } from './slots.js';
import { live, loadMe, useStore } from './store.js';

type Gate = 'loading' | 'setup' | 'signedOut' | 'signedIn' | 'offline';
const CORE_PATHS = new Set(['/setup', '/login', '/pair']);

export function App() {
  const route = useRoute();
  const me = useStore((s) => s.me);
  const [gate, setGate] = useState<Gate>('loading');

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void attempt;
    (async () => {
      const u = await loadMe();
      if (!alive) return;
      if (u) return setGate('signedIn');
      // a network failure (no HTTP answer at all) means offline or the server is down: say so
      const s = await api<{ needsSetup: boolean }>('/api/v1/setup').catch((e) =>
        e instanceof ApiError ? { needsSetup: false } : null,
      );
      if (!alive) return;
      if (!s) return setGate('offline');
      setGate(s.needsSetup ? 'setup' : 'signedOut');
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);
  useEffect(() => {
    const back = () => setAttempt((n) => n + 1);
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);

  useEffect(() => {
    if (me && gate !== 'signedIn') setGate('signedIn');
    if (!me && gate === 'signedIn') setGate('signedOut');
  }, [me, gate]);

  useEffect(() => {
    if (gate !== 'signedIn') return;
    live.start();
    return () => live.stop();
  }, [gate]);

  useEffect(() => {
    if (gate === 'signedIn' && (route.path === '/setup' || route.path === '/login')) navigate('/', true);
  }, [gate, route.path]);

  if (gate === 'loading') return <Splash />;
  if (gate === 'offline') return <Offline retry={() => setAttempt((n) => n + 1)} />;
  if (gate !== 'signedIn') {
    const pub = CORE_PATHS.has(route.path)
      ? undefined
      : slots.routes.find((r) => r.public && r.path === route.path);
    if (pub) {
      const C = pub.component;
      return <C />;
    }
    if (route.path === '/pair') return <Pair />;
    // a claimed server opened through an old setup link signs in (its claim page would only say "already claimed")
    if (gate === 'setup') return <Setup />;
    return <Login />;
  }
  return <Shell />;
}

function Offline({ retry }: { retry(): void }) {
  const { t } = useI18n();
  return (
    <main className="auth-page" data-testid="offline-shell">
      <h1>{t('web:offline.title')}</h1>
      <p>{t('web:offline.body')}</p>
      <Button variant="primary" onClick={retry}>
        {t('web:offline.retry')}
      </Button>
    </main>
  );
}

function Splash() {
  const { t } = useI18n();
  return (
    <main className="auth-page" aria-busy="true">
      <p>{t('core:common.loading')}</p>
    </main>
  );
}
