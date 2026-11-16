/**
 * First run: claim the server with the one-time setup code. The code rides in the link's URL fragment: the desktop
 * app opens its window on that link and the server prints it, so a first-timer never sees or types it.
 *
 * Inside the desktop app (the macOS window, which installs the `pasabotSetup` message handler) the code is never asked
 * for: when the page has no code, or the server refused it (it ran out while the window sat open), the page asks the
 * window for a fresh link ("need-setup-link"); the window gets one from the server over its private channel and moves
 * the page to it in place (a hash change, so the name and password typed stay), and a refused claim goes again on its
 * own. Only when no link comes (the window says so with a `pasabot:no-setup-link` event, or the wait runs out) does the
 * page say to close and reopen the app.
 *
 * In a plain browser the field shows to someone who reached an unclaimed server without the code (or whose code was
 * used up), with one plain line on where to get a new one: a stranger on the network cannot claim the server without it.
 */
import { Button, Field } from '@pasabot/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, post } from '../app/api.js';
import { AuthFrame } from '../app/chrome.js';
import { useT } from '../app/i18n.js';
import { navigate, useRoute } from '../app/router.js';
import { loadMe } from '../app/store.js';

/** how long the page waits for the desktop window's fresh link before saying to reopen the app */
const LINK_TIMEOUT_MS = 8000;
/** the calm "getting ready" line shows only when the link takes longer than this (it usually takes milliseconds) */
const SHOW_WAIT_AFTER_MS = 400;
/** asks per page; more means something loops, and the page says to reopen the app instead */
const MAX_ASKS = 4;

interface Bridge {
  postMessage(message: string): void;
}
/** the macOS app window's one message handler; absent in a browser */
function desktopBridge(): Bridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, Bridge | undefined> } };
  const b = w.webkit?.messageHandlers?.pasabotSetup;
  return b && typeof b.postMessage === 'function' ? b : null;
}

export function Setup() {
  const t = useT();
  const route = useRoute();
  const [bridge] = useState(desktopBridge);
  // the code follows the address: the desktop window may load the link after the bare address (a hash change)
  const linkToken = route.query.get('token') ?? '';
  const [typed, setTyped] = useState('');
  // the link's code that was refused (used up or expired): ask for one, until another link arrives
  const [refused, setRefused] = useState<string | null>(null);
  const needLink = !linkToken || refused === linkToken;
  // in the desktop app the field never shows: a fresh link is asked for instead
  const askCode = needLink && !bridge;
  const token = needLink ? typed : linkToken;
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [trustOpen, setTrustOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // desktop app: the link the page gave up waiting on (then it says to reopen), and whether the wait line shows yet
  const [stuckFor, setStuckFor] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  // desktop app: the person pressed the button; the claim goes once the fresh link is in
  const [resend, setResend] = useState(false);
  const asks = useRef(0);
  // claimed: the page is leaving (its address no longer has the code), so it must not ask for another
  const claimed = useRef(false);
  const stuck = bridge !== null && needLink && stuckFor === linkToken;
  const waiting = bridge !== null && needLink && !stuck;

  useEffect(() => {
    if (!bridge || !needLink || claimed.current) return;
    if (asks.current >= MAX_ASKS) {
      setStuckFor(linkToken);
      return;
    }
    asks.current += 1;
    setSlow(false);
    try {
      bridge.postMessage('need-setup-link');
    } catch {
      setStuckFor(linkToken);
      return;
    }
    const show = setTimeout(() => setSlow(true), SHOW_WAIT_AFTER_MS);
    const giveUp = setTimeout(() => setStuckFor(linkToken), LINK_TIMEOUT_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(giveUp);
    };
  }, [bridge, needLink, linkToken]);

  // desktop app: the window says no fresh link will come (an owner exists, or no server): say so now, not after the wait
  useEffect(() => {
    if (!bridge || !needLink) return;
    const none = () => setStuckFor(linkToken);
    window.addEventListener('pasabot:no-setup-link', none);
    return () => window.removeEventListener('pasabot:no-setup-link', none);
  }, [bridge, needLink, linkToken]);

  const claim = async (sent: string) => {
    setBusy(true);
    try {
      await post('/api/v1/setup', { token: sent.trim(), displayName: name.trim(), password });
      claimed.current = true;
      // drop the spent token from the address bar and history
      navigate('/welcome', true);
      await loadMe();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      if (code === 'invalid_setup_token' && bridge) {
        // desktop app: the code ran out while the window sat open; a fresh link comes and the claim goes again
        setRefused(sent);
        setResend(true);
      } else if (code === 'invalid_setup_token') {
        setRefused(linkToken);
        setTyped('');
        setTokenError(t('setup.badToken'));
      } else setError(code === 'owner_exists' ? t('setup.ownerExists') : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };
  const claimRef = useRef(claim);
  claimRef.current = claim;

  // the fresh link is in: send the claim the person already asked for, with what they typed
  useEffect(() => {
    if (!resend || needLink || busy) return;
    setResend(false);
    void claimRef.current(linkToken);
  }, [resend, needLink, busy, linkToken]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setTokenError(null);
    if (password.length < 8) return setError(t('setup.tooShort'));
    if (password !== confirm) return setError(t('setup.mismatch'));
    // desktop app, the fresh link is still on its way: the claim goes as soon as it is in
    if (bridge && needLink) {
      if (!stuck) setResend(true);
      return;
    }
    await claim(token);
  };

  return (
    <AuthFrame title={t('setup.title')} intro={t('setup.intro')} tagline>
      <form className="stack" onSubmit={submit}>
        {askCode && (
          <Field
            label={t('setup.token')}
            hint={t('setup.tokenHint')}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            error={tokenError}
            data-testid="setup-code"
          />
        )}
        {waiting && slow && (
          <p className="muted" role="status" data-testid="setup-waiting">
            {t('setup.gettingReady')}
          </p>
        )}
        {stuck && (
          <p className="bk-field__error" role="alert" data-testid="setup-reopen">
            {t('setup.reopen')}
          </p>
        )}
        <Field
          label={t('setup.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
          maxLength={80}
        />
        <Field
          label={t('setup.password')}
          hint={t('setup.passwordHint')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <Field
          label={t('setup.confirm')}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          error={error}
        />
        {/* one friendly line; the full trust note stays one tap away ("How it asks you") */}
        <div className="setup-trust" role="note" data-testid="trust-warning">
          <p className="muted">{t('setup.trustLine')}</p>
          <button
            type="button"
            className="setup-trust-how"
            aria-expanded={trustOpen}
            aria-controls="setup-trust-full"
            onClick={() => setTrustOpen((v) => !v)}
            data-testid="trust-how"
          >
            {t('setup.trustHow')}
          </button>
          {trustOpen && (
            <p className="muted" id="setup-trust-full">
              {t('agents.trustWarning')}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" block disabled={busy || (resend && waiting)}>
          {t('setup.submit')}
        </Button>
        <p className="muted setup-boss">{t('setup.bossNote')}</p>
      </form>
    </AuthFrame>
  );
}
