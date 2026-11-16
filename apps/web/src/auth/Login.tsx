/** Sign in: the password first; a passkey and pairing this device with a code fold under "Other ways to sign in". */
import { Button, Field } from '@pasabot/ui';
import { type FormEvent, useId, useState } from 'react';
import { ApiError, post } from '../app/api.js';
import { AuthFrame } from '../app/chrome.js';
import { useT } from '../app/i18n.js';
import { loadMe } from '../app/store.js';
import { passkeysSupported, signInWithPasskey } from './passkey.js';

/**
 * A person who is not the owner (W23: someone who accepted an invite) is remembered on this device as
 * `pasabot.account` = `{ id, name }` (no secret), so the form signs them in instead of the owner.
 */
const ACCOUNT_KEY = 'pasabot.account';
function rememberedAccount(): { id: string; name: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null') as {
      id?: unknown;
      name?: unknown;
    } | null;
    return v && typeof v.id === 'string' && typeof v.name === 'string' ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

export function Login() {
  const t = useT();
  const [account, setAccount] = useState(rememberedAccount);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [others, setOthers] = useState(false);
  const othersId = useId();

  const done = async () => {
    await loadMe();
  };
  const fail = (err: unknown) => {
    const code = err instanceof ApiError ? err.code : 'network';
    setError(
      code === 'invalid_credentials'
        ? t('login.failed')
        : code === 'rate_limited'
          ? t('errors.rateLimited')
          : t('errors.generic'),
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post('/api/v1/auth/login', account ? { password, userId: account.id } : { password });
      await done();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const passkey = async () => {
    setError(null);
    setBusy(true);
    try {
      await signInWithPasskey();
      await done();
    } catch (err) {
      if (err instanceof ApiError) fail(err);
      else setError(t('login.passkeyCancelled'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={t('login.title')} intro={t('login.intro')} tagline>
      <form className="stack" onSubmit={submit}>
        <Field
          label={t('login.password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          error={error}
        />
        <Button type="submit" variant="primary" block disabled={busy}>
          {t('login.submit')}
        </Button>
      </form>
      {/* the password is the way in; a passkey and pairing a phone wait one tap down */}
      <Button
        variant="ghost"
        block
        className="mt"
        aria-expanded={others}
        aria-controls={othersId}
        onClick={() => setOthers(!others)}
        data-testid="login-other-ways"
      >
        {t('login.otherWays')}
      </Button>
      {others && (
        <div id={othersId} className="stack" data-testid="login-other-list">
          {passkeysSupported() && (
            <Button block onClick={passkey} disabled={busy}>
              {t('login.passkey')}
            </Button>
          )}
          <a className="bk-btn bk-btn--secondary bk-btn--block" href="#/pair">
            {t('login.pairInstead')}
          </a>
        </div>
      )}
      {account && (
        <p className="auth-foot" data-testid="login-account">
          {t('login.asPerson', { name: account.name })}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              try {
                localStorage.removeItem(ACCOUNT_KEY);
              } catch {}
              setAccount(null);
            }}
          >
            {t('login.notYou')}
          </Button>
        </p>
      )}
    </AuthFrame>
  );
}
