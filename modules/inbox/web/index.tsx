/**
 * Bot inbox (W35): the guided mailbox step (the owner made the mailbox at their own provider; PasaBot asks only for
 * the hosts, ports, address and app password, kept in the vault), the Inbox page (mail shown as plain text, never as
 * HTML, no remote images), and the email bridge pairing (this bot's key, the paired bots). Sends are approved on the
 * core approval card in the chat.
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { Badge, BrandTile, Button, Field } from '@pasabot/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ConnectPage, GuideCard, MailboxSection } from './guide.js';
import { call, errText, grid2, Section, type Settings, Setup, type T, useT } from './shared.js';

interface Mail {
  id: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  receivedAt: number;
  text: string;
  wasHtml: boolean;
  bridge: string | null;
  bridgePeer: string;
}
interface Bridge {
  address: string | null;
  publicKey: string;
  fingerprint: string;
  peers: { id: string; name: string; address: string; publicKey: string }[];
}

function bridgeLabel(t: T, m: Mail): ReactNode {
  if (!m.bridge) return null;
  if (m.bridge === 'verified')
    return <Badge tone="primary">{t('mail.bridgeVerified', { name: m.bridgePeer || '?' })}</Badge>;
  const reason = m.bridge.slice('refused:'.length);
  const k = `mail.refused.${reason}`;
  const r = t(k);
  return <Badge tone="outline">{t('mail.bridgeRefused', { reason: r === k ? reason : r })}</Badge>;
}

function Messages({ t, configured }: { t: T; configured: boolean }) {
  const [list, setList] = useState<Mail[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setList((await call<{ messages: Mail[] }>('/messages')).messages);
    } catch (e) {
      setMsg(errText(t, e));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  const check = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await call<{ fetched: number }>('/check', { method: 'POST' });
      setMsg(t('mail.fetched', { count: r.fetched }));
      await load();
    } catch (e) {
      setMsg(errText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="mail" title={t('mail.title')} intro={t('mail.intro')} tile="inbox">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button onClick={check} disabled={busy || !configured} style={{ minHeight: 44 }}>
          {t('mail.check')}
        </Button>
        {msg && (
          <span role="status" aria-live="polite">
            {msg}
          </span>
        )}
      </div>
      {list && list.length === 0 && <p style={{ margin: 0 }}>{t('mail.empty')}</p>}
      <ul
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}
        data-testid="inbox-list"
      >
        {(list ?? []).map((m) => (
          <li key={m.id}>
            <details style={{ minWidth: 0 }}>
              <summary
                style={{
                  cursor: 'pointer',
                  minHeight: 44,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                  overflowWrap: 'anywhere',
                }}
              >
                <strong>{m.subject || t('mail.noSubject')}</strong>
                <span>{m.fromName ? `${m.fromName} <${m.from}>` : m.from}</span>
                <time dateTime={new Date(m.receivedAt).toISOString()}>
                  {new Date(m.receivedAt).toLocaleString(displayLocale())}
                </time>
                {bridgeLabel(t, m)}
              </summary>
              {m.wasHtml && <p style={{ margin: '8px 0 0' }}>{t('mail.wasHtml')}</p>}
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  font: 'inherit',
                  margin: '8px 0 0',
                }}
              >
                {m.text}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Pairing({ t }: { t: T }) {
  const [b, setB] = useState<Bridge | null>(null);
  const [f, setF] = useState({ name: '', address: '', publicKey: '' });
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      setB(await call<Bridge>('/bridge'));
    } catch (e) {
      setMsg(errText(t, e));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      await call('/bridge/peers', { method: 'POST', body: JSON.stringify(f) });
      setF({ name: '', address: '', publicKey: '' });
      setMsg(t('bridge.added'));
      await load();
    } catch (err) {
      setMsg(errText(t, err));
    }
  };
  const remove = async (id: string) => {
    await call(`/bridge/peers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
  };
  return (
    <Section id="bridge" title={t('bridge.title')} intro={t('bridge.intro')} tile="bridge">
      {b && (
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <span>{t('bridge.yourAddress', { address: b.address ?? t('bridge.noAddress') })}</span>
          <span>{t('bridge.yourKey')}</span>
          <code data-testid="inbox-own-key" style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>
            {b.publicKey}
          </code>
        </div>
      )}
      {b && b.peers.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {b.peers.map((p) => (
            <li key={p.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <BrandTile id="bridge" size={28} fallback="inbox" />
              <strong>{p.name}</strong>
              <span style={{ overflowWrap: 'anywhere' }}>{p.address}</span>
              <Button variant="ghost" onClick={() => remove(p.id)} style={{ minHeight: 44 }}>
                {t('bridge.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: 'grid', gap: 12 }}>
        <div style={grid2}>
          <Field
            label={t('bridge.peerName')}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
          />
          <Field
            label={t('bridge.peerAddress')}
            value={f.address}
            onChange={(e) => setF({ ...f, address: e.target.value })}
            type="email"
            required
          />
        </div>
        <Field
          label={t('bridge.peerKey')}
          hint={t('bridge.peerKeyHint')}
          value={f.publicKey}
          onChange={(e) => setF({ ...f, publicKey: e.target.value })}
          required
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button type="submit" style={{ minHeight: 44 }}>
            {t('bridge.add')}
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

function InboxPage() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    call<Settings>('/settings')
      .then(setSettings)
      .catch(() => setSettings({ configured: false, hasPassword: false }));
  }, []);
  return (
    <section
      data-slot="route"
      data-testid="inbox-page"
      style={{
        display: 'grid',
        gap: 16,
        maxWidth: 860,
        paddingInline: 16,
        marginInline: 'auto',
        paddingBottom: 32,
        minWidth: 0,
      }}
    >
      <h1>{t('page.title')}</h1>
      <p style={{ margin: 0 }}>{t('page.intro')}</p>
      <Setup t={t} settings={settings} onSaved={setSettings} />
      <Messages t={t} configured={!!settings?.configured} />
      <Pairing t={t} />
    </section>
  );
}

const mod: WebModule = {
  id: 'inbox',
  routes: [
    { path: '/inbox', component: InboxPage, titleKey: 'inbox:page.title' },
    { path: '/inbox/connect', component: ConnectPage, titleKey: 'inbox:guide.pageTitle' },
  ],
  messageBlockRenderers: { 'inbox.guide': GuideCard },
  settingsSections: [
    {
      id: 'mailbox',
      labelKey: 'inbox:guide.settings.title',
      hintKey: 'inbox:guide.settings.hint',
      keywordsKey: 'inbox:guide.settings.keywords',
      icon: 'inbox',
      group: 'inbox',
      order: 10,
      component: MailboxSection,
    },
  ],
  navItems: [
    {
      id: 'inbox',
      labelKey: 'inbox:nav',
      hintKey: 'inbox:find.navHint',
      keywordsKey: 'inbox:find.navKeywords',
      to: '/inbox',
      icon: 'inbox',
      group: 'inbox',
      order: 640,
    },
  ],
};
export default mod;
