/**
 * W22 web: the onboarding step after owner setup (free starter with a consent screen, or a brain the owner already
 * has, with detection and install hints), the free-starter page (`/starter`: the "pick another brain" notice), and
 * the templates page (`/templates`: start from a template, describe an agent, import a file, export). Every agent is
 * created only after the owner reviews the draft, through the core agents API, at the server's default trust.
 */
import type { WebModule } from '@pasabot/core/web';
import { displayLocale, documentLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import { Badge, BrandTile, Button, Card, Field } from '@pasabot/ui';
import { useCallback, useEffect, useState } from 'react';

const translations = moduleTranslator(
  'templates',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT() {
  return useModuleT(translations).t;
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(b.message ?? b.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}
const API = '/api/m/templates';
const go = (path: string) => {
  window.location.hash = `#${path}`;
};

interface Starter {
  available: boolean;
  checkedAt: string | null;
  models: { id: string; name: string }[];
  consent: { what: string; where: string; from: string } | null;
  installed: { binPath: string; version: string } | null;
  busyUntil: number | null;
  notice: {
    model: string;
    /** the model's name from the free list (its id only when the list dropped it) */
    name?: string;
    kind?: 'not_free' | 'needs_key' | 'unavailable';
    reason: string;
    agentId: string;
  } | null;
}
/** a local model server that answered on loopback (W34's `GET /api/m/local/detect`) */
interface FoundLocal {
  name: string;
  api: 'ollama' | 'openai';
  url: string;
  models: number;
}
interface ProviderRow {
  id: string;
  displayName: string;
  status: { installed: boolean; hint?: string; installCmd?: string[] };
}
interface Draft {
  name: string;
  instructions: string;
  templateId?: string;
  providerHint?: string;
  model?: string;
}
interface TemplateRow {
  id: string;
  name: string;
  description: string;
  source: string;
}

const muted = { margin: 0, fontSize: 14, color: 'var(--bk-muted)', overflowWrap: 'anywhere' } as const;
const stack = { display: 'grid', gap: 12, minWidth: 0 } as const;

function useProviders() {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  useEffect(() => {
    let gone = false;
    call<{ providers: ProviderRow[] }>('/api/v1/providers')
      .then((r) => !gone && setRows(r.providers))
      .catch(() => !gone && setRows([]));
    return () => {
      gone = true;
    };
  }, []);
  return rows;
}

/** Provider detection with install hints (guided setup). */
function Detected({ rows }: { rows: ProviderRow[] | null }) {
  const t = useT();
  if (!rows) return null;
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }} data-testid="detected">
      {rows
        .filter((p) => p.id !== 'fake' || p.status.installed)
        .map((p) => (
          <li key={p.id} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 15 }}>{p.displayName}</strong>
              <Badge>{p.status.installed ? t('onboarding.found') : t('onboarding.notFound')}</Badge>
            </span>
            {!p.status.installed && p.status.installCmd?.length ? (
              <code style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                {t('onboarding.installHint', { cmd: p.status.installCmd.join(' ') })}
              </code>
            ) : null}
          </li>
        ))}
    </ul>
  );
}

/** A brain tile from the provider-ops Brains page (`GET /api/m/provider-ops/brains`): same states, same words. */
interface BrainTile {
  id: string;
  name: string;
  description: string;
  stateLabel: string;
  monogram: string;
  state: 'ready' | 'needs_sign_in' | 'not_installed' | 'unreachable';
  providers: { id: string; state: string }[];
}
const RANK = { ready: 0, needs_sign_in: 1, unreachable: 2, not_installed: 3 } as const;

/**
 * The brain step's list: the Brains page tiles, the ones found ready on this computer first. Without the provider-ops
 * module it falls back to the plain detection list.
 */
