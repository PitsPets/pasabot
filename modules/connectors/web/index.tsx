/**
 * W13 web: the Connectors page (`/connectors`): the catalogue, installing one (secret fields are write-only; an
 * OAuth connector takes the owner's own client id and shows the sign-in return address to register), signing in,
 * and removing an install. MCP-kind installs then appear on the MCP servers page, where the owner picks who may
 * use them. W18: each card shows one plain state (Added, Ready to add, Needs sign-in or key, Not on this computer),
 * "Ready to add" with nothing to type is one tap, and tool servers already set up in other apps are offered by
 * name ("Found on this computer"); their keys go to the vault on the server and never reach this page. A found server
 * is one tap (a confirmation only when it has keys to copy) and is added switched off; a card whose launcher is not
 * on this computer offers "Get it" first. With the "Technical words" switch off the page says no MCP, tool server or
 * key names.
 */

import type { BlockRenderer, WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

import {
  Badge,
  BrandTile,
  Button,
  brainTone,
  Card,
  Field,
  HelperCard,
  resolveMark,
  safeHref,
} from '@pasabot/ui';
import { type CSSProperties, useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const translations = moduleTranslator(
  'connectors',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

/**
 * The person's "Technical words" switch: the shell mirrors it on `<html data-advanced>` and fires `pasabot:advanced`
 * (a module cannot import the shell). Off: no MCP, tool server, command or key names.
 */
function useTechnical(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
    () => false,
  );
}

/**
 * A found server's tile: its own mark from its name (github, git, time...), else the tool-server glyph. Never the
 * app it was found in, and never a brain's mark (a server is not Claude or Codex).
 */
export function foundTile(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const r = resolveMark(id || 'mcp');
  return r.kind !== 'line' && !brainTone(r.id) && !brainTone(id) ? r.id : 'mcp';
}

/** product names stay as they are in every language */
const APP_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  'claude-desktop': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

const CALLBACK_PATH = '/hooks/connectors/oauth/callback';
interface CatalogItem {
  slug: string;
  name: string;
  version: string;
  category: string;
  summary: string;
  homepage: string | null;
  /** W36: the catalogue section and the Popular row */
  group?: string;
  popular?: boolean;
  kind: 'mcp-stdio' | 'mcp-http' | 'oauth-api';
  auth: {
    type: 'none' | 'api_key' | 'oauth2_pkce';
    fields: { key: string; label: string; secret: boolean }[];
    /** W36: 'own' = the app's own sign-in page (nothing to type); 'owner' = the owner's OAuth client */
    signIn?: 'own' | 'owner' | null;
    /** W36: the app's own page where the owner gets a code */
    keyPage?: string | null;
  };
  installed: number;
  /** W18: the one plain state of this card */
  state: 'added' | 'ready' | 'needs_key' | 'missing';
  /** what is not on this computer yet, with its official site */
  missing: { name: string; site: string | null } | null;
}
interface FoundItem {
  app: string;
  name: string;
  transport: 'stdio' | 'http';
  keys: string[];
  blocked: 'key-in-command' | 'unsupported' | null;
  /** what the import must name, so what is added is what was listed */
  fp: string;
  added: boolean;
}
interface Install {
  id: string;
  slug: string;
  name: string;
  kind: CatalogItem['kind'] | null;
  status: 'ready' | 'needs_auth' | 'error';
  values: Record<string, string>;
  clientId: string | null;
  /** W36: signs in (its own pages or the owner's client) */
  signIn?: boolean;
  secretKeys: string[];
  oauth: { connectedAt: number; expiresAt: number | null } | null;
  /** the app a found tool server came from, or null for a catalogue connector */
  found: string | null;
  /** added, but what it runs with is not on this computer (yet) */
  missing?: { name: string; site: string | null } | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/m/connectors${path}`, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
    throw Object.assign(new Error(j.message ?? `HTTP ${r.status}`), { code: j.error });
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}

/**
 * Why a sign-in could not start, in a plain line: "try again later" only when the app could not be reached; an app
 * that refused a plain-http return address (a phone on the LAN) says where to open PasaBot instead.
 */
function signInFailedLine(t: ReturnType<typeof useT>, e: unknown, name: string) {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'signin_insecure') return t('signin.insecure', { name });
  if (code === 'signin_refused' || code === 'signin_no_sign_in') return t('signin.refused', { name });
  return t('signin.failed', { name });
}

/** W36: the catalogue's sections, in the order the page shows them */
const GROUPS = ['files-notes', 'calendar-email', 'work-tasks', 'shop-money', 'social-chat', 'other'];
/** cards side by side where there is room, one per row on a phone */
const grid: CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
  alignItems: 'start',
};
const muted: CSSProperties = { margin: 0, color: 'var(--bk-muted)', fontSize: 14 };
const wrap: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };
const errorStyle: CSSProperties = { margin: 0, color: 'var(--bk-danger)' };
/** links keep a 44 px tap height on a phone */
const tapLink: CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 44, ...wrap };

function InstallForm({ item, onDone, onCancel }: { item: CatalogItem; onDone(): void; onCancel(): void }) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const oauth = item.auth.type === 'oauth2_pkce';
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/installs', {
        slug: item.slug,
        values,
        ...(oauth ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : {}),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="connector-install-form" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {item.auth.fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          type={f.secret ? 'password' : 'text'}
          autoComplete="off"
          hint={f.secret ? t('install.secretHint') : undefined}
          value={values[f.key] ?? ''}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        />
      ))}
      {oauth && (
        <>
          <p style={muted}>{t('install.oauthHint')}</p>
          <p style={{ ...muted, ...wrap }}>
            {t('install.redirect')}{' '}
            <code data-testid="connector-redirect">{`${location.origin}${CALLBACK_PATH}`}</code>
          </p>
          <Field
            label={t('install.clientId')}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <Field
            label={t('install.clientSecret')}
            hint={t('install.clientSecretHint')}
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </>
      )}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {t('install.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('install.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** the link to the page where the owner turns a tool server on and picks who may use it */
function UseLink() {
  const t = useT();
  const tech = useTechnical();
  return (
    <a href="#/mcp" style={tapLink}>
      {t(tech ? 'installed.mcpLink' : 'installed.appsLink')}
    </a>
  );
}

function InstallRow({ i, reload }: { i: Install; reload(): void }) {
  const t = useT();
  const tech = useTechnical();
  const site = i.missing?.site ? safeHref(i.missing.site) : undefined;
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = async () => {
    setError(null);
    try {
      const r = await call<{ authorizeUrl: string }>(
        'POST',
        `/installs/${encodeURIComponent(i.id)}/oauth/start`,
      );
      const href = safeHref(r.authorizeUrl);
      if (href) window.location.assign(href);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code?.startsWith('signin_') ? signInFailedLine(t, e, i.name) : (e as Error).message);
    }
  };
  const remove = async () => {
    try {
      await call('DELETE', `/installs/${encodeURIComponent(i.id)}`);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card
      as="article"
      data-connector-install={i.slug}
      style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <BrandTile id={i.found ? foundTile(i.name) : i.slug} size={32} fallback="plug" />
        <h3 style={{ margin: 0, fontSize: 17, ...wrap }}>{i.name}</h3>
        {i.missing ? (
          <Badge tone="outline" data-install-status="missing">
            {t('state.missing')}
          </Badge>
        ) : (
          <Badge tone={i.status === 'ready' ? 'primary' : 'outline'} data-install-status={i.status}>
            {t(`status.${i.status}`)}
          </Badge>
        )}
      </div>
      {i.missing && (
        <p style={{ ...muted, ...wrap }} data-testid="connector-missing">
          {t('missing.line', { name: i.missing.name })}{' '}
          {site && (
            <a href={site} target="_blank" rel="noreferrer noopener" style={tapLink}>
              {t('missing.get', { name: i.missing.name })}
            </a>
          )}
        </p>
      )}
      {tech &&
        Object.entries(i.values).map(([k, v]) => (
          <p key={k} style={{ ...muted, ...wrap }}>
            {k}: {v}
          </p>
        ))}
      {tech && i.secretKeys.length > 0 && (
        <p style={{ ...muted, ...wrap }}>{t('installed.secrets', { names: i.secretKeys.join(', ') })}</p>
      )}
      {!i.found && i.kind !== 'oauth-api' && i.status === 'ready' && <HelpersPicker installId={i.id} />}
      {i.kind !== 'oauth-api' && i.status === 'ready' && (
        <p style={muted} data-testid="installed-use-hint">
          {t(i.found ? 'installed.foundHint' : 'installed.mcpHint')} <UseLink />
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {(i.signIn || i.clientId !== null) && (
          <Button variant={i.status === 'ready' ? 'secondary' : 'primary'} onClick={() => void signIn()}>
            {t(i.status === 'ready' ? 'installed.signInAgain' : 'installed.signIn')}
          </Button>
        )}
        {confirm ? (
          <Button variant="danger" onClick={() => void remove()}>
            {t('installed.removeConfirm')}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            {t('installed.remove')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </Card>
  );
}

/** a plain line instead of the catalogue's own summary (owner-added catalogue files keep their summary) */
function useDescribe() {
  const t = useT();
  return (c: CatalogItem) => (t.has(`describe.${c.slug}`) ? t(`describe.${c.slug}`) : c.summary);
}

/** W36: what the card's one button says, by state (Add / Sign in / Needs a code; Added shows under Connected) */
function actionOf(c: CatalogItem): 'add' | 'signIn' | 'code' {
  if (c.auth.type === 'oauth2_pkce') return 'signIn';
  if (c.auth.fields.some((f) => f.secret)) return 'code';
  return 'add';
}

/** W37: why a code did not work, from the server's own test (the app is only added once it listed its tools) */
function codeFailedLine(t: ReturnType<typeof useT>, e: unknown, name: string) {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'test_code') return t('code.bad');
  if (code === 'test_unreachable') return t('code.unreachable', { name });
  if (code === 'test_refused') return t('code.refused', { name });
  return t('code.failed', { reason: (e as Error).message });
}

/**
 * W36 sign-in: before the owner leaves for the app's own page, one card says what the helper will be able to do.
 * The app's own sign-in needs nothing typed; an app that needs the owner's own OAuth client shows that form here.
 */
function SignInPanel({ c, onDone, onCancel }: { c: CatalogItem; onDone(): void; onCancel(): void }) {
  const t = useT();
  const describe = useDescribe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      // W37: added and started in one step; when the sign-in cannot start nothing is kept and this card says why
      const r = await call<{ authorizeUrl: string }>('POST', '/installs', {
        slug: c.slug,
        values: {},
        signIn: true,
      });
      const href = safeHref(r.authorizeUrl);
      if (!href) throw new Error('bad address');
      window.location.assign(href);
    } catch (e) {
      setError(signInFailedLine(t, e, c.name));
      setBusy(false);
    }
  };
  return (
    <div data-testid="connector-signin" style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <p style={{ margin: 0, ...wrap }}>{t('signin.lead', { name: c.name })}</p>
      <div style={{ display: 'grid', gap: 4 }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{t('signin.can')}</p>
        <p style={{ ...muted, ...wrap }}>{describe(c)}</p>
        <p style={{ ...muted, ...wrap }}>{t('signin.ask')}</p>
      </div>
      {c.auth.signIn === 'own' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button variant="primary" disabled={busy} onClick={() => void go()}>
            {t('signin.go', { name: c.name })}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('install.cancel')}
          </Button>
        </div>
      ) : (
        <InstallForm item={c} onDone={onDone} onCancel={onCancel} />
      )}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </div>
  );
}

/** W36 "get your code": the app's own page in a new tab, a paste field, then a test before it counts as added */
function CodePanel({ c, onDone, onCancel }: { c: CatalogItem; onDone(): void; onCancel(): void }) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = safeHref(c.auth.keyPage ?? c.homepage ?? '');
  const hosted = c.kind === 'mcp-http';
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // W37: a hosted app is added only once it has listed its tools with this code; when it has not, nothing is
      // kept, the card stays open with what was typed, and the reason shows under the field
      await call('POST', '/installs', { slug: c.slug, values, ...(hosted ? { test: true } : {}) });
      onDone();
    } catch (e) {
      setError(codeFailedLine(t, e, c.name));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="connector-install-form" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <p style={{ margin: 0, ...wrap }}>{t('code.lead', { name: c.name })}</p>
      {page && (
        <a
          href={page}
          target="_blank"
          rel="noreferrer noopener"
          className="bk-btn bk-btn--secondary"
          data-testid="connector-get-code"
          style={{ textDecoration: 'none', minHeight: 44, justifySelf: 'start', ...wrap }}
        >
          {t('code.get')}
        </a>
      )}
      {c.auth.fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          type={f.secret ? 'password' : 'text'}
          autoComplete="off"
          hint={f.secret ? t('install.secretHint') : undefined}
          value={values[f.key] ?? ''}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        />
      ))}
      {error && (
        <p role="alert" style={errorStyle} data-testid="connector-code-error">
          {error}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t('adding') : t(hosted ? 'code.test' : 'install.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('install.cancel')}
        </Button>
      </div>
    </div>
  );
}

function CatalogCard({
  c,
  open,
  setOpen,
  reload,
}: {
  c: CatalogItem;
  open: boolean;
  setOpen(v: boolean): void;
  reload(): void;
}) {
  const t = useT();
  const describe = useDescribe();
  const [busy, setBusy] = useState(false);
  const [askMissing, setAskMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = c.homepage ? safeHref(c.homepage) : undefined;
  const site = c.missing?.site ? safeHref(c.missing.site) : undefined;
  const action = actionOf(c);
  // nothing to type: Add adds it, with no form in between
  const oneTap = c.auth.fields.length === 0 && c.auth.type !== 'oauth2_pkce';
  const headingId = `connector-${c.slug}-name`;
  const addNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/installs', { slug: c.slug, values: {} });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const done = () => {
    setOpen(false);
    reload();
  };
  const panel =
    action === 'signIn' ? (
      <SignInPanel c={c} onDone={done} onCancel={() => setOpen(false)} />
    ) : action === 'code' ? (
      <CodePanel c={c} onDone={done} onCancel={() => setOpen(false)} />
    ) : (
      <InstallForm item={c} onDone={done} onCancel={() => setOpen(false)} />
    );
  return (
    <Card
      as="article"
      data-connector={c.slug}
      data-connector-state={c.state}
      aria-labelledby={headingId}
      style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <BrandTile id={c.slug} size={32} fallback="plug" />
        <h3 id={headingId} style={{ margin: 0, fontSize: 17, ...wrap }}>
          {c.name}
        </h3>
        <Badge tone={c.state === 'ready' ? 'primary' : 'outline'} data-testid="connector-state">
          {t(`state.${c.state}`)}
        </Badge>
      </div>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, ...wrap }}>{describe(c)}</p>
      {c.state === 'missing' && c.missing && (
        <p style={{ ...muted, ...wrap }} data-testid="connector-missing">
          {t('missing.line', { name: c.missing.name })}
        </p>
      )}
      {c.state !== 'missing' && home && !open && (
        <a href={home} target="_blank" rel="noreferrer noopener" style={{ ...tapLink, fontSize: 14 }}>
          {t('catalog.homepage')}
        </a>
      )}
      {open ? (
        panel
      ) : c.state === 'missing' && askMissing ? (
        // it cannot run until what it needs is here: adding it anyway is a choice the owner makes knowingly
        <div data-testid="connector-missing-ask" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <p style={{ margin: 0, ...wrap }}>{t('missing.ask', { name: c.missing?.name ?? c.name })}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (oneTap) void addNow();
                else {
                  setAskMissing(false);
                  setOpen(true);
                }
              }}
            >
              {busy ? t('adding') : t('missing.addAnyway')}
            </Button>
            <Button variant="ghost" onClick={() => setAskMissing(false)}>
              {t('install.cancel')}
            </Button>
          </div>
        </div>
      ) : c.state === 'missing' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {site && c.missing && (
            <a
              href={site}
              target="_blank"
              rel="noreferrer noopener"
              className="bk-btn bk-btn--primary"
              data-testid="connector-get"
              style={{ textDecoration: 'none', minHeight: 44, ...wrap }}
            >
              {t('missing.get', { name: c.missing.name })}
            </a>
          )}
          <Button variant="ghost" onClick={() => setAskMissing(true)}>
            {t('catalog.install', { name: c.name })}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="connector-action"
            data-action={action}
            aria-describedby={headingId}
            onClick={() => (action === 'add' && oneTap ? void addNow() : setOpen(true))}
          >
            {busy ? t('adding') : t(`button.${action}`)}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </Card>
  );
}

interface AgentLite {
  id: string;
  name: string;
  builtIn?: boolean;
  status?: string;
}
type Level = { agentId: string; level: string } | { role: string; level: string };

/** W36: which helpers may use an added app (default: the main helper only), set on the mcp server's levels */
function HelpersPicker({ installId }: { installId: string }) {
  const t = useT();
  const [server, setServer] = useState<{ id: string; levels: Level[] } | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([
      fetch('/api/m/mcp/servers', { credentials: 'same-origin' }).then((r) => r.json()),
      fetch('/api/v1/agents', { credentials: 'same-origin' }).then((r) => r.json()),
    ])
      .then(([s, a]) => {
        const mine = (
          s as { servers: { id: string; source: string | null; levels: Level[] }[] }
        ).servers.find((x) => x.source === `connector:${installId}`);
        setServer(mine ? { id: mine.id, levels: mine.levels ?? [] } : null);
        setAgents(((a as { agents: AgentLite[] }).agents ?? []).filter((x) => x.status !== 'archived'));
      })
      .catch(() => setServer(null));
  }, [installId]);
  useEffect(load, [load]);
  if (!server || agents.length === 0) return null;
  const agentLevel = (id: string) =>
    server.levels.find((l): l is { agentId: string; level: string } => 'agentId' in l && l.agentId === id)
      ?.level ?? 'none';
  const set = async (id: string, on: boolean) => {
    setError(null);
    const roles = server.levels.filter((l) => 'role' in l);
    const levels = [
      ...roles,
      ...agents.map((a) => {
        const cur = agentLevel(a.id);
        const want = a.id === id ? on : cur !== 'none';
        return { agentId: a.id, level: want ? (cur === 'manage' ? 'manage' : 'use') : 'none' };
      }),
    ];
    try {
      const r = await fetch(`/api/m/mcp/servers/${encodeURIComponent(server.id)}/levels`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ levels }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <fieldset
      data-testid="connector-helpers"
      style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 2, minWidth: 0 }}
    >
      <legend style={{ fontWeight: 600, padding: 0, marginBottom: 4 }}>{t('helpers.title')}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {agents.map((a) => {
          const on = agentLevel(a.id) !== 'none';
          // a toggle button (44 px tall like every button): pressed = this helper may use the app
          return (
            <Button
              key={a.id}
              data-helper={a.id}
              aria-pressed={on}
              variant={on ? 'primary' : 'secondary'}
              onClick={() => void set(a.id, !on)}
            >
              {on ? '✓ ' : ''}
              {a.name}
              {a.builtIn ? ` (${t('helpers.main')})` : ''}
            </Button>
          );
        })}
      </div>
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** W36: the "<App> is connected" card in the main helper's chat, with two things to tap and send */
const ConnectedCard: BlockRenderer = ({ block, message }) => {
  const t = useT();
  const d = (block.data ?? {}) as { slug?: string; name?: string };
  const slug = String(d.slug ?? '');
  const name = String(d.name ?? slug);
  const [sent, setSent] = useState<string | null>(null);
  const tries = ['a', 'b'].map((k) =>
    t.has(`try.${slug}.${k}`) ? t(`try.${slug}.${k}`) : t(`try.generic.${k}`, { name }),
  );
  const send = async (text: string) => {
    if (!message?.chatId) return;
    const r = await fetch(`/api/v1/chats/${encodeURIComponent(message.chatId)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    if (r?.ok) setSent(text);
  };
  // W40: the shared helper card (a result), its two tries as buttons; once one is sent only the apps link stays
  const who = {
    id: 'who',
    label: t('connected.who'),
    style: 'ghost' as const,
    onAction: () => {
      location.hash = '#/connectors';
    },
  };
  return (
    <HelperCard
      id={`connected-${message?.id ?? slug}`}
      testId="connector-connected-card"
      variant="result"
      badge={<BrandTile id={slug} size={28} fallback="plug" />}
      title={t('connected.title', { name })}
      text={t('connected.try')}
      actions={
        sent === null
          ? [...tries.map((q, n) => ({ id: `try-${n}`, label: q, onAction: () => void send(q) })), who]
          : [who]
      }
      state="open"
      settledLabel=""
    />
  );
};

function FoundCard({ f, reload }: { f: FoundItem; reload(): void }) {
  const t = useT();
  const tech = useTechnical();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/found', { app: f.app, name: f.name, fp: f.fp });
      setAsking(false);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      as="article"
      data-found={`${f.app}:${f.name}`}
      style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <BrandTile id={foundTile(f.name)} size={32} fallback="plug" />
        <h3 style={{ margin: 0, fontSize: 17, ...wrap }}>{f.name}</h3>
        {!f.blocked && <Badge tone="primary">{t('state.ready')}</Badge>}
      </div>
      <p style={{ ...muted, ...wrap }}>{t('found.from', { app: APP_NAMES[f.app] ?? f.app })}</p>
      {f.blocked ? (
        <p style={{ ...muted, ...wrap }} data-testid="found-by-hand">
          {t(`found.blocked.${f.blocked}`)} <UseLink />
        </p>
      ) : asking ? (
        // only a server with keys asks first: its keys are copied into the vault
        <div data-testid="found-proposal" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <p style={{ margin: 0, ...wrap }}>{t('found.keysAsk')}</p>
          {tech && <p style={{ ...muted, ...wrap }}>{t('found.keys', { names: f.keys.join(', ') })}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button variant="primary" disabled={busy} onClick={() => void add()}>
              {busy ? t('adding') : t('found.confirm')}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t('install.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => (f.keys.length ? setAsking(true) : void add())}
          >
            {busy ? t('adding') : t('catalog.install', { name: f.name })}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </Card>
  );
}

export function ConnectorsPage() {
  const t = useT();
  const tech = useTechnical();
  const describe = useDescribe();
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [found, setFound] = useState<FoundItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const terms = q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hit = (...words: string[]) => {
    const all = words.join(' ').toLocaleLowerCase();
    return terms.every((w) => all.includes(w));
  };
  const shownInstalls = installs.filter((i) => hit(i.name, i.slug));
  // an added connector shows once, under Connected
  const shownCatalog =
    catalog?.filter((c) => c.state !== 'added' && hit(c.name, c.slug, c.category, describe(c))) ?? null;
  // W36: a Popular row on top (not while searching), then one section per thing people do
  const popular = terms.length ? [] : (shownCatalog?.filter((c) => c.popular) ?? []);
  const rest = shownCatalog?.filter((c) => !popular.includes(c)) ?? [];
  const sections = GROUPS.map((g) => ({
    g,
    items: rest.filter((c) => (GROUPS.includes(c.group ?? '') ? c.group : 'other') === g),
  })).filter((x) => x.items.length > 0);
  const shownFound = found.filter((f) => !f.added && hit(f.name, APP_NAMES[f.app] ?? f.app));
  const back =
    typeof location !== 'undefined' ? new URLSearchParams(location.hash.split('?')[1] ?? '') : null;
  const outcome = back?.get('oauth') ?? null;
  // the line after a sign-in names the app; the owner-client wording (client id) is only for apps that need one
  const outcomeLine = () => {
    const o = ['connected', 'denied', 'expired', 'failed'].includes(outcome ?? '') ? outcome! : 'failed';
    const id = back?.get('id');
    // wait for the list rather than flash the general line first
    if (id && catalog === null) return null;
    const inst = installs.find((x) => x.id === id);
    if (!inst) return t(`oauth.${o}`);
    const own = catalog?.find((c) => c.slug === inst.slug)?.auth.signIn === 'own';
    if (o === 'connected') return t('oauth.connectedApp', { name: inst.name });
    if (o === 'failed' && own) return t('oauth.failedApp', { name: inst.name });
    return t(`oauth.${o}`);
  };
  const load = useCallback(() => {
    Promise.all([
      call<{ connectors: CatalogItem[] }>('GET', '/catalog'),
      call<{ installs: Install[] }>('GET', '/installs'),
      call<{ found: FoundItem[] }>('GET', '/found').catch(() => ({ found: [] as FoundItem[] })),
    ])
      .then(([c, i, f]) => {
        setCatalog(c.connectors);
        setInstalls(i.installs);
        setFound(f.found);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    load();
    const onLive = (e: Event) => {
      if ((e as CustomEvent<{ type: string }>).detail?.type === 'connectors.changed') load();
    };
    window.addEventListener('pasabot:event', onLive);
    return () => window.removeEventListener('pasabot:event', onLive);
  }, [load]);
  const card = (c: CatalogItem) => (
    <CatalogCard
      key={c.slug}
      c={c}
      open={open === c.slug}
      setOpen={(v) => setOpen(v ? c.slug : null)}
      reload={load}
    />
  );
  return (
    <section
      data-testid="connectors-page"
      style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 1080, minWidth: 0 }}
    >
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        <p style={{ ...muted, fontSize: 15 }}>{t(tech ? 'page.introTech' : 'page.intro')}</p>
      </header>
      {outcome && outcomeLine() !== null && (
        <p role="status" data-testid="oauth-outcome" style={{ margin: 0, fontWeight: 600 }}>
          {outcomeLine()}
        </p>
      )}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
      <Field
        type="search"
        label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        data-testid="connectors-search"
      />
      {catalog === null && !error && <p style={{ margin: 0 }}>{t('loading')}</p>}
      {terms.length > 0 &&
        shownCatalog?.length === 0 &&
        shownInstalls.length === 0 &&
        shownFound.length === 0 && (
          <p role="status" style={muted}>
            {t('search.none')}
          </p>
        )}
      {shownInstalls.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }} data-testid="connectors-connected">
          <h2 style={{ margin: 0, fontSize: 19 }}>{t('installed.title')}</h2>
          {shownInstalls.map((i) => (
            <InstallRow key={i.id} i={i} reload={load} />
          ))}
        </div>
      )}
      {popular.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }} data-testid="connectors-popular">
          <h2 style={{ margin: 0, fontSize: 19 }}>{t('groups.popular')}</h2>
          <div style={grid}>{popular.map(card)}</div>
        </div>
      )}
      {shownFound.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }} data-testid="connectors-found">
          <h2 style={{ margin: 0, fontSize: 19 }}>{t('found.title')}</h2>
          <p style={muted}>{t(tech ? 'found.introTech' : 'found.intro')}</p>
          {shownFound.map((f) => (
            <FoundCard key={`${f.app}:${f.name}`} f={f} reload={load} />
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 16 }} data-testid="connectors-add-more">
        {sections.map(({ g, items }) => (
          <div key={g} style={{ display: 'grid', gap: 10 }} data-testid={`connectors-group-${g}`}>
            <h2 style={{ margin: 0, fontSize: 19 }}>{t(`groups.${g}`)}</h2>
            <div style={grid}>{items.map(card)}</div>
          </div>
        ))}
        <a href="#/mcp" style={tapLink} data-testid="connectors-custom">
          {t(tech ? 'catalog.customTech' : 'catalog.custom')}
        </a>
      </div>
    </section>
  );
}

const mod: WebModule = {
  id: 'connectors',
  messageBlockRenderers: { 'connectors.connected': ConnectedCard },
  routes: [{ path: '/connectors', component: ConnectorsPage, titleKey: 'connectors:page.title' }],
  navItems: [
    {
      id: 'connectors',
      labelKey: 'connectors:nav',
      hintKey: 'connectors:find.navHint',
      keywordsKey: 'connectors:find.navKeywords',
      to: '/connectors',
      icon: 'plug',
      group: 'tools',
      order: 320,
    },
  ],
};
export default mod;
