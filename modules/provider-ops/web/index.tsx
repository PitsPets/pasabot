/**
 * W3 web: the context gauge in the chat header, the Usage page (`/usage`: tokens per agent and per brain, paused
 * brains, "Check now"), Settings → Brains and fallbacks (fallback chain, account and compaction threshold per agent,
 * resume compaction, accounts), and the localized switch/compaction notices posted in chats.
 */
import type { WebModule } from '@pasabot/core/web';
import { intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { MessageBlock } from '@pasabot/protocol';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { type CSSProperties, useCallback, useEffect, useId, useState } from 'react';
import { BRAINS_PATH, BrainsPage, BrainsRedirect } from './brains.js';

const NS = 'provider-ops';
const translations = moduleTranslator(
  NS,
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);
/** the shell re-dispatches live events it does not keep under this name (`LIVE_EVENT` in @pasabot/core/web) */
const LIVE_EVENT = 'pasabot:event';
const API = '/api/m/provider-ops';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const muted: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--bk-muted)' };
const fmt = (n: number, lang: string) => n.toLocaleString(intlLocale(lang));

// ---------- chat header: context gauge ----------
interface ChatContext {
  chatId: string;
  agentId: string;
  providerId: string;
  model: string | null;
  used: number;
  window: number;
  pct: number;
}
/** This chat's context use, kept fresh from live events (a finished turn refetches). */
function useChatContext(chatId: string) {
  const [c, setC] = useState<ChatContext | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      call<{ context: ChatContext | null }>(`${API}/chats/${encodeURIComponent(chatId)}/context`)
        .then((r) => alive && setC(r.context))
        .catch(() => alive && setC(null));
    void load();
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; data: unknown }>).detail;
      if (d?.type === 'provider-ops.context' && (d.data as ChatContext).chatId === chatId)
        setC(d.data as ChatContext);
      // a finished turn in another tab or a missed event: refetch when this chat's reply is final
      if (d?.type === 'message.updated' && (d.data as { chatId?: string }).chatId === chatId) void load();
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => {
      alive = false;
      window.removeEventListener(LIVE_EVENT, on);
    };
  }, [chatId]);
  return c;
}
/** the header pill shows from this much context use on (Simplify spec 2.1); below that it lives in More only */
export const CONTEXT_PILL_PCT = 70;
const toneOf = (pct: number) =>
  pct >= 90 ? 'var(--bk-danger, #b42318)' : pct >= 70 ? 'var(--bk-signal, #b54708)' : 'var(--bk-primary)';

/** Chat header: nothing below 70 %, then an amber "Memory N% full" pill. */
export function ContextGauge({ chatId }: { chatId: string }) {
  const { t, lang } = useT();
  const c = useChatContext(chatId);
  if (!c || c.pct < CONTEXT_PILL_PCT) return null;
  return (
    <Badge
      tone="signal"
      title={t('gauge.title', {
        used: fmt(c.used, lang),
        window: fmt(c.window, lang),
        provider: c.providerId,
      })}
      data-context-gauge={c.pct}
      style={{ whiteSpace: 'nowrap' }}
    >
      {t('gauge.full', { pct: c.pct })}
    </Badge>
  );
}

/** More › Context use: the full meter at any percentage. */
export function ContextUse({ chatId }: { chatId: string }) {
  const { t, lang } = useT();
  const c = useChatContext(chatId);
  if (!c)
    return (
      <p style={muted} data-context-use="none">
        {t('gauge.none')}
      </p>
    );
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }} data-context-use={c.pct}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <meter
          min={0}
          max={100}
          value={c.pct}
          aria-label={t('gauge.label', { pct: c.pct })}
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}
        />
        <span
          aria-hidden
          style={{
            width: 80,
            height: 8,
            borderRadius: 4,
            background: 'var(--bk-line, rgba(127,127,127,.25))',
            overflow: 'hidden',
            display: 'inline-block',
          }}
        >
          <span style={{ display: 'block', height: '100%', width: `${c.pct}%`, background: toneOf(c.pct) }} />
        </span>
        <span aria-hidden>{t('gauge.label', { pct: c.pct })}</span>
      </span>
      <p style={muted}>
        {t('gauge.title', { used: fmt(c.used, lang), window: fmt(c.window, lang), provider: c.providerId })}
      </p>
    </div>
  );
}

