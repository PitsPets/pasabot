/**
 * Device side of QR pairing: the QR on the owner's screen opens `#/pair?code=…` here (or the code is typed).
 * Claim -> show the server fingerprint -> wait until the owner confirms on the other screen -> signed in.
 */
import { Button, Field } from '@pasabot/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, post } from '../app/api.js';
import { AuthFrame } from '../app/chrome.js';
import { useT } from '../app/i18n.js';
import { navigate, useRoute } from '../app/router.js';
import { loadMe } from '../app/store.js';
import { useWords } from '../app/words.js';

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

export function Pair() {
  const t = useT();
  const w = useWords();
  const route = useRoute();
  const [code, setCode] = useState(route.query.get('code') ?? '');
  const [name, setName] = useState(guessDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<{ claimId: string; claimSecret: string; fingerprint: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!claim) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/v1/pairing/claims/${claim.claimId}/session`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claimSecret: claim.claimSecret }),
        });
        if (!alive) return;
        if (r.status === 200) {
          navigate('/', true);
          await loadMe();
          return;
        }
        if (r.status === 403) {
          setClaim(null);
          setError(t('pair.rejected'));
          return;
        }
        if (r.status === 404) {
          setClaim(null);
          setError(t('pair.expired'));
          return;
        }
      } catch {
        // network blip: keep waiting
      }
      if (alive) timer.current = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [claim, t]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await post<{ claimId: string; claimSecret: string; fingerprint: string }>(
        '/api/v1/pairing/claim',
        { code: code.trim(), deviceName: name.trim() || guessDeviceName(), platform: 'web' },
      );
      setClaim(r);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_code' ? t('pair.invalid') : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (claim)
    return (
      <AuthFrame title={t('pair.waitingTitle')} intro={t('pair.waiting')}>
        <p className="fingerprint">
          <span>{w('pair.fingerprint')}</span>
          <b data-testid="pair-fingerprint">{claim.fingerprint}</b>
        </p>
        <p className="auth-foot" aria-live="polite">
          {w('pair.checkOther')}
        </p>
      </AuthFrame>
    );

  return (
    <AuthFrame title={t('pair.title')} intro={t('pair.intro')}>
      <form className="stack" onSubmit={submit}>
        <Field
          label={t('pair.code')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          required
          minLength={6}
        />
        <Field
          label={t('pair.deviceName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
          error={error}
        />
        <Button type="submit" variant="primary" block disabled={busy}>
          {t('pair.submit')}
        </Button>
      </form>
      <p className="auth-foot">
        <a href="#/login">{t('pair.backToLogin')}</a>
      </p>
    </AuthFrame>
  );
}
