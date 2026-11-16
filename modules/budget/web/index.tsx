/** Budget (W32): spending by agent and model, the owner's price table, caps, the raise/keep card, portable agents. */
import type { DecisionItem, WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { MessageBlock } from '@pasabot/protocol';
import { Badge, Button, Card, Field, Segmented } from '@pasabot/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

type T = (k: string, o?: Record<string, unknown>) => string;
const translations = moduleTranslator(
  'budget',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
function useT(): T {
  return useModuleT(translations).t;
}

const API = '/api/m/budget';
/** the shell re-dispatches live events on window under this name (`LIVE_EVENT` in @pasabot/core/web) */
const LIVE_EVENT = 'pasabot:event';
/** Calls `fn` on every live event of one of these types (budget.cost after a run, budget.alert for cap cards). */
function useLive(types: readonly string[], fn: () => void) {
  const key = types.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-binds when the type list or the callback changes
  useEffect(() => {
    const on = (e: Event) => {
      const type = (e as CustomEvent<{ type?: string }>).detail?.type;
      if (type && key.split(',').includes(type)) fn();
    };
    window.addEventListener(LIVE_EVENT, on);
    return () => window.removeEventListener(LIVE_EVENT, on);
  }, [key, fn]);
}
class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP ${status}`);
  }
}
async function call<R>(path: string, init: RequestInit = {}): Promise<R> {
  const r = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new CallError(r.status, j.error ?? 'other');
  }
  return (await r.json()) as R;
}

interface Money {
  amount: number;
  currency: string;
}
interface Summary {
  totals: Money[];
  unpriced: { runs: number };
  agents: {
    agentId: string;
    name: string;
    runs: number;
    input: number;
    output: number;
    cache: number;
    costs: Money[];
    unpricedRuns: number;
  }[];
  models: {
    providerId: string;
    model: string;
    runs: number;
    input: number;
    output: number;
    cache: number;
    cost: Money | null;
  }[];
}
interface PriceRow {
  providerId: string;
  model: string;
  price: { inputPerM: number; outputPerM: number; cachedPerM: number; currency: string } | null;
}
type CapCell = { amount: number; currency: string; spent: number } | null;
interface Caps {
  global: { day: CapCell; month: CapCell };
  agents: { agentId: string; name: string; day: CapCell; month: CapCell }[];
  /** models whose spend no cap counts (no price in the caps' currency) */
  uncovered?: { providerId: string; model: string }[];
}

const grid = { display: 'grid', gap: 12 } as const;
const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const fmt = (n: number) => (Math.round(n * 10000) / 10000).toLocaleString(displayLocale());
const money = (m: Money) => `${fmt(m.amount)} ${m.currency}`;
/**
 * A total as an owner reads money: with its currency's sign ("$0.00", "₱12.50"), so a bare "0" never leaves her
 * guessing pesos, dollars or tokens. A code Intl does not know falls back to "0.7 XYZ".
 */
const cash = (m: Money) => {
  try {
    return new Intl.NumberFormat(displayLocale(), {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(m.amount);
  } catch {
    return money(m);
  }
};
/** the currency new prices start in (PriceForm's default), shown on a total of nothing */
const DEFAULT_CURRENCY = 'USD';

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
      aria-labelledby={`budget-${id}`}
      data-testid={`budget-${id}`}
      // the card's own padding keeps its heading off the rounded border
      style={{ ...grid, padding: 16, minWidth: 0 }}
    >
      <h2 id={`budget-${id}`} style={{ margin: 0, fontSize: 18 }}>
        {title}
      </h2>
      {intro && <p style={{ margin: 0, color: 'var(--bk-muted)' }}>{intro}</p>}
      {children}
    </Card>
  );
}

// ---------- spending ----------
function Spending({ t, tick }: { t: T; tick: number }) {
  const [period, setPeriod] = useState<'today' | 'month'>('today');
  const [s, setS] = useState<Summary | null>(null);
  /** the currency a total of nothing is shown in: the owner's first price, else the default */
  const [zeroIn, setZeroIn] = useState(DEFAULT_CURRENCY);
  const load = useCallback(() => {
    call<Summary>(`/summary?period=${period}`).then(setS, () => setS(null));
    call<{ prices: PriceRow[] }>('/prices').then(
      (r) => setZeroIn(r.prices.find((p) => p.price)?.price?.currency ?? DEFAULT_CURRENCY),
      () => {},
    );
  }, [period]);
  // a saved price (tick) or a run's booked cost changes the numbers: refetch, no reload needed (W39)
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the "a price was saved" signal
  useEffect(load, [load, tick]);
  useLive(['budget.cost'], load);
  const list = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 } as const;
  const item = { display: 'grid', gap: 2, overflowWrap: 'anywhere' } as const;
  return (
    <Section id="spend" title={t('spend.title')}>
      <Segmented
        label={t('spend.title')}
        value={period}
        options={[
          { value: 'today', label: t('spend.today') },
          { value: 'month', label: t('spend.month') },
        ]}
        onChange={(v) => setPeriod(v === 'month' ? 'month' : 'today')}
      />
      {s && (
        <>
          <p style={{ margin: 0, fontSize: 20 }} data-testid="budget-total">
            {t('spend.total')}:{' '}
            {s.totals.length ? s.totals.map(cash).join(' + ') : cash({ amount: 0, currency: zeroIn })}
          </p>
          {s.unpriced.runs > 0 && (
            <p style={{ margin: 0 }}>{t('spend.unpriced', { count: s.unpriced.runs })}</p>
          )}
          {s.agents.length === 0 && <p style={{ margin: 0 }}>{t('spend.none')}</p>}
          {s.agents.length > 0 && (
            <>
              <h3 style={{ margin: 0, fontSize: 16 }}>{t('spend.byAgent')}</h3>
              <ul style={list}>
                {s.agents.map((a) => (
                  <li key={a.agentId} style={item} data-testid="budget-agent">
                    <span style={row}>
                      <strong>{a.name}</strong>
                      <span>{a.costs.length ? a.costs.map(money).join(' + ') : t('spend.priceNotSet')}</span>
                    </span>
                    <span style={{ color: 'var(--bk-muted)' }}>
                      {t('spend.runs', { count: a.runs })} ·{' '}
                      {t('spend.tokens', { input: fmt(a.input), output: fmt(a.output), cache: fmt(a.cache) })}
                    </span>
                  </li>
                ))}
              </ul>
              <h3 style={{ margin: 0, fontSize: 16 }}>{t('spend.byModel')}</h3>
              <ul style={list}>
                {s.models.map((m) => (
                  <li key={`${m.providerId}/${m.model}`} style={item} data-testid="budget-model">
                    <span style={row}>
                      <strong>
                        {m.providerId} · {m.model || t('prices.default')}
                      </strong>
                      {m.cost ? (
                        <span>{money(m.cost)}</span>
                      ) : (
                        <Badge tone="outline">{t('spend.priceNotSet')}</Badge>
                      )}
                    </span>
                    <span style={{ color: 'var(--bk-muted)' }}>
                      {t('spend.runs', { count: m.runs })} ·{' '}
                      {t('spend.tokens', { input: fmt(m.input), output: fmt(m.output), cache: fmt(m.cache) })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Section>
  );
}

// ---------- price table ----------
function PriceForm({ t, r, onSaved }: { t: T; r: PriceRow; onSaved(rows: PriceRow[]): void }) {
  const [f, setF] = useState({
    inputPerM: String(r.price?.inputPerM ?? ''),
    outputPerM: String(r.price?.outputPerM ?? ''),
    cachedPerM: String(r.price?.cachedPerM ?? ''),
    currency: r.price?.currency ?? 'USD',
  });
  const [msg, setMsg] = useState('');
  const num = (v: string) => Number(v);
  const valid =
    [f.inputPerM, f.outputPerM, f.cachedPerM].every(
      (v) => v.trim() !== '' && Number.isFinite(num(v)) && num(v) >= 0,
    ) && /^[A-Z]{3}$/.test(f.currency);
  const save = async () => {
    try {
      const res = await call<{ prices: PriceRow[] }>('/prices', {
        method: 'PUT',
        body: JSON.stringify({
          providerId: r.providerId,
          model: r.model,
          inputPerM: num(f.inputPerM),
          outputPerM: num(f.outputPerM),
          cachedPerM: num(f.cachedPerM),
          currency: f.currency,
        }),
      });
      setMsg(t('prices.saved'));
      onSaved(res.prices);
    } catch (e) {
      setMsg(
        t(e instanceof CallError && e.code === 'currency_mismatch' ? 'caps.oneCurrency' : 'card.failed'),
      );
    }
  };
  const label = `${r.providerId} · ${r.model || t('prices.default')}`;
  const small = { flex: '1 1 120px', minWidth: 0 } as const;
  return (
    <li style={{ ...grid, gap: 8 }} data-testid="budget-price" data-model={r.model}>
      <span style={row}>
        <strong style={{ overflowWrap: 'anywhere' }}>{label}</strong>
        {!r.price && <Badge tone="outline">{t('spend.priceNotSet')}</Badge>}
      </span>
      <div style={{ ...row, alignItems: 'flex-end' }}>
        <div style={small}>
          <Field
            label={t('prices.input')}
            inputMode="decimal"
            value={f.inputPerM}
            onChange={(e) => setF({ ...f, inputPerM: e.currentTarget.value })}
          />
        </div>
        <div style={small}>
          <Field
            label={t('prices.output')}
            inputMode="decimal"
            value={f.outputPerM}
            onChange={(e) => setF({ ...f, outputPerM: e.currentTarget.value })}
          />
        </div>
        <div style={small}>
          <Field
            label={t('prices.cached')}
            inputMode="decimal"
            value={f.cachedPerM}
            onChange={(e) => setF({ ...f, cachedPerM: e.currentTarget.value })}
          />
        </div>
        <div style={{ flex: '0 1 100px', minWidth: 0 }}>
          <Field
            label={t('prices.currency')}
            maxLength={3}
            value={f.currency}
            onChange={(e) => setF({ ...f, currency: e.currentTarget.value.toUpperCase() })}
          />
        </div>
      </div>
      <span style={row}>
        <Button
          variant="primary"
          disabled={!valid}
          onClick={() => void save()}
          aria-label={`${t('prices.save')}: ${label}`}
        >
          {t('prices.save')}
        </Button>
        <span role="status">{msg}</span>
      </span>
    </li>
  );
}
function Prices({ t, onChanged }: { t: T; onChanged(): void }) {
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const saved = (next: PriceRow[]) => {
    setRows(next);
    onChanged();
  };
  const [adding, setAdding] = useState({ providerId: '', model: '' });
  /** pressed with no brain named: said next to that field, nothing is added */
  const [needBrain, setNeedBrain] = useState(false);
  useEffect(() => {
    call<{ prices: PriceRow[] }>('/prices').then(
      (r) => setRows(r.prices),
      () => setRows([]),
    );
  }, []);
  return (
    <Section id="prices" title={t('prices.title')} intro={t('prices.intro')}>
      {rows?.length === 0 && <p style={{ margin: 0 }}>{t('prices.empty')}</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
        {rows?.map((r) => (
          <PriceForm key={`${r.providerId}/${r.model}`} t={t} r={r} onSaved={saved} />
        ))}
      </ul>
      <div style={{ ...row, alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <Field
            label={t('prices.provider')}
            value={adding.providerId}
            maxLength={80}
            onChange={(e) => {
              setAdding({ ...adding, providerId: e.currentTarget.value });
              if (e.currentTarget.value.trim()) setNeedBrain(false);
            }}
            error={needBrain ? t('prices.providerMissing') : undefined}
          />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <Field
            label={t('prices.model')}
            value={adding.model}
            maxLength={200}
            onChange={(e) => setAdding({ ...adding, model: e.currentTarget.value })}
          />
        </div>
        <Button
          onClick={() => {
            if (!adding.providerId.trim()) return setNeedBrain(true);
            const r = { providerId: adding.providerId.trim(), model: adding.model.trim(), price: null };
            setRows((old) => [
              ...(old ?? []).filter((x) => x.providerId !== r.providerId || x.model !== r.model),
              r,
            ]);
            setAdding({ providerId: '', model: '' });
          }}
        >
          {t('prices.add')}
        </Button>
      </div>
    </Section>
  );
}

// ---------- caps ----------
function CapsSection({ t }: { t: T }) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState('USD');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    call<Caps>('/caps').then(
      (c) => {
        setCaps(c);
        const d: Record<string, string> = {};
        const put = (scope: string, cell: CapCell, period: string) => {
          d[`${scope}|${period}`] = cell ? String(cell.amount) : '';
          if (cell) setCurrency(cell.currency);
        };
        put('global', c.global.day, 'day');
        put('global', c.global.month, 'month');
        for (const a of c.agents) {
          put(a.agentId, a.day, 'day');
          put(a.agentId, a.month, 'month');
        }
        setDraft(d);
      },
      () => setCaps(null),
    );
  }, []);
  useEffect(load, [load]);
  if (!caps) return null;
  const save = async () => {
    try {
      const scopes = ['global', ...caps.agents.map((a) => a.agentId)];
      for (const scope of scopes)
        for (const period of ['day', 'month'] as const) {
          const v = (draft[`${scope}|${period}`] ?? '').trim();
          await call('/caps', {
            method: 'PUT',
            body: JSON.stringify({ scope, period, amount: v === '' ? null : Number(v), currency }),
          });
        }
      setMsg(t('caps.saved'));
      load();
    } catch (e) {
      setMsg(
        t(e instanceof CallError && e.code === 'currency_mismatch' ? 'caps.oneCurrency' : 'card.failed'),
      );
    }
  };
  const line = (scope: string, name: string, day: CapCell, month: CapCell) => (
    <li key={scope} style={{ ...grid, gap: 6 }} data-testid="budget-cap" data-scope={scope}>
      <strong style={{ overflowWrap: 'anywhere' }}>{name}</strong>
      <div style={{ ...row, alignItems: 'flex-end' }}>
        {(['day', 'month'] as const).map((period) => {
          const cell = period === 'day' ? day : month;
          return (
            <div key={period} style={{ flex: '1 1 140px', minWidth: 0 }}>
              <Field
                label={`${t(`caps.${period}`)} (${currency})`}
                inputMode="decimal"
                placeholder={t('caps.none')}
                hint={
                  cell
                    ? t('caps.spent', {
                        spent: fmt(cell.spent),
                        cap: fmt(cell.amount),
                        currency: cell.currency,
                      })
                    : undefined
                }
                value={draft[`${scope}|${period}`] ?? ''}
                onChange={(e) => setDraft({ ...draft, [`${scope}|${period}`]: e.currentTarget.value })}
              />
            </div>
          );
        })}
      </div>
    </li>
  );
  const valid = Object.values(draft).every(
    (v) => v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0),
  );
  return (
    <Section id="caps" title={t('caps.title')} intro={t('caps.intro')}>
      <div style={{ maxWidth: 140 }}>
        <Field
          label={t('prices.currency')}
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
        />
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 14 }}>
        {line('global', t('caps.everyone'), caps.global.day, caps.global.month)}
        {caps.agents.map((a) => line(a.agentId, a.name, a.day, a.month))}
      </ul>
      {!!caps.uncovered?.length && (
        <p style={{ margin: 0 }}>
          {t('caps.uncovered', {
            models: caps.uncovered
              .map((m) => `${m.providerId} · ${m.model || t('prices.default')}`)
              .join(', '),
          })}
        </p>
      )}
      <span style={row}>
        <Button
          variant="primary"
          disabled={!valid || !/^[A-Z]{3}$/.test(currency)}
          onClick={() => void save()}
        >
          {t('caps.save')}
        </Button>
        <span role="status">{msg}</span>
      </span>
    </Section>
  );
}

// ---------- portable agents ----------
function download(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Bundles({ t }: { t: T }) {
  const [agents, setAgents] = useState<{ agentId: string; name: string }[]>([]);
  const [agentId, setAgentId] = useState('');
  const [pass, setPass] = useState('');
  const [vault, setVault] = useState(false);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [inPass, setInPass] = useState('');
  const [result, setResult] = useState<{ name: string; chatIds: string[] } | null>(null);
  const [inMsg, setInMsg] = useState('');
  useEffect(() => {
    call<Caps>('/caps').then(
      (c) => {
        setAgents(c.agents);
        setAgentId((v) => v || c.agents[0]?.agentId || '');
      },
      () => {},
    );
  }, []);
  const err = (code: string) => t(`bundle.error.${code}`, { defaultValue: t('bundle.error.other') });
  const doExport = async () => {
    setMsg('');
    try {
      if (vault) {
        const r = await fetch('/api/v1/auth/reauth', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        if (!r.ok) throw new CallError(401, 'reauth_required');
      }
      const r = await fetch(`${API}/bundles/export`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, passphrase: pass, includeVault: vault }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new CallError(r.status, j.error ?? 'other');
      }
      const name =
        /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'agent.pasabot-agent';
      download(await r.blob(), name);
      setMsg(t('bundle.exported'));
    } catch (e) {
      setMsg(err(e instanceof CallError ? e.code : 'other'));
    }
  };
  const doImport = async () => {
    setInMsg('');
    setResult(null);
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await call<{ name: string; chatIds: string[] }>('/bundles/import', {
        method: 'POST',
        body: JSON.stringify({ data: btoa(bin), passphrase: inPass }),
      });
      setResult(r);
      setInMsg(t('bundle.imported', { name: r.name }));
    } catch (e) {
      setInMsg(err(e instanceof CallError ? e.code : 'other'));
    }
  };
  return (
    <Section id="bundle" title={t('bundle.title')} intro={t('bundle.intro')}>
      <label className="bk-field">
        <span className="bk-field__label">{t('bundle.agent')}</span>
        <select
          className="bk-input"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          style={{ minHeight: 44, maxWidth: '100%' }}
        >
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <Field
        label={t('bundle.passphrase')}
        hint={t('bundle.passphraseHint')}
        type="password"
        autoComplete="new-password"
        value={pass}
        onChange={(e) => setPass(e.currentTarget.value)}
      />
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44 }}>
        <input
          type="checkbox"
          style={{ width: 22, height: 22, flex: 'none' }}
          checked={vault}
          onChange={(e) => setVault(e.target.checked)}
        />
        <span>
          {t('bundle.vault')} <span style={{ color: 'var(--bk-muted)' }}>({t('bundle.vaultHint')})</span>
        </span>
      </label>
      {vault && (
        <Field
          label={t('bundle.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      )}
      <span style={row}>
        <Button variant="primary" disabled={!agentId || pass.length < 8} onClick={() => void doExport()}>
          {t('bundle.export')}
        </Button>
        <span role="status" data-testid="bundle-export-status">
          {msg}
        </span>
      </span>
      <hr style={{ width: '100%', border: 0, borderTop: '1px solid var(--bk-line)', margin: 0 }} />
      <label className="bk-field">
        <span className="bk-field__label">{t('bundle.file')}</span>
        <input
          type="file"
          className="bk-input"
          style={{ minHeight: 44, maxWidth: '100%' }}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <Field
        label={t('bundle.passphrase')}
        type="password"
        autoComplete="off"
        value={inPass}
        onChange={(e) => setInPass(e.currentTarget.value)}
      />
      <span style={row}>
        <Button disabled={!file || inPass.length < 8} onClick={() => void doImport()}>
          {t('bundle.import')}
        </Button>
        <span role="status" data-testid="bundle-import-status">
          {inMsg}
        </span>
        {result?.chatIds[0] && <a href={`#/chats/${result.chatIds[0]}`}>{t('bundle.open')}</a>}
      </span>
    </Section>
  );
}

