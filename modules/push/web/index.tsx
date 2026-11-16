/**
 * Settings → Notifications on this device (W23 web push): turn push on or off for this browser, choose what it
 * gets, send a test. The subscription lives in the browser; the server keeps its endpoint and keys.
 */
import type { WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';

const translations = moduleTranslator(
  'push',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

const API = '/api/m/push';
async function call<R>(path: string, init: RequestInit = {}): Promise<R> {
  const r = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as R;
}

const PREFS = ['approval', 'error', 'finished', 'progress', 'alert'] as const;
type Prefs = Record<(typeof PREFS)[number], boolean>;
interface Sub {
  id: string;
  label: string;
  prefs: Prefs;
  lastOkAt: number | null;
  lastError: string | null;
}
const SUB_KEY = 'pasabot.push.sub';
const savedId = () => {
  try {
    return localStorage.getItem(SUB_KEY);
  } catch {
    return null;
  }
};
const supported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;
const keyBytes = (b64u: string) => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const deviceLabel = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone/iPad'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const br = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return [br, os].filter(Boolean).join(' · ').slice(0, 80);
};

const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const tap = { minHeight: 44 } as const;

function PushSettings() {
  const { t, lang: lng } = useT();
  const [sub, setSub] = useState<Sub | null>(null);
  const [state, setState] = useState<'loading' | 'off' | 'on' | 'unsupported' | 'blocked' | 'unavailable'>(
    'loading',
  );
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('blocked');
    const cfg = await call<{ available: boolean }>('/config').catch(() => ({ available: false }));
    if (!cfg.available) return setState('unavailable');
    const id = savedId();
    const mine = await call<{ subscriptions: Sub[] }>('/subscriptions').catch(() => ({ subscriptions: [] }));
    const s = mine.subscriptions.find((x) => x.id === id) ?? null;
    setSub(s);
    setState(s ? 'on' : 'off');
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'blocked' : 'off');
        return;
      }
      const cfg = await call<{ publicKey: string }>('/config');
      const reg = await navigator.serviceWorker.ready;
      const ps =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(cfg.publicKey),
        }));
      const j = ps.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      const s = await call<Sub>('/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, label: deviceLabel(), lang: lng }),
      });
      try {
        localStorage.setItem(SUB_KEY, s.id);
      } catch {}
      setSub(s);
      setState('on');
    } catch {
      setNote(t('errors.subscribe'));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      if (sub) await call(`/subscriptions/${sub.id}`, { method: 'DELETE' }).catch(() => undefined);
      const reg = await navigator.serviceWorker.ready;
      await (await reg.pushManager.getSubscription())?.unsubscribe();
      try {
        localStorage.removeItem(SUB_KEY);
      } catch {}
      setSub(null);
      setState('off');
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (k: (typeof PREFS)[number], v: boolean) => {
    if (!sub) return;
    setSub(
      await call<Sub>(`/subscriptions/${sub.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ prefs: { [k]: v } }),
      }),
    );
  };
  const test = async () => {
    if (!sub) return;
    setNote(null);
    const r = await call<{ ok: boolean }>(`/subscriptions/${sub.id}/test`, { method: 'POST' }).catch(() => ({
      ok: false,
    }));
    setNote(r.ok ? t('test.sent') : t('test.failed'));
  };

  return (
    <Card
      as="section"
      aria-labelledby="push-title"
      data-testid="push-settings"
      style={{ display: 'grid', gap: 12 }}
    >
      <h2 id="push-title" style={{ margin: 0, fontSize: 18 }}>
        {t('title')}
      </h2>
      <p style={{ margin: 0 }}>{t('intro')}</p>
      <div style={row}>
        <Badge>{t(`state.${state}`)}</Badge>
      </div>
      {state === 'unsupported' && <p style={{ margin: 0 }}>{t('help.unsupported')}</p>}
      {state === 'blocked' && <p style={{ margin: 0 }}>{t('help.blocked')}</p>}
      {state === 'unavailable' && <p style={{ margin: 0 }}>{t('help.unavailable')}</p>}
      {state === 'off' && (
        <div style={row}>
          <Button variant="primary" style={tap} disabled={busy} onClick={() => void turnOn()}>
            {t('turnOn')}
          </Button>
        </div>
      )}
      {state === 'on' && sub && (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}>
            <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('prefs.title')}</legend>
            {PREFS.map((k) => (
              <label key={k} style={{ ...row, ...tap }}>
                <input
                  type="checkbox"
                  style={{ width: 22, height: 22 }}
                  checked={sub.prefs[k]}
                  onChange={(e) => void toggle(k, e.currentTarget.checked)}
                />
                <span>{t(`prefs.${k}`)}</span>
              </label>
            ))}
          </fieldset>
          <div style={row}>
            <Button style={tap} onClick={() => void test()}>
              {t('test.button')}
            </Button>
            <Button variant="ghost" style={tap} disabled={busy} onClick={() => void turnOff()}>
              {t('turnOff')}
            </Button>
          </div>
        </>
      )}
      {note && (
        <p role="status" style={{ margin: 0 }}>
          {note}
        </p>
      )}
      <p style={{ margin: 0, fontSize: 14 }}>{t('help.iphone')}</p>
    </Card>
  );
}

const mod: WebModule = {
  id: 'push',
  // every signed-in person turns notifications on for their own device
  settingsSections: [
    {
      id: 'push',
      labelKey: 'push:title',
      hintKey: 'push:find.settingsHint',
      keywordsKey: 'push:find.settingsKeywords',
      icon: 'bell',
      group: 'people',
      optional: false,
      component: PushSettings,
      order: 150,
      roles: ['owner', 'member', 'guest'],
    },
  ],
};
export default mod;
