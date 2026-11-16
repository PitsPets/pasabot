/**
 * Browser (W15): the owner's profiles (name, colour, proxy, signed-in flag), the live view of a profile from its
 * screencast frames (`browser.frame` on LIVE_EVENT), in three places: the full page (`#/browser?profile=<id>`),
 * the agent details dock (`dockPanels`) and a floating picture-in-picture panel that stays open across screens.
 * The owner can steer the profile from the full view (address bar, click on the picture, type, keys); typing
 * marks the profile signed in, so agents then need a tier-3 approval to use it.
 */

import type { WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

import { Badge, Button, Card, Field, safeImageSrc } from '@pasabot/ui';
import { type FormEvent, type MouseEvent, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

interface Profile {
  id: string;
  name: string;
  color: string;
  proxy: { server: string; bypass?: string; username?: string; hasPassword: boolean } | null;
  loggedIn: boolean;
  running: boolean;
  url: string | null;
  createdAt: number;
}
interface Frame {
  profileId: string;
  data: string;
  width: number;
  height: number;
  url: string;
  at: number;
}

/** a profile's name; the default profile the server makes for the agents has none and is named here */
export const profileName = (p: Pick<Profile, 'name'>, t: (k: string) => string) =>
  p.name || t('profile.defaultName');

const LIVE = 'pasabot:event';
const API = '/api/m/browser';
// server-side rendering (the shell's slot test) has no document
const translations = moduleTranslator(
  'browser',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    ...(init.json !== undefined
      ? { body: JSON.stringify(init.json), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  if (r.status === 204) return null as T;
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!r.ok) throw Object.assign(new Error(j.message ?? j.error ?? `HTTP ${r.status}`), { status: r.status });
  return j;
}

function onLive(fn: (type: string, data: unknown) => void) {
  const h = (e: Event) => {
    const d = (e as CustomEvent<{ type: string; data: unknown }>).detail;
    if (d) fn(d.type, d.data);
  };
  window.addEventListener(LIVE, h);
  return () => window.removeEventListener(LIVE, h);
}

function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [denied, setDenied] = useState(false);
  const load = useCallback(async () => {
    try {
      setProfiles((await api<{ profiles: Profile[] }>('/profiles')).profiles);
    } catch (e) {
      if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 401)
        setDenied(true);
    }
  }, []);
  useEffect(() => {
    void load();
    return onLive((type) => {
      if (type === 'browser.profile') void load();
    });
  }, [load]);
  return { profiles, denied, load };
}

function useFrame(profileId: string | null, running: boolean) {
  const [frame, setFrame] = useState<Frame | null>(null);
  useEffect(() => {
    setFrame(null);
    if (!profileId || !running) return;
    let live = true;
    void api<{ frame: Frame } | null>(`/profiles/${profileId}/frame`)
      .then((j) => {
        if (live && j?.frame) setFrame((f) => (f && f.at > j.frame.at ? f : j.frame));
      })
      .catch(() => {});
    const off = onLive((type, data) => {
      const f = data as Frame;
      if (type === 'browser.frame' && f?.profileId === profileId) setFrame(f);
    });
    return () => {
      live = false;
      off();
    };
  }, [profileId, running]);
  return frame;
}

// ---------- live view ----------
function LiveView({
  profile,
  interactive = false,
  onError,
}: {
  profile: Profile;
  interactive?: boolean;
  onError?(m: string): void;
}) {
  const t = useT();
  const frame = useFrame(profile.id, profile.running);
  const src = frame ? safeImageSrc(`data:image/jpeg;base64,${frame.data}`) : undefined;
  const click = async (e: MouseEvent<HTMLImageElement>) => {
    if (!interactive) return;
    const r = e.currentTarget.getBoundingClientRect();
    try {
      await api(`/profiles/${profile.id}/input`, {
        method: 'POST',
        json: { kind: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height },
      });
    } catch (err) {
      onError?.((err as Error).message);
    }
  };
  return (
    <div
      data-testid="browser-live"
      data-profile={profile.id}
      style={{
        border: `3px solid ${profile.color}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: '#111',
        aspectRatio: '16 / 10',
        display: 'grid',
        placeItems: 'center',
        maxWidth: '100%',
      }}
    >
      {src ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard input has its own field and key buttons
        <img
          src={src}
          alt={t('live.alt', { name: profileName(profile, t) })}
          data-testid="browser-frame"
          onClick={(e) => void click(e)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            cursor: interactive ? 'pointer' : 'default',
          }}
        />
      ) : (
        <p style={{ color: '#ddd', padding: 16, textAlign: 'center' }}>
          {profile.running ? t('live.waiting') : t('live.stopped')}
        </p>
      )}
    </div>
  );
}

// ---------- picture in picture (its own root, so it stays open across screens) ----------
let pipRoot: Root | null = null;
let pipHost: HTMLDivElement | null = null;
function closePip() {
  pipRoot?.unmount();
  pipHost?.remove();
  pipRoot = null;
  pipHost = null;
}
function openPip(profileId: string) {
  if (!pipHost) {
    pipHost = document.createElement('div');
    pipHost.id = 'pasabot-browser-pip';
    document.body.appendChild(pipHost);
    pipRoot = createRoot(pipHost);
  }
  pipRoot!.render(<Pip profileId={profileId} />);
}
function Pip({ profileId }: { profileId: string }) {
  const t = useT();
  const { profiles } = useProfiles();
  const p = profiles?.find((x) => x.id === profileId);
  return (
    <aside
      aria-label={t('pip.label')}
      data-testid="browser-pip"
      style={{
        position: 'fixed',
        insetInlineEnd: 16,
        bottom: 16,
        width: 'min(360px, calc(100vw - 32px))',
        zIndex: 50,
        background: 'var(--bk-surface, #fff)',
        borderRadius: 14,
        boxShadow: '0 8px 30px rgba(0,0,0,.25)',
        padding: 8,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {p ? profileName(p, t) : t('pip.label')}
        </strong>
        <Button size="sm" variant="ghost" onClick={() => (location.hash = `#/browser?profile=${profileId}`)}>
          {t('actions.full')}
        </Button>
        <Button size="sm" variant="ghost" onClick={closePip}>
          {t('actions.closePip')}
        </Button>
      </div>
      {p ? <LiveView profile={p} /> : null}
    </aside>
  );
}

// ---------- full page ----------
const EMPTY_FORM = {
  name: '',
  color: '#3b82f6',
  server: '',
  bypass: '',
  username: '',
  password: '',
  loggedIn: false,
};
type Form = typeof EMPTY_FORM;

function ProfileForm({
  initial,
  editing,
  onSave,
  onCancel,
}: {
  initial: Form;
  editing: boolean;
  onSave(f: Form): Promise<void>;
  onCancel(): void;
}) {
  const t = useT();
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string; checked?: boolean } }) =>
    setF((o) => ({ ...o, [k]: k === 'loggedIn' ? !!e.target.checked : e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await onSave(f);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <form
        data-testid="browser-profile-form"
        onSubmit={(e: FormEvent) => void submit(e)}
        style={{ display: 'grid', gap: 12 }}
      >
        <h2>{editing ? t('form.editTitle') : t('form.newTitle')}</h2>
        <Field label={t('form.name')} value={f.name} onChange={set('name')} required maxLength={60} />
        <div className="bk-field">
          <label className="bk-field__label" htmlFor="browser-color">
            {t('form.color')}
          </label>
          <input
            id="browser-color"
            type="color"
            value={f.color}
            onChange={set('color')}
            style={{ width: 64, height: 44, border: 0, background: 'none' }}
          />
        </div>
        <Field
          label={t('form.proxy')}
          hint={t('form.proxyHint')}
          value={f.server}
          onChange={set('server')}
          placeholder="http://proxy.example:8080"
          inputMode="url"
        />
        {f.server && (
          <>
            <Field label={t('form.bypass')} value={f.bypass} onChange={set('bypass')} />
            <Field
              label={t('form.username')}
              value={f.username}
              onChange={set('username')}
              autoComplete="off"
            />
            <Field
              label={t('form.password')}
              hint={editing ? t('form.passwordKeep') : t('form.passwordVault')}
              type="password"
              value={f.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
          </>
        )}
        {editing && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
            <input
              type="checkbox"
              checked={f.loggedIn}
              onChange={set('loggedIn')}
              style={{ width: 20, height: 20 }}
            />
            <span>{t('form.loggedIn')}</span>
          </label>
        )}
        {err && (
          <p role="alert" className="bk-field__error">
            {err}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('form.save')}
          </Button>
          <Button onClick={onCancel}>{t('form.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * `loggedInAtOpen`: the profile's flag when the form opened. The flag is sent only when the owner changed it, so a
 * save cannot undo a sign-in mark the server set while the form was open.
 */
const toBody = (f: Form, loggedInAtOpen?: boolean) => ({
  name: f.name,
  color: f.color,
  proxy: f.server.trim()
    ? {
        server: f.server.trim(),
        ...(f.bypass.trim() ? { bypass: f.bypass.trim() } : {}),
        ...(f.username ? { username: f.username } : {}),
        ...(f.password ? { password: f.password } : {}),
      }
    : null,
  ...(loggedInAtOpen !== undefined && f.loggedIn !== loggedInAtOpen ? { loggedIn: f.loggedIn } : {}),
});

function Steer({ profile, onError }: { profile: Profile; onError(m: string): void }) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const go = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/profiles/${profile.id}/navigate`, { method: 'POST', json: { url } });
    } catch (x) {
      onError((x as Error).message);
    }
  };
  const input = async (json: unknown) => {
    try {
      await api(`/profiles/${profile.id}/input`, { method: 'POST', json });
    } catch (x) {
      onError((x as Error).message);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <form
        onSubmit={(e) => void go(e)}
        style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}
      >
        <Field
          label={t('steer.address')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
          inputMode="url"
          style={{ minWidth: 0 }}
          className="grow"
        />
        <Button type="submit">{t('steer.go')}</Button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text) void input({ kind: 'type', text }).then(() => setText(''));
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}
      >
        <Field
          label={t('steer.type')}
          hint={t('steer.typeHint')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          className="grow"
        />
        <Button type="submit">{t('steer.send')}</Button>
      </form>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['Enter', 'Tab', 'Backspace', 'Escape'] as const).map((k) => (
          <Button key={k} size="sm" onClick={() => void input({ kind: 'key', key: k })}>
            {t(`keys.${k}`)}
          </Button>
        ))}
        <Button size="sm" onClick={() => void input({ kind: 'scroll', dy: -400 })}>
          {t('keys.up')}
        </Button>
        <Button size="sm" onClick={() => void input({ kind: 'scroll', dy: 400 })}>
          {t('keys.down')}
        </Button>
      </div>
    </div>
  );
}

function selectedFromHash(): string | null {
  const q = location.hash.split('?')[1] ?? '';
  return new URLSearchParams(q).get('profile');
}

function NetworkSettings() {
  const t = useT();
  const [hosts, setHosts] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void api<{ allowHosts: string[] }>('/settings')
      .then((j) => setHosts(j.allowHosts.join(', ')))
      .catch(() => {});
  }, []);
  if (hosts === null) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const j = await api<{ allowHosts: string[] }>('/settings', {
        method: 'PUT',
        json: {
          allowHosts: hosts
            .split(/[\s,]+/)
            .map((h) => h.trim())
            .filter(Boolean),
        },
      });
      setHosts(j.allowHosts.join(', '));
      setMsg(t('network.saved'));
    } catch (x) {
      setMsg((x as Error).message);
    }
  };
  return (
    <Card>
      <form
        data-testid="browser-network"
        onSubmit={(e: FormEvent) => void save(e)}
        style={{ display: 'grid', gap: 12 }}
      >
        <h2>{t('network.title')}</h2>
        <Field
          label={t('network.allowHosts')}
          hint={t('network.hint')}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder="127.0.0.1, printer.lan"
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button type="submit">{t('network.save')}</Button>
          {msg && <span role="status">{msg}</span>}
        </div>
      </form>
    </Card>
  );
}

function BrowserPage() {
  const t = useT();
  const { profiles, denied, load } = useProfiles();
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  const [form, setForm] = useState<{ editing: Profile | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const h = () => setSelected(selectedFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr((x as Error).message);
    }
    await load();
  };
  const select = (id: string | null) => {
    history.replaceState(null, '', id ? `#/browser?profile=${id}` : '#/browser');
    setSelected(id);
  };
  const current = profiles?.find((p) => p.id === selected) ?? null;
  return (
    <section
      data-slot="route"
      data-testid="browser-page"
      style={{
        display: 'grid',
        gap: 16,
        maxWidth: 960,
        paddingInline: 16,
        marginInline: 'auto',
        minWidth: 0,
      }}
    >
      <h1>{t('page.title')}</h1>
      <p>{t('page.intro')}</p>
      {denied && <p role="alert">{t('page.ownerOnly')}</p>}
      {err && (
        <p role="alert" className="bk-field__error">
          {err}
        </p>
      )}
      {current && (
        <Card
          as="section"
          aria-label={t('live.title', { name: profileName(current, t) })}
          style={{ display: 'grid', gap: 12 }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ flex: 1, minWidth: 0 }}>{t('live.title', { name: profileName(current, t) })}</h2>
            <Button size="sm" onClick={() => openPip(current.id)}>
              {t('actions.pip')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => select(null)}>
              {t('actions.closeView')}
            </Button>
          </div>
          {current.url && (
            <p className="muted small" style={{ overflowWrap: 'anywhere' }} data-testid="browser-url">
              {current.url}
            </p>
          )}
          <LiveView profile={current} interactive onError={setErr} />
          {current.running ? (
            <Steer profile={current} onError={setErr} />
          ) : (
            <Button
              variant="primary"
              onClick={() => void act(() => api(`/profiles/${current.id}/start`, { method: 'POST' }))}
            >
              {t('actions.start')}
            </Button>
          )}
        </Card>
      )}
      {form ? (
        <ProfileForm
          editing={!!form.editing}
          initial={
            form.editing
              ? {
                  name: form.editing.name,
                  color: form.editing.color,
                  server: form.editing.proxy?.server ?? '',
                  bypass: form.editing.proxy?.bypass ?? '',
                  username: form.editing.proxy?.username ?? '',
                  password: '',
                  loggedIn: form.editing.loggedIn,
                }
              : EMPTY_FORM
          }
          onCancel={() => setForm(null)}
          onSave={async (f) => {
            if (form.editing)
              await api(`/profiles/${form.editing.id}`, {
                method: 'PATCH',
                json: toBody(f, form.editing.loggedIn),
              });
            else await api('/profiles', { method: 'POST', json: toBody(f) });
            setForm(null);
            await load();
          }}
        />
      ) : (
        !denied && (
          <div>
            <Button variant="primary" onClick={() => setForm({ editing: null })}>
              {t('actions.new')}
            </Button>
          </div>
        )
      )}
      {profiles?.length === 0 && <p>{t('page.empty')}</p>}
      {profiles?.map((p) => (
        <Card as="article" key={p.id} data-testid="browser-profile" style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              aria-hidden
              style={{ width: 16, height: 16, borderRadius: 999, background: p.color, flex: 'none' }}
            />
            <h3 style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{profileName(p, t)}</h3>
            {p.running && <Badge tone="signal">{t('badge.running')}</Badge>}
            {p.loggedIn && <Badge tone="primary">{t('badge.loggedIn')}</Badge>}
            {p.proxy && <Badge tone="outline">{t('badge.proxy')}</Badge>}
          </div>
          {p.proxy && (
            <p className="muted small" style={{ overflowWrap: 'anywhere' }}>
              {t('profile.via', { server: p.proxy.server })}
            </p>
          )}
          {p.loggedIn && <p className="muted small">{t('profile.loggedInNote')}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => select(p.id)}>{t('actions.watch')}</Button>
            {p.running ? (
              <Button onClick={() => void act(() => api(`/profiles/${p.id}/stop`, { method: 'POST' }))}>
                {t('actions.stop')}
              </Button>
            ) : (
              <Button onClick={() => void act(() => api(`/profiles/${p.id}/start`, { method: 'POST' }))}>
                {t('actions.start')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setForm({ editing: p })}>
              {t('actions.edit')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(t('actions.deleteConfirm', { name: profileName(p, t) })))
                  void act(() => api(`/profiles/${p.id}`, { method: 'DELETE' }));
              }}
            >
              {t('actions.delete')}
            </Button>
          </div>
        </Card>
      ))}
      {!denied && <NetworkSettings />}
    </section>
  );
}

// ---------- dock panel (agent details) ----------
function BrowserDock() {
  const t = useT();
  const { profiles, denied } = useProfiles();
  const [lastFramed, setLastFramed] = useState<string | null>(null);
  useEffect(
    () =>
      onLive((type, data) => {
        if (type === 'browser.frame') setLastFramed((data as Frame).profileId);
      }),
    [],
  );
  if (denied || !profiles) return null;
  const running = profiles.filter((p) => p.running);
  const p = running.find((x) => x.id === lastFramed) ?? running[0];
  if (!p) return <p className="muted small">{t('dock.idle')}</p>;
  return (
    <div data-testid="browser-dock" style={{ display: 'grid', gap: 8 }}>
      <p className="small" style={{ overflowWrap: 'anywhere' }}>
        {profileName(p, t)}
        {p.url ? ` · ${p.url}` : ''}
      </p>
      <LiveView profile={p} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" onClick={() => (location.hash = `#/browser?profile=${p.id}`)}>
          {t('actions.full')}
        </Button>
        <Button size="sm" onClick={() => openPip(p.id)}>
          {t('actions.pip')}
        </Button>
      </div>
    </div>
  );
}

const mod: WebModule = {
  id: 'browser',
  routes: [{ path: '/browser', component: BrowserPage, titleKey: 'browser:page.title' }],
  navItems: [
    {
      id: 'browser',
      labelKey: 'browser:nav',
      hintKey: 'browser:find.navHint',
      keywordsKey: 'browser:find.navKeywords',
      to: '/browser',
      icon: 'window',
      group: 'tools',
      order: 320,
    },
  ],
  dockPanels: [{ id: 'browser', labelKey: 'browser:dock.label', component: BrowserDock }],
};
export default mod;