function BrainTiles({ fallback }: { fallback: ProviderRow[] | null }) {
  const t = useT();
  const [tiles, setTiles] = useState<BrainTile[] | null | 'none'>(null);
  useEffect(() => {
    let gone = false;
    call<{ brains: BrainTile[] }>(`/api/m/provider-ops/brains?lang=${encodeURIComponent(documentLocale())}`)
      .then((r) => {
        if (!gone) setTiles(r.brains.filter((b) => b.id !== 'fake' || b.state === 'ready'));
      })
      .catch(() => {
        if (!gone) setTiles('none');
      });
    return () => {
      gone = true;
    };
  }, []);
  if (tiles === 'none') return <Detected rows={fallback} />;
  if (!tiles) return null;
  const sorted = [...tiles].sort((a, b) => RANK[a.state] - RANK[b.state]);
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }} data-testid="detected">
      {sorted.map((b) => {
        const ready = b.state === 'ready';
        const usable = b.providers.find((p) => p.state === 'ready');
        return (
          <li
            key={b.id}
            data-brain={b.id}
            data-state={b.state}
            style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}
          >
            <BrandTile id={b.id} size={40} fallback="brain" />
            <span style={{ flex: '1 1 160px', minWidth: 0, display: 'grid', gap: 2 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 15 }}>{b.name}</strong>
                <Badge tone={ready ? 'primary' : 'outline'}>
                  {ready ? t('onboarding.found') : b.stateLabel}
                </Badge>
              </span>
              <span style={{ ...muted, fontSize: 13 }}>{b.description}</span>
            </span>
            {ready && usable ? (
              <Button
                size="sm"
                style={{ minHeight: 44 }}
                onClick={() => go(`/agents/new?brain=${encodeURIComponent(usable.id)}`)}
              >
                {t('onboarding.useThis')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                style={{ minHeight: 44 }}
                onClick={() => go('/settings/agents/brains')}
              >
                {t('onboarding.setUp')}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

async function createAgent(d: {
  name: string;
  instructions: string;
  providerId: string;
  model?: string | null;
}) {
  return call<{ agent: { id: string }; chatId: string }>('/api/v1/agents', {
    method: 'POST',
    body: { name: d.name, instructions: d.instructions, providerId: d.providerId, model: d.model ?? null },
  });
}

/** The free starter: consent screen → install → first agent on a free model → its chat. */
function FreeStarter({ starter, onBack }: { starter: Starter; onBack(): void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = starter.consent!;
  const agree = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call(`${API}/starter/install`, { method: 'POST', body: { consent: true } });
      const model = starter.models[0]!.id;
      const a = await createAgent({
        name: t('consent.agentName'),
        instructions: t('consent.agentInstructions'),
        providerId: 'opencode',
        model,
      });
      await call(`${API}/starter/agents`, { method: 'POST', body: { agentId: a.agent.id, model } });
      go(`/chats/${a.chatId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <section style={stack} aria-labelledby="tpl-consent">
      <h2 id="tpl-consent" style={{ margin: 0, fontSize: 20 }}>
        {t('consent.title')}
      </h2>
      <ul
        style={{
          margin: 0,
          paddingInlineStart: 20,
          display: 'grid',
          gap: 6,
          fontSize: 15,
          overflowWrap: 'anywhere',
        }}
      >
        <li>{t('consent.what', { what: c.what })}</li>
        <li>{t('consent.where', { where: c.where })}</li>
        <li>{t('consent.from', { from: c.from })}</li>
      </ul>
      <p style={muted}>{t('consent.check')}</p>
      <p style={muted}>{t('consent.models', { date: starter.checkedAt ?? '' })}</p>
      {err && (
        <p role="alert" style={{ margin: 0, fontSize: 15, color: 'var(--bk-danger, #b42318)' }}>
          {t('consent.failed', { reason: err })}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!err && (
          <Button variant="primary" onClick={agree} disabled={busy}>
            {busy ? t('consent.working') : t('consent.agree')}
          </Button>
        )}
        <Button onClick={onBack} disabled={busy}>
          {t('consent.back')}
        </Button>
      </div>
    </section>
  );
}

function StarterNotice({ starter }: { starter: Starter }) {
  const t = useT();
  if (!starter.notice) return null;
  const n = starter.notice;
  return (
    <Card
      as="section"
      role="alert"
      style={{ padding: 16, display: 'grid', gap: 8 }}
      data-testid="starter-notice"
    >
      <strong style={{ fontSize: 16 }}>
        {t(n.kind === 'not_free' ? 'notice.notFreeTitle' : 'notice.title')}
      </strong>
      <p style={{ margin: 0, fontSize: 15, overflowWrap: 'anywhere' }}>
        {n.kind
          ? t(`notice.${n.kind}`, { name: n.name ?? n.model })
          : t('notice.body', { model: n.model, reason: n.reason })}
      </p>
      <div>
        <Button variant="primary" onClick={() => go(`/agents/${n.agentId}/edit`)}>
          {t('notice.action')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Option 2: a local model server that answered on loopback (shown only then). Adding it is the owner's click, through
 * W34's owner-only `POST /api/m/local/endpoints`; agents never reach that route and no tool adds an address.
 */
function LocalModelOption() {
  const t = useT();
  const [found, setFound] = useState<FoundLocal[]>([]);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    // no local models module, or nothing answering: the option stays hidden
    call<{ found: FoundLocal[] }>('/api/m/local/detect')
      .then((r) => !gone && setFound(r.found ?? []))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  if (found.length === 0 && !added) return null;
  const use = async (f: FoundLocal) => {
    setBusy(true);
    setErr(null);
    try {
      await call('/api/m/local/endpoints', {
        method: 'POST',
        body: { name: f.name, api: f.api, url: f.url, tools: 'auto' },
      });
      setAdded(f.name);
      setFound((xs) => xs.filter((x) => x.url !== f.url));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      as="section"
      style={{ padding: 16, display: 'grid', gap: 8 }}
      aria-labelledby="tpl-local"
      data-testid="onboarding-local"
    >
      <h3 id="tpl-local" style={{ margin: 0, fontSize: 17 }}>
        {t('onboarding.localTitle')}
      </h3>
      <p style={muted}>{t('onboarding.localBody')}</p>
      {found.map((f) => (
        <div key={f.url} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 15, overflowWrap: 'anywhere' }}>
            {t('onboarding.localFound', { name: f.name, url: f.url, count: f.models })}
          </p>
          <div>
            <Button variant="primary" disabled={busy} onClick={() => void use(f)}>
              {t('onboarding.localCta', { name: f.name })}
            </Button>
          </div>
        </div>
      ))}
      {added && (
        <>
          <p role="status" style={{ margin: 0, fontSize: 15 }}>
            {t('onboarding.localAdded', { name: added })}
          </p>
          <div>
            <Button variant="primary" onClick={() => go('/agents/new')}>
              {t('onboarding.guidedCta')}
            </Button>
          </div>
        </>
      )}
      {err && (
        <p
          role="alert"
          style={{ margin: 0, fontSize: 14, color: 'var(--bk-danger)', overflowWrap: 'anywhere' }}
        >
          {err}
        </p>
      )}
    </Card>
  );
}

/** Onboarding step: the three ways to a first agent (free starter, a local model when one answers, guided setup). */
function OnboardingStep() {
  const t = useT();
  const [starter, setStarter] = useState<Starter | null>(null);
  const [consent, setConsent] = useState(false);
  const providers = useProviders();
  useEffect(() => {
    let gone = false;
    call<Starter>(`${API}/starter`)
      .then((s) => !gone && setStarter(s))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  if (consent && starter?.available)
    return <FreeStarter starter={starter} onBack={() => setConsent(false)} />;
  return (
    <div style={stack} data-slot="templates-onboarding">
      <h2 style={{ margin: 0, fontSize: 20 }}>{t('onboarding.title')}</h2>
      <p style={muted}>{t('onboarding.intro')}</p>
      {starter && <StarterNotice starter={starter} />}
      <Card as="section" style={{ padding: 16, display: 'grid', gap: 8 }} aria-labelledby="tpl-free">
        <h3 id="tpl-free" style={{ margin: 0, fontSize: 17 }}>
          {t('onboarding.freeTitle')}
        </h3>
        {starter?.available ? (
          <>
            <p style={muted}>{t('onboarding.freeBody')}</p>
            <div>
              <Button variant="primary" onClick={() => setConsent(true)}>
                {t('onboarding.freeCta')}
              </Button>
            </div>
          </>
        ) : (
          starter && <p style={muted}>{t('onboarding.freeUnavailable')}</p>
        )}
      </Card>
      <LocalModelOption />
      <Card as="section" style={{ padding: 16, display: 'grid', gap: 8 }} aria-labelledby="tpl-guided">
        <h3 id="tpl-guided" style={{ margin: 0, fontSize: 17 }}>
          {t('onboarding.guidedTitle')}
        </h3>
        <p style={muted}>{t('onboarding.guidedBody')}</p>
        <BrainTiles fallback={providers} />
        <div>
          <Button onClick={() => go('/agents/new')}>{t('onboarding.guidedCta')}</Button>
        </div>
      </Card>
    </div>
  );
}

function StarterPage() {
  const t = useT();
  const [starter, setStarter] = useState<Starter | null>(null);
  useEffect(() => {
    call<Starter>(`${API}/starter`)
      .then(setStarter)
      .catch(() => {});
  }, []);
  return (
    <section className="page" style={stack} aria-labelledby="tpl-starter-h">
      <h1 id="tpl-starter-h">{t('page.starterTitle')}</h1>
      {starter?.notice ? (
        <StarterNotice starter={starter} />
      ) : (
        starter && (
          <p style={muted}>
            {starter.busyUntil
              ? t('notice.busy', { time: new Date(starter.busyUntil).toLocaleTimeString(displayLocale()) })
              : t('notice.none')}
          </p>
        )
      )}
    </section>
  );
}

function Review({ draft, onCancel }: { draft: Draft; onCancel(): void }) {
  const t = useT();
  const providers = useProviders();
  const [name, setName] = useState(draft.name);
  const [instructions, setInstructions] = useState(draft.instructions);
  const [providerId, setProviderId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const usable = (providers ?? []).filter((p) => p.status.installed);
  useEffect(() => {
    if (!providerId && usable.length)
      setProviderId(usable.find((p) => p.id === draft.providerHint)?.id ?? usable[0]!.id);
  }, [usable, providerId, draft.providerHint]);
  const create = async () => {
    setErr(null);
    try {
      const a = await createAgent({ name, instructions, providerId, model: draft.model ?? null });
      go(`/chats/${a.chatId}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Card as="section" style={{ padding: 16, display: 'grid', gap: 12 }} aria-labelledby="tpl-review">
      <h2 id="tpl-review" style={{ margin: 0, fontSize: 18 }}>
        {t('review.title')}
      </h2>
      <p style={muted}>{t('review.hint')}</p>
      <Field label={t('review.name')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <Field
        label={t('review.instructions')}
        multiline
        rows={6}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <label style={{ display: 'grid', gap: 6, fontSize: 14, fontWeight: 600 }}>
        {t('review.brain')}
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          style={{ minHeight: 44, fontSize: 15 }}
        >
          {usable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>
      {err && (
        <p role="alert" style={{ margin: 0, fontSize: 15 }}>
          {t('error', { msg: err })}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={create} disabled={!name.trim() || !providerId}>
          {t('review.create')}
        </Button>
        <Button onClick={onCancel}>{t('review.cancel')}</Button>
      </div>
    </Card>
  );
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TemplatesPage() {
  const t = useT();
  const [list, setList] = useState<TemplateRow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    call<{ templates: (TemplateRow & { instructions: string; providerHint?: string; model?: string })[] }>(
      `${API}/catalog`,
    )
      .then((r) => setList(r.templates))
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => load(), [load]);
  const run = (f: () => Promise<void>) => () => {
    setErr(null);
    f().catch((e) => setErr((e as Error).message));
  };
  const use = (id: string) =>
    run(async () => {
      const r = await call<{ templates: (TemplateRow & Draft)[] }>(`${API}/catalog`);
      const tp = r.templates.find((x) => x.id === id);
      if (tp)
        setDraft({
          name: tp.name,
          instructions: tp.instructions,
          templateId: tp.id,
          ...(tp.model ? { model: tp.model } : {}),
        });
    });
  const describe = run(async () => {
    const r = await call<{ draft: Draft }>(`${API}/draft`, { method: 'POST', body: { prompt } });
    setDraft(r.draft);
  });
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try {
      const content = await f.text();
      const r = await call<{ draft: Draft }>(`${API}/import`, {
        method: 'POST',
        body: { fileName: f.name, content },
      });
      setDraft(r.draft);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="page" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <h1>{t('page.title')}</h1>
      {err && (
        <p role="alert" style={{ margin: 0, fontSize: 15 }}>
          {t('error', { msg: err })}
        </p>
      )}
      {draft ? (
        <Review key={JSON.stringify(draft)} draft={draft} onCancel={() => setDraft(null)} />
      ) : (
        <>
          <Card as="section" style={{ padding: 16, display: 'grid', gap: 8 }} aria-labelledby="tpl-describe">
            <h2 id="tpl-describe" style={{ margin: 0, fontSize: 18 }}>
              {t('describe.title')}
            </h2>
            <Field
              label={t('describe.label')}
              multiline
              rows={3}
              placeholder={t('describe.placeholder')}
              value={prompt}
              maxLength={2000}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div>
              <Button variant="primary" onClick={describe} disabled={!prompt.trim()}>
                {t('describe.submit')}
              </Button>
            </div>
          </Card>
          <section style={stack} aria-labelledby="tpl-cat">
            <h2 id="tpl-cat" style={{ margin: 0, fontSize: 18 }}>
              {t('catalog.title')}
            </h2>
            {list && !list.length && <p style={muted}>{t('catalog.empty')}</p>}
            <div
              style={{
                display: 'grid',
                gap: 12,
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
              }}
            >
              {(list ?? []).map((tp) => (
                <Card
                  key={tp.id}
                  as="article"
                  data-template={tp.id}
                  style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}
                >
                  <strong style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{tp.name}</strong>
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                    {tp.description}
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button
                      variant="primary"
                      onClick={use(tp.id)}
                      aria-label={t('catalog.useNamed', { name: tp.name })}
                    >
                      {t('catalog.use')}
                    </Button>
                    <Button
                      onClick={run(async () =>
                        download(
                          `${tp.id}.pasabot-template.json`,
                          await call(`${API}/catalog/${tp.id}/export`),
                        ),
                      )}
                      aria-label={t('catalog.exportNamed', { name: tp.name })}
                    >
                      {t('catalog.export')}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </section>
          <Card as="section" style={{ padding: 16, display: 'grid', gap: 8 }} aria-labelledby="tpl-import">
            <h2 id="tpl-import" style={{ margin: 0, fontSize: 18 }}>
              {t('import.title')}
            </h2>
            <p style={muted}>{t('import.hint')}</p>
            <label style={{ display: 'grid', gap: 6, fontSize: 14, fontWeight: 600 }}>
              {t('import.label')}
              <input
                type="file"
                accept=".json,.md"
                style={{ minHeight: 44, fontSize: 15, maxWidth: '100%' }}
                onChange={(e) => void importFile(e.target.files?.[0])}
              />
            </label>
          </Card>
        </>
      )}
    </div>
  );
}

const mod: WebModule = {
  id: 'templates',
  routes: [
    { path: '/templates', component: TemplatesPage, titleKey: 'templates:page.title' },
    { path: '/starter', component: StarterPage, titleKey: 'templates:page.starterTitle' },
  ],
  navItems: [
    {
      id: 'templates',
      labelKey: 'templates:nav',
      hintKey: 'templates:find.navHint',
      keywordsKey: 'templates:find.navKeywords',
      to: '/templates',
      icon: 'sparkle',
      group: 'agents',
      order: 310,
    },
  ],
  onboardingSteps: [{ id: 'templates-first-agent', order: 100, component: OnboardingStep }],
};
export default mod;