// ---------- chat notice block ----------
interface NoticeData {
  kind: 'switched' | 'back' | 'compacted' | 'stopped';
  reason?: string;
  from?: string;
  to?: string;
  pct?: number;
}
export function NoticeBlock({ block }: { block: MessageBlock }) {
  const { t } = useT();
  const n = block.data as NoticeData;
  const reason = n.reason ? t(`notice.reason.${n.reason}`) : '';
  const text =
    n.kind === 'switched'
      ? t('notice.switched', { from: n.from, to: n.to, reason })
      : n.kind === 'back'
        ? t('notice.back', { to: n.to })
        : n.kind === 'stopped'
          ? t('notice.stopped')
          : n.reason === 'context_overflow'
            ? t('notice.overflow')
            : t(n.reason === 'native' ? 'notice.compactedNative' : 'notice.compactedReseed', {
                pct: n.pct ?? 0,
              });
  return (
    <p data-provider-notice={n.kind} style={{ margin: 0, fontSize: 14, color: 'var(--bk-muted)' }}>
      {text}
    </p>
  );
}

// ---------- Usage page ----------
interface Totals {
  runs: number;
  input: number;
  output: number;
  cache: number;
}
interface UsageView {
  days: number;
  agents: (Totals & { agentId: string; name: string })[];
  providers: (Totals & { providerId: string })[];
  limits: { providerId: string; accountId: string | null; until: number; reason: string }[];
}
function TotalsTable({ rows, head }: { rows: (Totals & { key: string; label: string })[]; head: string }) {
  const { t, lang } = useT();
  const cell: CSSProperties = { padding: '8px 6px', textAlign: 'end', fontVariantNumeric: 'tabular-nums' };
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ color: 'var(--bk-muted)' }}>
            <th style={{ ...cell, textAlign: 'start' }}>{head}</th>
            <th style={cell}>{t('page.runs')}</th>
            <th style={cell}>{t('page.input')}</th>
            <th style={cell}>{t('page.output')}</th>
            <th style={cell}>{t('page.cache')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              data-usage-row={r.key}
              style={{ borderTop: '1px solid var(--bk-line, rgba(127,127,127,.2))' }}
            >
              <td style={{ ...cell, textAlign: 'start', overflowWrap: 'anywhere' }}>{r.label}</td>
              <td style={cell}>{fmt(r.runs, lang)}</td>
              <td style={cell}>{fmt(r.input, lang)}</td>
              <td style={cell}>{fmt(r.output, lang)}</td>
              <td style={cell}>{fmt(r.cache, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function UsagePage() {
  const { t, lang } = useT();
  const [u, setU] = useState<UsageView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    call<UsageView>(`${API}/usage?days=30`)
      .then(setU)
      .catch(() => setU(null));
  }, []);
  useEffect(load, [load]);
  const check = async () => {
    const r = await call<{ cleared: number }>(`${API}/check`, json('POST'));
    setMsg(t('page.checked', { count: r.cleared }));
    load();
  };
  return (
    <section style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 860, minWidth: 0 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>{t('page.title')}</h1>
      <p style={muted}>{t('page.intro')}</p>
      {u && (
        <>
          <p style={muted}>{t('page.days', { count: u.days })}</p>
          <Card as="section" style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{t('page.agents')}</h2>
            {u.agents.length === 0 ? (
              <p style={muted}>{t('page.empty')}</p>
            ) : (
              <TotalsTable
                head={t('page.agent')}
                rows={u.agents.map((a) => ({ ...a, key: a.agentId, label: a.name }))}
              />
            )}
          </Card>
          <Card as="section" style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{t('page.providers')}</h2>
            {u.providers.length === 0 ? (
              <p style={muted}>{t('page.empty')}</p>
            ) : (
              <TotalsTable
                head={t('page.provider')}
                rows={u.providers.map((p) => ({ ...p, key: p.providerId, label: p.providerId }))}
              />
            )}
          </Card>
          <Card as="section" style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }} data-limits>
            <h2 style={{ margin: 0, fontSize: 18 }}>{t('page.limits')}</h2>
            {u.limits.length === 0 ? (
              <p style={muted}>{t('page.noLimits')}</p>
            ) : (
              <ul style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 4 }}>
                {u.limits.map((l) => (
                  <li key={`${l.providerId}/${l.accountId ?? ''}`} style={{ overflowWrap: 'anywhere' }}>
                    {t('page.limitUntil', {
                      provider: l.providerId,
                      reason: t(`notice.reason.${l.reason}`),
                      time: new Date(l.until).toLocaleTimeString(intlLocale(lang), {
                        timeStyle: 'short',
                      }),
                    })}
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button variant="secondary" onClick={() => void check()} data-usage-check>
                {t('page.check')}
              </Button>
            </div>
            {msg && (
              <p role="status" style={muted}>
                {msg}
              </p>
            )}
          </Card>
        </>
      )}
    </section>
  );
}

// ---------- Settings: brains and fallbacks ----------
interface Entry {
  providerId: string;
  model?: string;
  accountId?: string;
}
interface AgentSettings {
  agentId: string;
  name: string;
  providerId: string;
  model: string | null;
  fallback: Entry[];
  accountId: string | null;
  compactPct: number | null;
  compactTokens: number | null;
  effectivePct: number;
  compactionStopped: number | null;
}
interface AccountView {
  id: string;
  providerId: string;
  label: string;
  configDir: string;
  /** the shell command that signs this account in (null = only its folder is known) */
  signIn: string | null;
}
interface SettingsView {
  providers: { id: string; name: string }[];
  accounts: AccountView[];
  agents: AgentSettings[];
}
/** a brain as the owner knows it: the name the server gave it with the shared `providerDisplayName` (W9) */
const brainName = (view: SettingsView, id: string) => view.providers.find((p) => p.id === id)?.name ?? id;
const selectStyle: CSSProperties = { minHeight: 44, width: '100%', fontSize: 16 };

function Select({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  options: { value: string; label: string }[];
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="bk-field" style={{ minWidth: 0 }}>
      <label className="bk-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="bk-input"
        style={selectStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const SLOTS = 2;
function AgentCard({ a, view, onSaved }: { a: AgentSettings; view: SettingsView; onSaved(): void }) {
  const { t } = useT();
  const [chain, setChain] = useState<Entry[]>(() =>
    Array.from({ length: SLOTS }, (_, i) => a.fallback[i] ?? { providerId: '' }),
  );
  const [account, setAccount] = useState(a.accountId ?? '');
  const [pct, setPct] = useState(a.compactPct === null ? '' : String(a.compactPct));
  const [state, setState] = useState<'idle' | 'saved' | string>('idle');
  const providers = [
    { value: '', label: t('settings.none') },
    ...view.providers.map((p) => ({ value: p.id, label: p.name })),
  ];
  const accountsFor = (pid: string) => [
    { value: '', label: t('settings.defaultAccount') },
    ...view.accounts.filter((x) => x.providerId === pid).map((x) => ({ value: x.id, label: x.label })),
  ];
  const save = async () => {
    try {
      await call(`${API}/agents/${encodeURIComponent(a.agentId)}`, {
        ...json('PUT', {
          fallback: chain
            .filter((e) => e.providerId)
            .map((e) => ({
              providerId: e.providerId,
              ...(e.model?.trim() ? { model: e.model.trim() } : {}),
              ...(e.accountId ? { accountId: e.accountId } : {}),
            })),
          accountId: account || null,
          compactPct: pct.trim() ? Number(pct) : null,
          compactTokens: a.compactTokens,
        }),
      });
      setState('saved');
      onSaved();
    } catch (e) {
      setState((e as Error).message);
    }
  };
  const resume = async () => {
    await call(`${API}/agents/${encodeURIComponent(a.agentId)}/compaction/resume`, json('POST'));
    onSaved();
  };
  const set = (i: number, patch: Partial<Entry>) =>
    setChain((c) =>
      c.map((e, j) =>
        j === i ? { ...e, ...patch, ...(patch.providerId !== undefined ? { accountId: undefined } : {}) } : e,
      ),
    );
  return (
    <Card
      as="article"
      data-agent-settings={a.agentId}
      style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>{a.name}</h3>
      <p style={muted}>
        {t('settings.primary', {
          provider: a.model ? `${brainName(view, a.providerId)} · ${a.model}` : brainName(view, a.providerId),
        })}
      </p>
      <Select
        label={t('settings.account', { provider: brainName(view, a.providerId) })}
        value={account}
        onChange={setAccount}
        options={accountsFor(a.providerId)}
      />
      {chain.map((e, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
          key={i}
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            minWidth: 0,
          }}
        >
          <Select
            label={t('settings.fallback', { n: i + 1 })}
            value={e.providerId}
            onChange={(v) => set(i, { providerId: v })}
            options={providers}
            testId={`fallback-${i + 1}`}
          />
          {e.providerId && (
            <>
              <Field
                label={t('settings.model')}
                value={e.model ?? ''}
                onChange={(ev) => set(i, { model: ev.target.value })}
              />
              <Select
                label={t('settings.account', { provider: brainName(view, e.providerId) })}
                value={e.accountId ?? ''}
                onChange={(v) =>
                  setChain((c) => c.map((x, j) => (j === i ? { ...x, accountId: v || undefined } : x)))
                }
                options={accountsFor(e.providerId)}
              />
            </>
          )}
        </div>
      ))}
      <Field
        label={t('settings.compactPct')}
        hint={t('settings.compactHint', { pct: a.effectivePct })}
        inputMode="numeric"
        value={pct}
        onChange={(ev) => setPct(ev.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
      />
      {a.compactionStopped !== null && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Badge tone="signal">{t('settings.stopped')}</Badge>
          <Button variant="secondary" onClick={() => void resume()}>
            {t('settings.resume')}
          </Button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={() => void save()}>
          {t('settings.save')}
        </Button>
        {state === 'saved' && (
          <span role="status" style={muted}>
            {t('settings.saved')}
          </span>
        )}
        {state !== 'saved' && state !== 'idle' && (
          <span role="alert" style={{ ...muted, color: 'var(--bk-danger, #b42318)' }}>
            {state}
          </span>
        )}
      </div>
    </Card>
  );
}

/** One account: its sign-in command (or folder) and whether its CLI is signed in there. */
function AccountItem({
  account: x,
  brain,
  onRemove,
}: {
  account: AccountView;
  brain: string;
  onRemove(): void;
}) {
  const { t } = useT();
  const [signedIn, setSignedIn] = useState<boolean | 'unknown' | null>(null);
  useEffect(() => {
    let live = true;
    call<{ status: { signedIn: boolean | 'unknown' } }>(`${API}/accounts/${encodeURIComponent(x.id)}/status`)
      .then((r) => live && setSignedIn(r.status.signedIn))
      .catch(() => live && setSignedIn('unknown'));
    return () => {
      live = false;
    };
  }, [x.id]);
  const status =
    signedIn === null
      ? t('settings.accountChecking')
      : signedIn === true
        ? t('settings.accountSignedIn')
        : signedIn === false
          ? t('settings.accountSignedOut')
          : t('settings.accountUnknown');
  return (
    <li style={{ display: 'grid', gap: 4, minWidth: 0 }} data-account={x.id}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ overflowWrap: 'anywhere' }}>
          {x.label} · {brain}
        </span>
        <span style={muted} data-account-status>
          {status}
        </span>
        <Button variant="ghost" onClick={onRemove}>
          {t('settings.remove')}
        </Button>
      </div>
      <p style={muted}>{x.signIn ? t('settings.accountSignIn') : t('settings.accountFolder')}</p>
      <code style={{ fontSize: 13, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }} data-account-signin>
        {x.signIn ?? x.configDir}
      </code>
    </li>
  );
}

function Accounts({ view, onChange }: { view: SettingsView; onChange(): void }) {
  const { t } = useT();
  const [provider, setProvider] = useState(view.providers[0]?.id ?? '');
  const [name, setName] = useState('');
  const add = async () => {
    if (!name.trim() || !provider) return;
    await call(`${API}/accounts`, json('POST', { providerId: provider, label: name.trim() }));
    setName('');
    onChange();
  };
  const remove = async (id: string) => {
    await call(`${API}/accounts/${encodeURIComponent(id)}`, json('DELETE'));
    onChange();
  };
  return (
    <Card as="section" style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }} data-accounts>
      <h3 style={{ margin: 0, fontSize: 16 }}>{t('settings.accounts')}</h3>
      <p style={muted}>{t('settings.accountsIntro')}</p>
      {view.accounts.length === 0 ? (
        <p style={muted}>{t('settings.noAccounts')}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {view.accounts.map((x) => (
            <AccountItem
              key={x.id}
              account={x}
              brain={brainName(view, x.providerId)}
              onRemove={() => void remove(x.id)}
            />
          ))}
        </ul>
      )}
      <div
        style={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          minWidth: 0,
        }}
      >
        <Select
          label={t('settings.accountProvider')}
          value={provider}
          onChange={setProvider}
          options={view.providers.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Field
          label={t('settings.accountLabel')}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <Button variant="secondary" onClick={() => void add()} disabled={!name.trim()}>
          {t('settings.addAccount')}
        </Button>
      </div>
    </Card>
  );
}

export function ProviderSettings() {
  const { t, lang } = useT();
  const [v, setV] = useState<SettingsView | null>(null);
  // the brain names come from the server (the shared providerDisplayName) in the language this page reads in
  const load = useCallback(() => {
    call<SettingsView>(`${API}/settings?lang=${encodeURIComponent(lang)}`)
      .then(setV)
      .catch(() => setV(null));
  }, [lang]);
  useEffect(load, [load]);
  if (!v) return null;
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }} data-provider-settings>
      <p style={muted}>{t('settings.intro')}</p>
      {v.agents.map((a) => (
        <AgentCard key={a.agentId} a={a} view={v} onSaved={load} />
      ))}
      <Accounts view={v} onChange={load} />
    </div>
  );
}

