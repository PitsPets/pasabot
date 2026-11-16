/**
 * What the inbox pages share (ws/email): the module's translator, the owner-only API calls and their plain error
 * words, the mailbox settings shape, a titled card, and the manual mailbox form (hosts, ports, address, app
 * password; the "Other" service of the guided flow and the Inbox page's own setup).
 */
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { BrandTile, Button, Card, Field } from '@pasabot/ui';
import { type ReactNode, useEffect, useState } from 'react';

export type T = (k: string, o?: Record<string, unknown>) => string;
const translations = moduleTranslator(
  'inbox',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
export function useT(): T {
  return useModuleT(translations).t;
}

export const API = '/api/m/inbox';
export class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP ${status}`);
  }
}
export async function call<R>(path: string, init: RequestInit = {}): Promise<R> {
  const r = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string; message?: string };
    throw new CallError(r.status, j.code ?? j.error ?? 'other');
  }
  return (await r.json()) as R;
}
export const errText = (t: T, e: unknown) => {
  const code = e instanceof CallError ? e.code : 'other';
  const key = `error.${code}`;
  const s = t(key);
  return s === key ? t('error.other') : s;
};

export type Tls = 'implicit' | 'starttls';
export interface Settings {
  configured: boolean;
  hasPassword: boolean;
  address?: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  imapTls?: Tls;
  smtpHost?: string;
  smtpPort?: number;
  smtpTls?: Tls;
}

export function Section({
  id,
  title,
  intro,
  tile,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  /** the mark beside the title (a mailbox, the bridge) */
  tile?: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-labelledby={`inbox-${id}`} style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }}>
        {tile && <BrandTile id={tile} size={32} fallback="inbox" />}
        <h2 id={`inbox-${id}`} style={{ margin: 0, fontSize: 18 }}>
          {title}
        </h2>
      </div>
      {intro && <p style={{ margin: 0 }}>{intro}</p>}
      {children}
    </Card>
  );
}

function TlsSelect({
  label,
  value,
  onChange,
  t,
}: {
  label: string;
  value: Tls;
  onChange(v: Tls): void;
  t: T;
}) {
  return (
    <label className="bk-field">
      <span className="bk-field__label">{label}</span>
      <select
        className="bk-input"
        value={value}
        onChange={(e) => onChange(e.target.value as Tls)}
        style={{ minHeight: 44, maxWidth: '100%' }}
      >
        <option value="implicit">{t('setup.tls.implicit')}</option>
        <option value="starttls">{t('setup.tls.starttls')}</option>
      </select>
    </label>
  );
}

export const grid2: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
};

export function Setup({
  t,
  settings,
  onSaved,
}: {
  t: T;
  settings: Settings | null;
  onSaved(s: Settings): void;
}) {
  const [f, setF] = useState({
    address: '',
    username: '',
    imapHost: '',
    imapPort: '993',
    imapTls: 'implicit' as Tls,
    smtpHost: '',
    smtpPort: '465',
    smtpTls: 'implicit' as Tls,
    password: '',
  });
  useEffect(() => {
    if (!settings?.configured) return;
    setF((x) => ({
      ...x,
      address: settings.address ?? '',
      username: settings.username === settings.address ? '' : (settings.username ?? ''),
      imapHost: settings.imapHost ?? '',
      imapPort: String(settings.imapPort ?? ''),
      imapTls: settings.imapTls ?? 'implicit',
      smtpHost: settings.smtpHost ?? '',
      smtpPort: String(settings.smtpPort ?? ''),
      smtpTls: settings.smtpTls ?? 'implicit',
    }));
  }, [settings]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const s = await call<Settings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          address: f.address,
          ...(f.username ? { username: f.username } : {}),
          imapHost: f.imapHost,
          imapPort: Number(f.imapPort),
          imapTls: f.imapTls,
          smtpHost: f.smtpHost,
          smtpPort: Number(f.smtpPort),
          smtpTls: f.smtpTls,
          ...(f.password ? { password: f.password } : {}),
        }),
      });
      setF({ ...f, password: '' });
      setMsg(t('setup.saved'));
      onSaved(s);
    } catch (err) {
      setMsg(errText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="setup" title={t('setup.title')} intro={t('setup.intro')} tile="inbox-imap">
      <ol style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 4 }}>
        <li>{t('setup.step1')}</li>
        <li>{t('setup.step2')}</li>
        <li>{t('setup.step3')}</li>
      </ol>
      <p style={{ margin: 0 }}>{t('setup.never')}</p>
      <form onSubmit={save} style={{ display: 'grid', gap: 12 }} data-testid="inbox-setup">
        <div style={grid2}>
          <Field
            label={t('setup.address')}
            value={f.address}
            onChange={set('address')}
            type="email"
            required
          />
          <Field
            label={t('setup.username')}
            hint={t('setup.usernameHint')}
            value={f.username}
            onChange={set('username')}
          />
        </div>
        <div style={grid2}>
          <Field label={t('setup.imapHost')} value={f.imapHost} onChange={set('imapHost')} required />
          <Field
            label={t('setup.imapPort')}
            value={f.imapPort}
            onChange={set('imapPort')}
            inputMode="numeric"
            required
          />
          <TlsSelect
            label={t('setup.imapTls')}
            value={f.imapTls}
            onChange={(v) => setF({ ...f, imapTls: v })}
            t={t}
          />
        </div>
        <div style={grid2}>
          <Field label={t('setup.smtpHost')} value={f.smtpHost} onChange={set('smtpHost')} required />
          <Field
            label={t('setup.smtpPort')}
            value={f.smtpPort}
            onChange={set('smtpPort')}
            inputMode="numeric"
            required
          />
          <TlsSelect
            label={t('setup.smtpTls')}
            value={f.smtpTls}
            onChange={(v) => setF({ ...f, smtpTls: v })}
            t={t}
          />
        </div>
        <Field
          label={t('setup.password')}
          hint={settings?.hasPassword ? t('setup.passwordKeep') : t('setup.passwordHint')}
          value={f.password}
          onChange={set('password')}
          type="password"
          autoComplete="new-password"
          required={!settings?.hasPassword}
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button type="submit" variant="primary" disabled={busy} style={{ minHeight: 44 }}>
            {t('setup.save')}
          </Button>
          {msg && (
            <span role="status" aria-live="polite">
              {msg}
            </span>
          )}
        </div>
      </form>
    </Section>
  );
}
