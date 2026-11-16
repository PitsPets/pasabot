/**
 * W28 web: Settings → Machines (link code + QR, enter a code, confirm requests with a re-auth, grants, unlink,
 * introductions) and the machine switcher page (linked machines → their agents → a proxied chat).
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { AgentAvatar, Badge, Button, Card, Field, Segmented } from '@pasabot/ui';
import QRCode from 'qrcode';
import { type FormEvent, useCallback, useEffect, useState } from 'react';

const translations = moduleTranslator(
  'link',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

/**
 * Loads again every few seconds while the window is shown, and at once when the route changes (Settings → Machines
 * and the machine switcher stay mounted across routes): the other owner confirms, unlinks or introduces on their
 * own machine and their own time. Cheap: local reads only. A failed refresh stays quiet; the next one tries again.
 */
function useRefresh(load: (quiet: boolean) => Promise<void>, ms = 5000) {
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const id = setInterval(again, ms);
    window.addEventListener('hashchange', again);
    return () => {
      clearInterval(id);
      window.removeEventListener('hashchange', again);
    };
  }, [load, ms]);
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as { message?: string };
  if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
  return j as T;
}
const reauth = (password: string) => call('/api/v1/auth/reauth', { body: { password } });

type Grant = 'view' | 'chat' | 'manage';
interface Peer {
  id: string;
  name: string;
  fingerprint: string;
  grant: Grant;
  state: 'requested' | 'awaiting' | 'active' | 'revoked';
}
interface Status {
  name: string;
  fingerprint: string | null;
  transport: string | null;
  /** only transports that run a helper process report it (tailcat) */
  transportStatus: { serving: boolean; restarting?: boolean } | null;
  available: { ok: true } | { ok: false; installHelp: string };
}
interface Intro {
  id: string;
  name: string;
  fingerprint: string;
  via: string | null;
}

const muted = { margin: 0, fontSize: 13, color: 'var(--bk-muted)' } as const;
const stack = { display: 'grid', gap: 12 } as const;
const row = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } as const;
const wrapText = { overflowWrap: 'anywhere', wordBreak: 'break-word' } as const;

function GrantPicker({ value, onChange }: { value: Grant; onChange(g: Grant): void }) {
  const t = useT();
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <Segmented
        label={t('grant.label')}
        value={value}
        options={(['view', 'chat', 'manage'] as const).map((g) => ({ value: g, label: t(`grant.${g}`) }))}
        onChange={onChange}
      />
      <p style={muted}>{t('grant.hint')}</p>
    </div>
  );
}