const mod: WebModule = {
  id: NS,
  // the Brains page lives in Settings › Agents & brains (SPEC "Simplify" 5): a feature of its own there (never
  // hidden, owner only, pinnable), no sidebar entry; `#/brains` (older links) goes there
  routes: [
    { path: '/usage', component: UsagePage, titleKey: `${NS}:page.title` },
    { path: BRAINS_PATH, component: BrainsPage, titleKey: `${NS}:brains.title` },
    { path: '/brains', component: BrainsRedirect, titleKey: `${NS}:brains.title` },
  ],
  navItems: [
    {
      id: NS,
      labelKey: `${NS}:nav`,
      hintKey: 'provider-ops:find.navHint',
      keywordsKey: 'provider-ops:find.navKeywords',
      to: '/usage',
      icon: 'gauge',
      group: 'spending',
      optional: false,
      order: 320,
    },
    {
      id: 'brains',
      labelKey: `${NS}:brains.title`,
      hintKey: 'provider-ops:find.brainsHint',
      keywordsKey: 'provider-ops:find.brainsKeywords',
      to: BRAINS_PATH,
      icon: 'brain',
      group: 'agents',
      optional: false,
      order: 110,
    },
  ],
  settingsSections: [
    {
      id: NS,
      labelKey: `${NS}:settings.title`,
      hintKey: 'provider-ops:find.settingsHint',
      keywordsKey: 'provider-ops:find.settingsKeywords',
      component: ProviderSettings,
      order: 120,
      icon: 'brain',
      group: 'agents',
      optional: false,
      expert: true,
    },
  ],
  chatHeaderWidgets: [
    // the header pill only from 70 % on; the full meter is always in More › Context use
    { id: 'context-gauge', component: ContextGauge },
    { id: 'context-use', component: ContextUse, icon: 'gauge', labelKey: `${NS}:gauge.menu` },
  ],
  messageBlockRenderers: { 'provider-ops.notice': NoticeBlock },
};
export default mod;
