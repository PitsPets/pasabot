/** Owner screen: pair a phone by QR (confirm it here), see and revoke paired devices, manage passkeys. */
import { displayLocale } from '@pasabot/i18n';
import { Badge, Button } from '@pasabot/ui';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, post } from '../app/api.js';
import { useI18n } from '../app/i18n.js';
import { useStore } from '../app/store.js';
import { useWords } from '../app/words.js';
import { ReauthCancelled, withReauth } from '../chat/approvals.js';
import { passkeysSupported, registerPasskey } from './passkey.js';

interface Device {
  id: string;
  name: string;
  platform: string | null;
  last_seen_at: number | null;
  revoked_at: number | null;
}
interface Claim {
  id: string;
  deviceName: string;
  platform: string | null;
  expiresAt: number;
}

export function Devices() {
  const { t, lang } = useI18n();
  const w = useWords();
  const fingerprint = useStore((s) => s.fingerprint);
  const owner = useStore((s) => s.me?.kind === 'owner');
  const [code, setCode] = useState<{ code: string; expiresAt: number; qr: string; link: string } | null>(
    null,
  );
  const [now, setNow] = useState(Date.now());
  const [claims, setClaims] = useState<Claim[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [passkeys, setPasskeys] = useState<{ id: string; createdAt: number }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  /** what the owner reads when an action did not go through: never silent */
  const failText = (e: unknown) =>
    e instanceof ReauthCancelled ? t('devices.reauthNeeded') : t('errors.generic');

  const refresh = useCallback(async () => {
    if (owner) {
      const [c, d] = await Promise.all([
        api<{ claims: Claim[] }>('/api/v1/pairing/claims').catch(() => ({ claims: [] })),
        api<{ devices: Device[] }>('/api/v1/devices').catch(() => ({ devices: [] })),
      ]);
      setClaims(c.claims);
      setDevices(d.devices);
    }
    const p = await api<{ passkeys: { id: string; createdAt: number }[] }>('/api/v1/auth/passkeys').catch(
      () => ({ passkeys: [] }),
    );
    setPasskeys(p.passkeys);
  }, [owner]);

  useEffect(() => {
    void refresh();
    const iv = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    return () => clearInterval(iv);
  }, [refresh]);

  // pairing a phone and confirming its claim need a fresh re-auth (401 `reauth_required`): the re-auth sheet asks,
  // then the same request runs again
  const newCode = async () => {
    setPairMsg(null);
    try {
      const r = await withReauth(t('devices.reauthPair'), () =>
        post<{ code: string; expiresAt: number }>('/api/v1/pairing'),
      );
      const link = `${location.origin}${location.pathname}#/pair?code=${encodeURIComponent(r.code)}`;
      const qr = await QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      setCode({ ...r, qr, link });
    } catch (e) {
      setPairMsg(failText(e));
    }
  };
  const decide = async (id: string, action: 'confirm' | 'reject') => {
    setPairMsg(null);
    try {
      const go = () => post(`/api/v1/pairing/claims/${id}/${action}`);
      await (action === 'confirm' ? withReauth(t('devices.reauthConfirm'), go) : go());
      if (action === 'confirm') setCode(null);
    } catch (e) {
      setPairMsg(failText(e));
    }
    await refresh();
  };
  const revoke = async (id: string) => {
    await post(`/api/v1/devices/${id}/revoke`).catch(() => {});
    await refresh();
  };
  const addPasskey = async () => {
    setMsg(null);
    try {
      await withReauth(t('devices.reauthPasskey'), () => registerPasskey());
      setMsg(t('devices.passkeyAdded'));
    } catch (e) {
      setMsg(
        e instanceof ReauthCancelled
          ? t('devices.reauthNeeded')
          : e instanceof ApiError
            ? t('errors.generic')
            : t('login.passkeyCancelled'),
      );
    }
    await refresh();
  };
  const removePasskey = async (id: string) => {
    await api(`/api/v1/auth/passkeys/${id}`, { method: 'DELETE' }).catch(() => {});
    await refresh();
  };

  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0;
  const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(displayLocale(lang)) : '—');

  return (
    <div className="page">
      <h1>{t('devices.title')}</h1>
      {owner && (
        <section className="bk-card panel" aria-labelledby="pair-h">
          <h2 id="pair-h">{t('devices.pairTitle')}</h2>
          <p className="muted">{t('devices.pairIntro')}</p>
          {code && left > 0 ? (
            <div className="pair-code">
              <img src={code.qr} width={240} height={240} alt={t('devices.qrAlt')} data-testid="pair-qr" />
              <div className="stack">
                <span className="muted">{t('devices.codeLabel')}</span>
                <b className="code" data-testid="pair-code" data-link={code.link}>
                  {code.code}
                </b>
                <span className="muted">{t('devices.expires', { count: left })}</span>
                {fingerprint && (
                  <span className="muted">
                    {w('pair.fingerprint')}: <b>{fingerprint}</b>
                  </span>
                )}
              </div>
            </div>
          ) : (
            <Button variant="primary" onClick={newCode}>
              {t('devices.newCode')}
            </Button>
          )}
          {pairMsg && (
            <p className="muted" role="status" data-testid="pair-status">
              {pairMsg}
            </p>
          )}
          {claims.length > 0 && (
            <div className="stack mt" aria-live="polite">
              <h3>{t('devices.claims')}</h3>
              {claims.map((c) => (
                <div key={c.id} className="row" data-testid="pair-claim">
                  <span className="grow">{c.deviceName}</span>
                  <Button size="sm" variant="primary" onClick={() => decide(c.id, 'confirm')}>
                    {t('devices.confirm')}
                  </Button>
                  <Button size="sm" onClick={() => decide(c.id, 'reject')}>
                    {t('devices.reject')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {owner && (
        <section className="bk-card panel" aria-labelledby="dev-h">
          <h2 id="dev-h">{t('devices.list')}</h2>
          {devices.length === 0 && <p className="muted">{t('devices.none')}</p>}
          <ul className="plain stack">
            {devices.map((d) => (
              <li key={d.id} className="row">
                <span className="grow">
                  <b>{d.name}</b>
                  <span className="muted"> · {fmt(d.last_seen_at)}</span>
                </span>
                {d.revoked_at ? (
                  <Badge>{t('devices.revoked')}</Badge>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => revoke(d.id)}>
                    {t('devices.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="bk-card panel" aria-labelledby="pk-h">
        <h2 id="pk-h">{t('devices.passkeys')}</h2>
        <p className="muted">{t('devices.passkeysIntro')}</p>
        <ul className="plain stack">
          {passkeys.map((p, i) => (
            <li key={p.id} className="row" data-testid="passkey-row">
              <span className="grow">{t('devices.passkeyN', { n: i + 1, date: fmt(p.createdAt) })}</span>
              <Button size="sm" variant="ghost" onClick={() => removePasskey(p.id)}>
                {t('devices.remove')}
              </Button>
            </li>
          ))}
        </ul>
        {passkeysSupported() && (
          <Button onClick={addPasskey} className="mt">
            {t('devices.addPasskey')}
          </Button>
        )}
        {msg && (
          <p className="muted" role="status">
            {msg}
          </p>
        )}
      </section>
    </div>
  );
}