/** Settings → Machines */
export function MachinesSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [intros, setIntros] = useState<Intro[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: number; qr: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinGrant, setJoinGrant] = useState<Grant>('view');
  const [password, setPassword] = useState('');
  const [confirmGrant, setConfirmGrant] = useState<Record<string, Grant>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      try {
        const [s, p, i] = await Promise.all([
          call<Status>('/api/m/link/status'),
          call<{ peers: Peer[] }>('/api/m/link/peers'),
          call<{ intros: Intro[] }>('/api/m/link/intros'),
        ]);
        setStatus(s);
        setPeers(p.peers);
        setIntros(i.intros);
      } catch (e) {
        if (!quiet) setError(t('error', { message: (e as Error).message }));
      }
    },
    [t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRefresh(load);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(t('error', { message: (e as Error).message }));
      return false;
    }
  };

  const makeCode = () =>
    run(async () => {
      const r = await call<{ code: string; expiresAt: number }>('/api/m/link/codes', { body: {} });
      const qr = await QRCode.toDataURL(r.code, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      setCode({ ...r, qr });
      setCopied(false);
    });
  const join = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      await reauth(password);
      await call('/api/m/link/join', { body: { code: joinCode, grant: joinGrant } });
    });
    if (ok) {
      setJoinCode('');
      setPassword('');
      setNote(t('join.done'));
    }
  };
  const confirm = (p: Peer) =>
    run(async () => {
      await reauth(password);
      await call(`/api/m/link/peers/${encodeURIComponent(p.id)}/confirm`, {
        body: { grant: confirmGrant[p.id] ?? 'view' },
      });
      setPassword('');
    });
  const unlink = (p: Peer) => {
    if (typeof window !== 'undefined' && !window.confirm(t('peers.unlinkConfirm', { name: p.name }))) return;
    void run(() => call(`/api/m/link/peers/${encodeURIComponent(p.id)}`, { method: 'DELETE' }));
  };
  const needsPassword = peers.some((p) => p.state === 'requested');

  return (
    <div style={stack} data-testid="link-settings">
      {status && (
        <Card>
          <p style={{ margin: 0, fontWeight: 600, ...wrapText }}>{t('status.this', { name: status.name })}</p>
          {status.fingerprint && (
            <p style={{ ...muted, ...wrapText }}>{t('status.fingerprint', { fp: status.fingerprint })}</p>
          )}
          {status.transport && status.transportStatus && (
            <p style={{ ...muted, ...wrapText }} data-testid="link-transport">
              {t('status.transport', {
                transport: status.transport,
                state: t(
                  status.transportStatus.serving
                    ? 'status.transportRunning'
                    : status.transportStatus.restarting
                      ? 'status.transportDown'
                      : 'status.transportIdle',
                ),
              })}
            </p>
          )}
          {!status.available.ok && (
            <div role="status" data-testid="link-install-help">
              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>{t('status.unavailable')}</p>
              <p style={{ ...muted, ...wrapText }}>{status.available.installHelp}</p>
            </div>
          )}
        </Card>
      )}

      <Card>
        <h3 style={{ margin: 0, fontSize: 16 }}>{t('code.title')}</h3>
        <p style={muted}>{t('code.intro')}</p>
        <div style={row}>
          <Button variant="primary" onClick={() => void makeCode()} disabled={!status?.available.ok}>
            {t('code.make')}
          </Button>
        </div>
        {code && (
          <div style={{ ...stack, marginTop: 12 }} data-testid="link-code">
            <img
              src={code.qr}
              alt={t('code.qr')}
              width={200}
              height={200}
              style={{ maxWidth: '100%', height: 'auto' }}
            />
            <code style={{ fontSize: 13, ...wrapText }} data-testid="link-code-text">
              {code.code}
            </code>
            <p style={muted}>
              {t('code.expires', { time: new Date(code.expiresAt).toLocaleTimeString(displayLocale()) })}
            </p>
            <div style={row}>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(code.code).then(() => setCopied(true));
                }}
              >
                {copied ? t('code.copied') : t('code.copy')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <form onSubmit={(e) => void join(e)} style={stack}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('join.title')}</h3>
          <Field
            label={t('join.code')}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            autoComplete="off"
          />
          <GrantPicker value={joinGrant} onChange={setJoinGrant} />
          <Field
            label={t('reauth.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <div style={row}>
            <Button type="submit" variant="primary" disabled={!joinCode.trim() || !password}>
              {t('join.submit')}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <h3 style={{ margin: 0, fontSize: 16 }}>{t('peers.title')}</h3>
        {peers.length === 0 && <p style={muted}>{t('peers.empty')}</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          {peers.map((p) => (
            <li key={p.id} data-testid="link-peer" style={{ display: 'grid', gap: 8 }}>
              <div style={row}>
                <strong style={wrapText}>{p.name}</strong>
                <Badge tone={p.state === 'active' ? 'primary' : 'outline'}>{t(`state.${p.state}`)}</Badge>
                {p.state === 'active' && <Badge>{t(`grant.${p.grant}`)}</Badge>}
              </div>
              <p style={{ ...muted, ...wrapText }}>{t('peers.fp', { fp: p.fingerprint })}</p>
              {p.state === 'requested' && (
                <>
                  <GrantPicker
                    value={confirmGrant[p.id] ?? 'view'}
                    onChange={(g) => setConfirmGrant((m) => ({ ...m, [p.id]: g }))}
                  />
                  {needsPassword && (
                    <Field
                      label={t('reauth.password')}
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  )}
                </>
              )}
              <div style={row}>
                {p.state === 'requested' && (
                  <Button variant="primary" disabled={!password} onClick={() => void confirm(p)}>
                    {t('peers.confirm')}
                  </Button>
                )}
                {p.state === 'awaiting' && (
                  <Button
                    onClick={() =>
                      void run(() =>
                        call(`/api/m/link/peers/${encodeURIComponent(p.id)}/check`, { body: {} }),
                      )
                    }
                  >
                    {t('peers.check')}
                  </Button>
                )}
                <Button variant="danger" onClick={() => unlink(p)}>
                  {t('peers.unlink')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {intros.length > 0 && (
        <Card>
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('intros.title')}</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            {intros.map((i) => (
              <li key={i.id} data-testid="link-intro" style={{ display: 'grid', gap: 8 }}>
                <p style={{ margin: 0, ...wrapText }}>
                  {t('intros.offer', { via: i.via ?? '?', name: i.name, fp: i.fingerprint })}
                </p>
                <div style={row}>
                  {(['accepted', 'dismissed'] as const).map((d) => (
                    <Button
                      key={d}
                      onClick={() =>
                        void run(() =>
                          call(`/api/m/link/intros/${encodeURIComponent(i.id)}`, { body: { decision: d } }),
                        )
                      }
                    >
                      {t(d === 'accepted' ? 'intros.accept' : 'intros.dismiss')}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {note && (
        <p role="status" style={{ margin: 0 }}>
          {note}
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger, #b42318)', ...wrapText }}>
          {error}
        </p>
      )}
    </div>
  );
}

interface ProxyMsg {
  id: string;
  role: 'me' | 'agent' | 'error';
  body: string;
}
function ProxiedChat({ peer, agent }: { peer: Peer; agent: { id: string; name: string } }) {
  const t = useT();
  const [msgs, setMsgs] = useState<ProxyMsg[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [text, setText] = useState('');
  const base = `/api/m/link/peers/${encodeURIComponent(peer.id)}/chats/${encodeURIComponent(agent.id)}`;
  const load = useCallback(async () => {
    const r = await call<{ messages: ProxyMsg[]; waiting: boolean }>(base);
    setMsgs(r.messages);
    setWaiting(r.waiting);
  }, [base]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void load().catch(() => {}), 1000);
    return () => clearInterval(id);
  }, [waiting, load]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await call<{ messages: ProxyMsg[]; waiting: boolean }>(base, { body: { text } }).catch(
      () => null,
    );
    if (r) {
      setMsgs(r.messages);
      setWaiting(r.waiting);
      setText('');
    }
  };
  return (
    <Card data-testid="link-chat">
      <h3 style={{ margin: 0, fontSize: 16, ...wrapText }}>
        {t('chat.title', { agent: agent.name, machine: peer.name })}
      </h3>
      {msgs.length === 0 && <p style={muted}>{t('chat.empty', { machine: peer.name })}</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0', display: 'grid', gap: 8 }}>
        {msgs.map((m) => (
          <li key={m.id} data-testid={`link-msg-${m.role}`} style={{ ...wrapText, whiteSpace: 'pre-wrap' }}>
            <strong>{m.role === 'me' ? t('chat.me') : agent.name}: </strong>
            {m.body}
          </li>
        ))}
      </ul>
      {waiting && (
        <p role="status" style={muted}>
          {t('chat.waiting', { agent: agent.name })}
        </p>
      )}
      <form onSubmit={(e) => void send(e)} style={{ display: 'grid', gap: 8 }}>
        <Field
          label={t('chat.placeholder', { agent: agent.name })}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="link-composer"
        />
        <div style={row}>
          <Button type="submit" variant="primary" disabled={!text.trim() || waiting}>
            {t('chat.send')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The machine switcher: linked machines → their agents → a proxied chat. */
export function MachinesPage() {
  const t = useT();
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [current, setCurrent] = useState<Peer | null>(null);
  const [agents, setAgents] = useState<
    { id: string; name: string; slug: string; avatarSalt?: string }[] | null
  >(null);
  const [agent, setAgent] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (quiet = false) => {
      try {
        setPeers(
          (await call<{ peers: Peer[] }>('/api/m/link/peers')).peers.filter((p) => p.state === 'active'),
        );
      } catch (e) {
        if (!quiet) setError(t('error', { message: (e as Error).message }));
      }
    },
    [t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRefresh(load);
  const open = async (p: Peer) => {
    setCurrent(p);
    setAgent(null);
    setAgents(null);
    setError(null);
    try {
      setAgents(
        (
          await call<{ agents: { id: string; name: string; slug: string; avatarSalt?: string }[] }>(
            `/api/m/link/peers/${encodeURIComponent(p.id)}/agents`,
          )
        ).agents,
      );
    } catch (e) {
      setError(t('error', { message: (e as Error).message }));
    }
  };
  return (
    <section
      style={{
        ...stack,
        padding: 16,
        maxWidth: 760,
        margin: '0 auto',
        boxSizing: 'border-box',
        width: '100%',
      }}
      data-testid="link-page"
    >
      <h1 style={{ margin: 0, fontSize: 22 }}>{t('page.title')}</h1>
      <p style={muted}>{t('page.intro')}</p>
      {!current && (
        <>
          {peers && peers.length === 0 && <p style={muted}>{t('page.empty')}</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {(peers ?? []).map((p) => (
              <li key={p.id}>
                <Card data-testid="link-machine">
                  <div style={{ ...row, justifyContent: 'space-between' }}>
                    <div style={row}>
                      <strong style={wrapText}>{p.name}</strong>
                      <Badge tone="primary">{t('state.active')}</Badge>
                    </div>
                    <Button onClick={() => void open(p)}>{t('page.open')}</Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      {current && (
        <>
          <div style={row}>
            <Button variant="ghost" onClick={() => setCurrent(null)}>
              {t('page.back')}
            </Button>
          </div>
          <h2 style={{ margin: 0, fontSize: 18, ...wrapText }}>{t('page.agents', { name: current.name })}</h2>
          {agents && agents.length === 0 && <p style={muted}>{t('page.noAgents')}</p>}
          <div style={row}>
            {(agents ?? []).map((a) => (
              <Button
                key={a.id}
                variant={agent?.id === a.id ? 'primary' : 'secondary'}
                onClick={() => setAgent(a)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <AgentAvatar agentId={a.id} salt={a.avatarSalt} size={24} />
                {a.name}
              </Button>
            ))}
          </div>
          {agent && <ProxiedChat key={`${current.id}:${agent.id}`} peer={current} agent={agent} />}
        </>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, ...wrapText }}>
          {error}
        </p>
      )}
    </section>
  );
}

const mod: WebModule = {
  id: 'link',
  routes: [{ path: '/machines', component: MachinesPage, titleKey: 'link:page.title' }],
  navItems: [
    {
      id: 'machines',
      labelKey: 'link:nav',
      hintKey: 'link:find.navHint',
      keywordsKey: 'link:find.navKeywords',
      to: '/machines',
      icon: 'server',
      group: 'machines',
      order: 700,
    },
  ],
  settingsSections: [
    {
      id: 'machines',
      labelKey: 'link:settings',
      component: MachinesSettings,
      order: 600,
      icon: 'server',
      group: 'machines',
    },
  ],
};
export default mod;