function BudgetPage() {
  const t = useT();
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  return (
    <section
      data-slot="route"
      style={{
        display: 'grid',
        gap: 16,
        maxWidth: 860,
        paddingInline: 16,
        marginInline: 'auto',
        paddingBottom: 32,
      }}
    >
      <h1>{t('page.title')}</h1>
      <p style={{ margin: 0 }}>{t('page.intro')}</p>
      <Spending t={t} tick={tick} />
      <Prices t={t} onChanged={bump} />
      <CapsSection t={t} />
      <Bundles t={t} />
    </section>
  );
}

// ---------- the raise/keep card in a chat ----------
interface CardData {
  alertId: string;
  agentName: string;
  scope: 'agent' | 'global';
  period: 'day' | 'month';
  cap: number;
  spent: number;
  currency: string;
  reason: 'stopped' | 'reached' | 'held' | 'skipped';
  state: 'open' | 'raised' | 'kept';
  newCap?: number;
}
export function CapCard({ block }: { block: MessageBlock }) {
  const t = useT();
  const c = block.data as CardData;
  const [amount, setAmount] = useState(String(Math.max(c.cap * 2, c.spent + c.cap)));
  const [state, setState] = useState(c.state);
  const [newCap, setNewCap] = useState(c.newCap);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    setState(c.state);
    setNewCap(c.newCap);
  }, [c.state, c.newCap]);
  const who = c.scope === 'global' ? t('card.who.global') : t('card.who.agent', { name: c.agentName });
  const head = t('card.reached', {
    who,
    period: t(`card.period.${c.period}`),
    spent: fmt(c.spent),
    cap: fmt(c.cap),
    currency: c.currency,
  });
  const tail =
    c.reason === 'stopped'
      ? t('card.stopped', { name: c.agentName })
      : c.reason === 'held'
        ? t('card.held')
        : c.reason === 'skipped'
          ? t('card.skipped')
          : '';
  const decide = async (what: 'raise' | 'keep') => {
    try {
      const r = await call<{ state: 'raised' | 'kept'; cap: { amount: number } | null }>(
        `/alerts/${encodeURIComponent(c.alertId)}/${what}`,
        { method: 'POST', ...(what === 'raise' ? { body: JSON.stringify({ amount: Number(amount) }) } : {}) },
      );
      setState(r.state);
      if (r.state === 'raised') setNewCap(r.cap?.amount);
      setMsg('');
    } catch {
      setMsg(t('card.failed'));
    }
  };
  return (
    <Card
      as="article"
      data-testid="budget-cap-card"
      data-state={state}
      style={{ ...grid, gap: 10, maxWidth: '100%' }}
    >
      <p style={{ margin: 0, overflowWrap: 'anywhere' }}>
        <strong>{head}</strong> {tail}
      </p>
      {state === 'open' ? (
        <>
          <p style={{ margin: 0 }}>{t('card.ask')}</p>
          <div style={{ ...row, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 140px', minWidth: 0 }}>
              <Field
                label={t('card.newCap', { currency: c.currency })}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.currentTarget.value)}
              />
            </div>
            <Button
              variant="primary"
              disabled={!(Number(amount) > c.cap)}
              onClick={() => void decide('raise')}
            >
              {t('card.raise')}
            </Button>
            <Button onClick={() => void decide('keep')}>{t('card.keep')}</Button>
          </div>
          {msg && (
            <p role="alert" style={{ margin: 0 }}>
              {msg}
            </p>
          )}
        </>
      ) : (
        <p style={{ margin: 0 }} role="status">
          {state === 'raised'
            ? t('card.raised', { cap: fmt(newCap ?? c.cap), currency: c.currency })
            : t('card.kept', { cap: fmt(c.cap), currency: c.currency })}
        </p>
      )}
    </Card>
  );
}

