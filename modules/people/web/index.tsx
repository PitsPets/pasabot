/**
 * People (W23): the owner invites members and guests, manages who is in which chat and which agents members may use;
 * a member opens chats with those agents; the invite accept page (`#/join?invite=`) works signed out.
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, Button, Card, Field, Segmented, Sheet } from '@pasabot/ui';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';

type T = (k: string, o?: Record<string, unknown>) => string;
const translations = moduleTranslator(
  'people',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT(): T {
  return useModuleT(translations).t;
}

class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function call<R>(path: string, init: RequestInit = {}): Promise<R> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new CallError(r.status, j?.error ?? 'error');
  return j as R;
}
const API = '/api/m/people';

type Kind = 'owner' | 'member' | 'guest';
interface Me {
  id: string;
  kind: Kind;
  displayName: string;
}
let mePromise: Promise<Me | null> | null = null;
const loadMe = () =>
  (mePromise ??= call<{ user: Me }>('/api/v1/me')
    .then((r) => r.user)
    .catch(() => {
      mePromise = null;
      return null;
    }));
function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    void loadMe().then(setMe);
  }, []);
  return me;
}

interface Person {
  id: string;
  kind: Kind;
  displayName: string;
  createdAt: number;
  disabledAt: number | null;
}
interface Invite {
  id: string;
  kind: 'member' | 'guest';
  chats: { chatId: string; role: 'member' | 'observer'; title: string }[];
  note: string;
  expiresAt: number;
}
interface ChatRow {
  id: string;
  title: string;
  kind: string;
}
interface AgentRow {
  id: string;
  name: string;
  shared: boolean;
}

const page = {
  display: 'grid',
  gap: 16,
  maxWidth: 860,
  paddingInline: 16,
  marginInline: 'auto',
  paddingBottom: 32,
} as const;
const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const list = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 } as const;
const item = {
  ...row,
  justifyContent: 'space-between',
  borderTop: '1px solid var(--bk-line, rgba(127,127,127,.25))',
  paddingTop: 8,
} as const;
const tap = { minHeight: 44 } as const;

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <Card
      as="section"
      aria-labelledby={`people-${id}`}
      data-testid={`people-${id}`}
      style={{ display: 'grid', gap: 12 }}
    >
      <h2 id={`people-${id}`} style={{ margin: 0, fontSize: 18 }}>
        {title}
      </h2>
      {intro && <p style={{ margin: 0 }}>{intro}</p>}
      {children}
    </Card>
  );
}
const kindLabel = (t: T, k: Kind) => t(`kind.${k}`);
const inviteLink = (path: string) => `${window.location.origin}${path}`;

// ---------- the owner's invite form (also used from a chat's People sheet) ----------
function InviteForm({
  t,
  chats,
  fixedChat,
  onMade,
}: {
  t: T;
  chats: ChatRow[];
  fixedChat?: string;
  onMade(): void;
}) {
  const [kind, setKind] = useState<'guest' | 'member'>('guest');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(fixedChat ? [fixedChat] : []));
  const [role, setRole] = useState<'member' | 'observer'>('member');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setError(null);
    setCopied(false);
    if (kind === 'guest' && picked.size === 0) return setError(t('invite.pickChat'));
    try {
      const r = await call<{ path: string }>(`${API}/invites`, {
        method: 'POST',
        body: JSON.stringify({ kind, chats: [...picked].map((chatId) => ({ chatId, role })) }),
      });
      setLink(inviteLink(r.path));
      onMade();
    } catch {
      setError(t('errors.generic'));
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 12 }} data-testid="people-invite-form">
      <Segmented
        label={t('invite.kind')}
        value={kind}
        options={[
          { value: 'guest', label: t('kind.guest') },
          { value: 'member', label: t('kind.member') },
        ]}
        onChange={(v) => setKind(v as 'guest' | 'member')}
      />
      <p style={{ margin: 0 }}>{kind === 'guest' ? t('invite.guestHint') : t('invite.memberHint')}</p>
      {!fixedChat && (
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}>
          <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('invite.chats')}</legend>
          {chats.length === 0 && <p style={{ margin: 0 }}>{t('invite.noChats')}</p>}
          {chats.map((c) => (
            <label key={c.id} style={{ ...row, ...tap }}>
              <input
                type="checkbox"
                style={{ width: 22, height: 22 }}
                checked={picked.has(c.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.currentTarget.checked) next.add(c.id);
                  else next.delete(c.id);
                  setPicked(next);
                }}
              />
              <span style={{ overflowWrap: 'anywhere' }}>{c.title}</span>
            </label>
          ))}
        </fieldset>
      )}
      <Segmented
        label={t('invite.role')}
        value={role}
        options={[
          { value: 'member', label: t('role.member') },
          { value: 'observer', label: t('role.observer') },
        ]}
        onChange={(v) => setRole(v as 'member' | 'observer')}
      />
      <div style={row}>
        <Button variant="primary" onClick={() => void make()} style={tap}>
          {t('invite.create')}
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {link && (
        <div style={{ display: 'grid', gap: 8 }}>
          <Field label={t('invite.link')} value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
          <p style={{ margin: 0 }}>{t('invite.linkHint')}</p>
          <div style={row}>
            <Button onClick={() => void copy()} style={tap}>
              {copied ? t('invite.copied') : t('invite.copy')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- People page ----------
function OwnerPeople({ t }: { t: T }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const load = useCallback(async () => {
    const [p, i, c, a] = await Promise.all([
      call<{ people: Person[] }>(`${API}/people`),
      call<{ invites: Invite[] }>(`${API}/invites`),
      call<{ chats: ChatRow[] }>('/api/v1/chats'),
      call<{ agents: AgentRow[] }>(`${API}/agents`),
    ]);
    setPeople(p.people);
    setInvites(i.invites);
    setChats(c.chats);
    setAgents(a.agents);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <Section id="invite" title={t('invite.title')} intro={t('invite.intro')}>
        <InviteForm t={t} chats={chats} onMade={() => void load()} />
      </Section>
      {invites.length > 0 && (
        <Section id="invites" title={t('invites.title')}>
          <ul style={list}>
            {invites.map((i) => (
              <li key={i.id} style={item}>
                <span style={{ overflowWrap: 'anywhere' }}>
                  <Badge>{kindLabel(t, i.kind)}</Badge>{' '}
                  {i.chats.length ? i.chats.map((c) => c.title).join(', ') : t('invites.noChats')}
                  {' · '}
                  {t('invites.expires', { when: new Date(i.expiresAt).toLocaleString(displayLocale()) })}
                </span>
                <Button
                  variant="ghost"
                  style={tap}
                  onClick={() => void call(`${API}/invites/${i.id}`, { method: 'DELETE' }).then(load)}
                >
                  {t('invites.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section id="list" title={t('list.title')}>
        <ul style={list}>
          {people.map((p) => (
            <li key={p.id} style={item} data-testid="people-person">
              <span style={{ overflowWrap: 'anywhere' }}>
                <strong>{p.displayName}</strong> <Badge>{kindLabel(t, p.kind)}</Badge>{' '}
                {p.disabledAt && <Badge>{t('list.disabled')}</Badge>}
              </span>
              {p.kind !== 'owner' && (
                <Button
                  variant={p.disabledAt ? 'secondary' : 'danger'}
                  style={tap}
                  onClick={() =>
                    void call(`${API}/people/${p.id}/${p.disabledAt ? 'enable' : 'disable'}`, {
                      method: 'POST',
                    }).then(load)
                  }
                >
                  {p.disabledAt ? t('list.enable') : t('list.disable')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section id="agents" title={t('agents.title')} intro={t('agents.intro')}>
        {agents.length === 0 && <p style={{ margin: 0 }}>{t('agents.none')}</p>}
        <ul style={list}>
          {agents.map((a) => (
            <li key={a.id} style={item}>
              <label style={{ ...row, ...tap, flex: 1 }}>
                <input
                  type="checkbox"
                  style={{ width: 22, height: 22 }}
                  checked={a.shared}
                  onChange={(e) =>
                    void call(`${API}/agents/${a.id}/share`, {
                      method: 'PUT',
                      body: JSON.stringify({ shared: e.currentTarget.checked }),
                    }).then(load)
                  }
                />
                <span style={{ overflowWrap: 'anywhere' }}>{t('agents.share', { name: a.name })}</span>
              </label>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function MemberAgents({ t }: { t: T }) {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  useEffect(() => {
    void call<{ agents: AgentRow[] }>(`${API}/agents`).then((r) => setAgents(r.agents));
  }, []);
  const open = async (id: string) => {
    const r = await call<{ chatId: string }>(`${API}/agents/${id}/open`, { method: 'POST' });
    window.location.hash = `#/chats/${r.chatId}`;
  };
  return (
    <Section id="member-agents" title={t('member.title')} intro={t('member.intro')}>
      {agents?.length === 0 && <p style={{ margin: 0 }}>{t('member.none')}</p>}
      <ul style={list}>
        {(agents ?? []).map((a) => (
          <li key={a.id} style={item}>
            <strong style={{ overflowWrap: 'anywhere' }}>{a.name}</strong>
            <Button variant="primary" style={tap} onClick={() => void open(a.id)}>
              {t('member.open', { name: a.name })}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PeoplePage() {
  const t = useT();
  const me = useMe();
  return (
    <section style={page} data-testid="people-page">
      <h1>{t('page.title')}</h1>
      <p style={{ margin: 0 }}>{me?.kind === 'owner' ? t('page.introOwner') : t('page.introOther')}</p>
      {me?.kind === 'owner' && <OwnerPeople t={t} />}
      {me?.kind === 'member' && <MemberAgents t={t} />}
      {me?.kind === 'guest' && (
        <Section id="guest" title={t('guest.title')}>
          <p style={{ margin: 0 }}>{t('guest.body')}</p>
        </Section>
      )}
    </section>
  );
}

// ---------- chat header: who is in this chat ----------
function ChatPeople({ chatId }: { chatId: string }) {
  const t = useT();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<{ userId: string; kind: Kind; displayName: string; role: string }[]>(
    [],
  );
  const [all, setAll] = useState<Person[]>([]);
  const [inviting, setInviting] = useState(false);
  const owner = me?.kind === 'owner';
  const load = useCallback(async () => {
    const r = await call<{ people: typeof people }>(`${API}/chats/${chatId}/people`);
    setPeople(r.people);
    if (owner) setAll((await call<{ people: Person[] }>(`${API}/people`)).people);
  }, [chatId, owner]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  if (!me) return null;
  const others = all.filter(
    (p) => p.kind !== 'owner' && !p.disabledAt && !people.some((x) => x.userId === p.id),
  );
  const setRole = (userId: string, role: 'member' | 'observer' | null) =>
    void call(`${API}/chats/${chatId}/people/${userId}`, {
      method: role ? 'PUT' : 'DELETE',
      ...(role ? { body: JSON.stringify({ role }) } : {}),
    }).then(load);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        style={tap}
        onClick={() => setOpen(true)}
        data-testid="people-chat-button"
      >
        {t('chat.button')}
      </Button>
      <Sheet open={open} title={t('chat.title')} onClose={() => setOpen(false)}>
        <ul style={list} data-testid="people-chat-list">
          {people.map((p) => (
            <li key={p.userId} style={item}>
              <span style={{ overflowWrap: 'anywhere' }}>
                <strong>{p.displayName}</strong> <Badge>{kindLabel(t, p.kind)}</Badge>{' '}
                {p.role === 'observer' && <Badge>{t('role.observer')}</Badge>}
              </span>
              {owner && p.kind !== 'owner' && (
                <span style={row}>
                  <Button
                    variant="ghost"
                    style={tap}
                    onClick={() => setRole(p.userId, p.role === 'observer' ? 'member' : 'observer')}
                  >
                    {p.role === 'observer' ? t('chat.letWrite') : t('chat.readOnly')}
                  </Button>
                  <Button variant="danger" style={tap} onClick={() => setRole(p.userId, null)}>
                    {t('chat.remove', { name: p.displayName })}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {owner && others.length > 0 && (
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{t('chat.add')}</h3>
            {others.map((p) => (
              <div key={p.id} style={item}>
                <span style={{ overflowWrap: 'anywhere' }}>{p.displayName}</span>
                <Button style={tap} onClick={() => setRole(p.id, 'member')}>
                  {t('chat.addPerson', { name: p.displayName })}
                </Button>
              </div>
            ))}
          </div>
        )}
        {owner && (
          <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            {inviting ? (
              <InviteForm t={t} chats={[]} fixedChat={chatId} onMade={() => {}} />
            ) : (
              <Button style={tap} onClick={() => setInviting(true)}>
                {t('chat.invite')}
              </Button>
            )}
          </div>
        )}
        <div style={{ ...row, marginTop: 12 }}>
          <Button variant="primary" style={tap} onClick={() => setOpen(false)}>
            {t('chat.close')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

// ---------- the invite accept page (signed out) ----------
function JoinPage() {
  const t = useT();
  const token = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('invite') ?? '';
  const [info, setInfo] = useState<{ kind: Kind; invitedBy: string; chats: { title: string }[] } | null>(
    null,
  );
  const [state, setState] = useState<'loading' | 'ok' | 'invalid'>('loading');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return setState('invalid');
    void call<typeof info>('/hooks/people/invite', { method: 'POST', body: JSON.stringify({ token }) })
      .then((r) => {
        setInfo(r);
        setState('ok');
      })
      .catch(() => setState('invalid'));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) return setError(t('join.short'));
    if (pw !== pw2) return setError(t('join.mismatch'));
    setBusy(true);
    try {
      const r = await call<{ user: { id: string; displayName: string } }>('/hooks/people/accept', {
        method: 'POST',
        body: JSON.stringify({ token, displayName: name, password: pw }),
      });
      try {
        localStorage.setItem('pasabot.account', JSON.stringify({ id: r.user.id, name: r.user.displayName }));
      } catch {}
      window.location.replace('/#/');
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof CallError && err.code === 'invalid_name'
          ? t('join.badName')
          : err instanceof CallError && err.code === 'invite_invalid'
            ? t('join.invalid')
            : t('errors.generic'),
      );
      setBusy(false);
    }
  };
  return (
    <main className="auth-page" data-testid="people-join">
      <div className="auth-card stack">
        <h1>{t('join.title')}</h1>
        {state === 'loading' && <p>{t('join.loading')}</p>}
        {state === 'invalid' && <p role="alert">{t('join.invalid')}</p>}
        {state === 'ok' && info && (
          <>
            <p>
              {t(info.kind === 'guest' ? 'join.introGuest' : 'join.introMember', {
                name: info.invitedBy,
                chats: info.chats.map((c) => c.title).join(', '),
              })}
            </p>
            <form className="stack" onSubmit={(e) => void submit(e)}>
              <Field
                label={t('join.name')}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                maxLength={80}
                autoComplete="name"
                required
              />
              <Field
                label={t('join.password')}
                type="password"
                value={pw}
                onChange={(e) => setPw(e.currentTarget.value)}
                autoComplete="new-password"
                required
              />
              <Field
                label={t('join.again')}
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.currentTarget.value)}
                autoComplete="new-password"
                required
                error={error}
              />
              <Button type="submit" variant="primary" block disabled={busy}>
                {t('join.submit')}
              </Button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

const mod: WebModule = {
  id: 'people',
  routes: [
    {
      path: '/people',
      component: PeoplePage,
      titleKey: 'people:page.title',
      roles: ['owner', 'member', 'guest'],
    },
    { path: '/join', component: JoinPage, titleKey: 'people:join.title', public: true },
  ],
  navItems: [
    {
      id: 'people',
      labelKey: 'people:nav',
      hintKey: 'people:find.navHint',
      keywordsKey: 'people:find.navKeywords',
      to: '/people',
      icon: 'users',
      group: 'people',
      order: 650,
      roles: ['owner', 'member', 'guest'],
    },
  ],
  chatHeaderWidgets: [{ id: 'people', component: ChatPeople, icon: 'users', labelKey: 'people:chat.title' }],
};
export default mod;