// ---------- the pinned decision bar (W39) ----------
interface OpenAlert extends CardData {
  chatId: string | null;
}
/** Open cap cards for the owner's one decision bar: answerable in its Review list, or opened in their chat. */
function useCapDecisions(): DecisionItem[] {
  const t = useT();
  const [alerts, setAlerts] = useState<OpenAlert[]>([]);
  const load = useCallback(() => {
    call<{ alerts: OpenAlert[] }>('/alerts').then(
      (r) => setAlerts(r.alerts),
      () => {},
    );
  }, []);
  useEffect(() => {
    load();
    // a missed live event (a reconnect) is caught up within a minute
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  useLive(['budget.alert'], load);
  return useMemo(
    () =>
      alerts.map((a) => {
        const who = a.scope === 'global' ? t('card.who.global') : t('card.who.agent', { name: a.agentName });
        const block = { kind: 'budget.cap', v: 1, data: a } as unknown as MessageBlock;
        return {
          id: `budget:${a.alertId}`,
          title: t('card.reached', {
            who,
            period: t(`card.period.${a.period}`),
            spent: fmt(a.spent),
            cap: fmt(a.cap),
            currency: a.currency,
          }),
          text: t('card.ask'),
          href: a.chatId ? `#/chats/${a.chatId}` : '#/budget',
          review: () => <CapCard block={block} />,
        };
      }),
    [alerts, t],
  );
}

const mod: WebModule = {
  id: 'budget',
  routes: [{ path: '/budget', component: BudgetPage, titleKey: 'budget:page.title' }],
  navItems: [
    {
      id: 'budget',
      labelKey: 'budget:nav',
      hintKey: 'budget:find.navHint',
      keywordsKey: 'budget:find.navKeywords',
      to: '/budget',
      icon: 'wallet',
      group: 'spending',
      order: 760,
    },
  ],
  messageBlockRenderers: { 'budget.cap': CapCard },
  decisionSources: [{ id: 'budget-caps', useItems: useCapDecisions }],
};
export default mod;
