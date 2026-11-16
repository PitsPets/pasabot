/**
 * Budgets and portable agents (W32).
 *
 * Costs: every finished run's `usage` (tokens) is booked per agent, provider, model and task; the money comes from
 * the owner's price table at read time. A model without a price is "price not set" and adds no number, never a guess.
 *
 * Caps: hard caps per agent and global, per day and per month, in one currency each. A queue gate (core
 * `QueueService.addGate`) holds new work for a capped agent until the period resets (a routine fire is refused, so
 * the routines module records it `skipped`, and so is a step of a workflow a routine started); a run whose spend
 * crosses a cap mid-turn is cancelled after a short grace (a turn whose answer is already in is never cut). Real CLIs
 * report `usage` once, at the end of the turn, so a live run's spend is the larger of its last usage and an estimate
 * from what it streamed (text, thinking, tool calls and results, ~4 characters a token); a run that never reports
 * usage is booked at that estimate (`estimated`). Caps and prices share one currency. Either way a `budget.cap` card in the chat asks the
 * owner to raise the cap or keep it; only an owner session can do either (agents never reach these routes).
 *
 * Portable agents: one encrypted file (bundle.ts) with the W19 agent export (through the AgentAdmin port), its own
 * memory items, its workspace files (synced skills included) and, only when the owner opts in with a fresh re-auth,
 * its vault entries. Import always creates a new agent (a name clash gets a suffix) at no more than the server's
 * default trust; every path and the whole file are checked before anything is written.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type QueueGateVerdict,
  SKILL_SYNC_MARKER,
  ulid,
} from '@pasabot/core';
import { minTrust, type RunDTO, type RunEventDTO, type TrustLevel } from '@pasabot/protocol';
import { z } from 'zod';
import {
  BundleError,
  type BundlePayload,
  checkEntryPath,
  checkEntrySet,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILES,
  openBundle,
  sealBundle,
} from './bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
export const CAP_KIND = 'budget.cap';

export type Period = 'day' | 'month';
export interface Money {
  amount: number;
  currency: string;
}
export interface CostEvent {
  runId: string;
  agentId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  /** null = no price for this provider/model ("price not set") */
  cost: Money | null;
}
export interface CapCard {
  alertId: string;
  agentId: string;
  agentName: string;
  scope: 'agent' | 'global';
  period: Period;
  cap: number;
  spent: number;
  currency: string;
  /** stopped = a run was cut; reached = a run ended at the cap; held = work waits; skipped = a routine fire */
  reason: 'stopped' | 'reached' | 'held' | 'skipped';
  state: 'open' | 'raised' | 'kept';
  newCap?: number;
}

declare module '@pasabot/protocol' {
  interface EventMap {
    /** a finished run's tokens and money (W31 receipts read it), on `agent:<id>` */
    'budget.cost': CostEvent;
    /** a cap card opened or was decided, on `owner` (the pinned decision bar refetches, W39) */
    'budget.alert': { id: string; state: 'open' | 'raised' | 'kept' };
  }
}

const capCardSchema = z.object({
  alertId: z.string().max(40),
  agentId: z.string().max(40),
  agentName: z.string().max(80),
  scope: z.enum(['agent', 'global']),
  period: z.enum(['day', 'month']),
  cap: z.number(),
  spent: z.number(),
  currency: z.string().max(8),
  reason: z.enum(['stopped', 'reached', 'held', 'skipped']),
  state: z.enum(['open', 'raised', 'kept']),
  newCap: z.number().optional(),
});

// ---------- periods (server local time) ----------
export function periodStart(period: Period, now: number): number {
  const d = new Date(now);
  if (period === 'month') d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function periodEnd(period: Period, now: number): number {
  const d = new Date(periodStart(period, now));
  if (period === 'day') d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

interface PriceRow {
  provider_id: string;
  model: string;
  input_per_m: number;
  output_per_m: number;
  cached_per_m: number;
  currency: string;
  updated_at: number;
}
interface UsageRow {
  run_id: string;
  queue_item_id: string | null;
  agent_id: string;
  chat_id: string | null;
  provider_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  state: string | null;
  estimated: number;
  at: number;
}
interface CapRow {
  scope: string;
  period: Period;
  amount: number;
  currency: string;
}
interface AlertRow {
  id: string;
  scope: string;
  period: Period;
  period_start: number;
  agent_id: string;
  chat_id: string | null;
  message_id: string | null;
  cap: number;
  spent: number;
  currency: string;
  reason: CapCard['reason'];
  state: CapCard['state'];
}
interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
}
interface Inflight {
  runId: string;
  itemId: string;
  agentId: string;
  providerId: string;
  model: string;
  /** the last cumulative `usage` the provider reported (most adapters report once, at the end of the turn) */
  usage: Tokens | null;
  /** what the run has streamed so far, in characters: the floor of its spend while no (or an older) usage is in */
  est: { inputChars: number; outputChars: number; textChars: number };
  /** the turn produced its final answer (or `done`) and nothing since: a cap crossed now is not cut */
  finished: boolean;
  lastCheck: number;
  stopping: Hit | null;
  timer: NodeJS.Timeout | null;
}
/** ~4 characters per token: a deliberately rough floor for a run that has not reported its usage yet */
const CHARS_PER_TOKEN = 4;
/** live text deltas re-check the caps at most this often per run (run events always re-check) */
const DELTA_CHECK_MS = 200;
export interface Hit {
  scope: 'agent' | 'global';
  period: Period;
  cap: number;
  spent: number;
  currency: string;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const tokens = (u: unknown): Tokens | null => {
  const o = u as Partial<Tokens> | null;
  if (!o || typeof o.inputTokens !== 'number' || typeof o.outputTokens !== 'number') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return { inputTokens: n(o.inputTokens), outputTokens: n(o.outputTokens), cacheTokens: n(o.cacheTokens) };
};

export interface BudgetOptions {
  now?: () => number;
  /** how long a run that crossed a cap may still end by itself before it is cancelled (ms) */
  stopGraceMs?: number;
  /** scrypt cost for exports (tests); readers always take the file's own header */
  bundleKdf?: { N: number; r: 8; p: number };
}

export class Budget {
  readonly now: () => number;
  private inflight = new Map<string, Inflight>();
  private graceMs: number;
  constructor(
    private readonly app: ModuleHost,
    private readonly o: BudgetOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.graceMs = o.stopGraceMs ?? 300;
  }

  // ---------- prices ----------
  prices(): PriceRow[] {
    return this.app.raw.prepare('SELECT * FROM budget_price ORDER BY provider_id, model').all() as PriceRow[];
  }
  private price(providerId: string, model: string): PriceRow | null {
    return (
      (this.app.raw
        .prepare('SELECT * FROM budget_price WHERE provider_id = ? AND model = ?')
        .get(providerId, model) as PriceRow | undefined) ?? null
    );
  }
  costOf(providerId: string, model: string, t: Tokens): Money | null {
    const p = this.price(providerId, model);
    if (!p) return null;
    return {
      amount: round(
        (t.inputTokens * p.input_per_m + t.outputTokens * p.output_per_m + t.cacheTokens * p.cached_per_m) /
          1e6,
      ),
      currency: p.currency,
    };
  }
  setPrice(p: {
    providerId: string;
    model: string;
    inputPerM: number;
    outputPerM: number;
    cachedPerM: number;
    currency: string;
  }) {
    const capped = this.capCurrency();
    if (capped && capped !== p.currency)
      throw new HttpError(
        409,
        `caps are in ${capped}: prices must use the same currency, or that model's spend would never count`,
        'currency_mismatch',
      );
    this.app.raw
      .prepare(
        `INSERT INTO budget_price (provider_id, model, input_per_m, output_per_m, cached_per_m, currency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider_id, model) DO UPDATE SET input_per_m = excluded.input_per_m,
         output_per_m = excluded.output_per_m, cached_per_m = excluded.cached_per_m, currency = excluded.currency,
         updated_at = excluded.updated_at`,
      )
      .run(p.providerId, p.model, p.inputPerM, p.outputPerM, p.cachedPerM, p.currency, this.now());
  }
  removePrice(providerId: string, model: string): boolean {
    return (
      this.app.raw
        .prepare('DELETE FROM budget_price WHERE provider_id = ? AND model = ?')
        .run(providerId, model).changes > 0
    );
  }
  /** every provider/model seen in usage or priced, with its price or none */
  priceTable() {
    const seen = this.app.raw
      .prepare('SELECT DISTINCT provider_id, model FROM budget_usage ORDER BY provider_id, model')
      .all() as { provider_id: string; model: string }[];
    const rows = new Map<string, { providerId: string; model: string; price: PriceRow | null }>();
    for (const s of seen)
      rows.set(`${s.provider_id}\u0000${s.model}`, {
        providerId: s.provider_id,
        model: s.model,
        price: null,
      });
    for (const p of this.prices())
      rows.set(`${p.provider_id}\u0000${p.model}`, { providerId: p.provider_id, model: p.model, price: p });
    return [...rows.values()].map((r) => ({
      providerId: r.providerId,
      model: r.model,
      price: r.price
        ? {
            inputPerM: r.price.input_per_m,
            outputPerM: r.price.output_per_m,
            cachedPerM: r.price.cached_per_m,
            currency: r.price.currency,
          }
        : null,
    }));
  }

  // ---------- usage ----------
  onRunStarted(run: RunDTO) {
    this.inflight.set(run.id, {
      runId: run.id,
      itemId: run.queueItemId,
      agentId: run.agentId,
      providerId: run.providerId,
      model: run.model ?? '',
      usage: null,
      est: { inputChars: 0, outputChars: 0, textChars: 0 },
      finished: false,
      lastCheck: 0,
      stopping: null,
      timer: null,
    });
  }
  /**
   * The run's spend so far: per field the larger of its last reported usage and the estimate from what it streamed.
   * Real adapters report `usage` once, at the end of the turn, so without the estimate a run would spend nothing
   * until it is over and a cap could never stop it mid-task.
   */
  private liveUsage(r: Inflight): Tokens | null {
    const ein = Math.ceil(r.est.inputChars / CHARS_PER_TOKEN);
    const eout = Math.ceil((r.est.outputChars + r.est.textChars) / CHARS_PER_TOKEN);
    if (!r.usage && !ein && !eout) return null;
    const u = r.usage ?? { inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
    return {
      inputTokens: Math.max(u.inputTokens, ein),
      outputTokens: Math.max(u.outputTokens, eout),
      cacheTokens: u.cacheTokens,
    };
  }
  /** a live reply's text so far (`message.delta`, cumulative): the run's visible output grows */
  onDelta(d: { runId?: unknown; text?: unknown }) {
    const r = typeof d?.runId === 'string' ? this.inflight.get(d.runId) : undefined;
    if (!r || typeof d.text !== 'string' || d.text.length <= r.est.textChars) return;
    r.est.textChars = d.text.length;
    r.finished = false;
    const now = Date.now();
    if (now - r.lastCheck < DELTA_CHECK_MS) return;
    this.check(r);
  }
  /** a run event while the run is live: its spend grows (usage or estimate); past a cap it is stopped */
  onRunEvent(ev: RunEventDTO) {
    const r = this.inflight.get(ev.runId);
    if (!r) return;
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const len = (v: unknown) => (typeof v === 'string' ? v.length : (JSON.stringify(v ?? '')?.length ?? 0));
    switch (ev.type) {
      case 'usage':
        r.usage = tokens(d) ?? r.usage;
        break;
      case 'thinking':
        r.est.outputChars += len(d.text);
        r.finished = false;
        break;
      case 'tool.call':
        r.est.outputChars += len(d.name) + len(d.input);
        r.finished = false;
        break;
      case 'tool.result':
        r.est.inputChars += len(d.summary);
        r.finished = false;
        break;
      case 'text.final':
        // the answer is in: a provider's closing usage arrives now, and the CLI may take a while to exit
        r.est.textChars = Math.max(r.est.textChars, len(d.text));
        r.finished = true;
        break;
      case 'done':
        r.finished = true;
        break;
      default:
        return;
    }
    this.check(r);
  }
  /** past a cap, an unfinished run gets a short grace to end by itself, then it is cancelled */
  private check(r: Inflight) {
    r.lastCheck = Date.now();
    if (r.stopping || r.finished) return;
    const hit = this.hit(r.agentId);
    if (!hit) return;
    r.stopping = hit;
    r.timer = setTimeout(() => {
      r.timer = null;
      if (this.inflight.get(r.runId) !== r) return;
      // the turn finished inside the grace (its answer is in, the CLI is still exiting): never cut a finished turn;
      // it gets the "reached" card when it ends, and new activity (a steered answer) is checked again
      if (r.finished) {
        r.stopping = null;
        return;
      }
      this.app.queue.cancel(r.itemId);
    }, this.graceMs);
    r.timer.unref?.();
  }
  async onRunFinished(run: RunDTO) {
    const live = this.inflight.get(run.id);
    if (live?.timer) clearTimeout(live.timer);
    this.inflight.delete(run.id);
    // a run that never reported usage (cancelled, crashed, interrupted, failed early) is booked at its estimate
    const reported = tokens(run.usage);
    const t = reported ?? (live ? this.liveUsage(live) : null);
    const estimated = !reported && !!t;
    const model = run.model ?? '';
    const chatId = this.app.chats.runChat(run.id);
    if (t) {
      this.app.raw
        .prepare(
          `INSERT OR IGNORE INTO budget_usage (run_id, queue_item_id, agent_id, chat_id, provider_id, model,
           input_tokens, output_tokens, cache_tokens, state, estimated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.queueItemId,
          run.agentId,
          chatId,
          run.providerId,
          model,
          t.inputTokens,
          t.outputTokens,
          t.cacheTokens,
          run.state,
          estimated ? 1 : 0,
          run.finishedAt ?? this.now(),
        );
      const cost: CostEvent = {
        runId: run.id,
        agentId: run.agentId,
        providerId: run.providerId,
        model,
        ...t,
        cost: this.costOf(run.providerId, model, t),
      };
      this.app.bus.publish(`agent:${run.agentId}`, 'budget.cost', cost);
    }
    // a cap reached by this run: a cut run gets the "stopped" card, one that ended by itself the "reached" card
    const hit = live?.stopping ?? (t ? this.hit(run.agentId) : null);
    if (hit) {
      await this.alert(
        hit,
        run.agentId,
        chatId,
        run.state === 'cancelled' && live?.stopping ? 'stopped' : 'reached',
      );
    }
  }

  private rowsSince(from: number, agentId?: string) {
    return this.app.raw
      .prepare(
        `SELECT u.*, p.input_per_m, p.output_per_m, p.cached_per_m, p.currency FROM budget_usage u
         LEFT JOIN budget_price p ON p.provider_id = u.provider_id AND p.model = u.model
         WHERE u.at >= ? ${agentId ? 'AND u.agent_id = ?' : ''} ORDER BY u.at`,
      )
      .all(...(agentId ? [from, agentId] : [from])) as (UsageRow & {
      input_per_m: number | null;
      output_per_m: number | null;
      cached_per_m: number | null;
      currency: string | null;
    })[];
  }
  /** priced spend in `currency` for an agent (or everyone) since the period start, live runs included */
  spent(agentId: string | null, period: Period, currency: string): number {
    const from = periodStart(period, this.now());
    let sum = 0;
    for (const r of this.rowsSince(from, agentId ?? undefined)) {
      if (r.currency !== currency) continue;
      sum +=
        (r.input_tokens * (r.input_per_m ?? 0) +
          r.output_tokens * (r.output_per_m ?? 0) +
          r.cache_tokens * (r.cached_per_m ?? 0)) /
        1e6;
    }
    for (const f of this.inflight.values()) {
      if (agentId && f.agentId !== agentId) continue;
      const u = this.liveUsage(f);
      const c = u && this.costOf(f.providerId, f.model, u);
      if (c && c.currency === currency) sum += c.amount;
    }
    return round(sum);
  }
  /**
   * Spend no cap can count: models used this month (or running now) with no price, or priced in another currency
   * than the caps. Prices and caps share one currency (setPrice / setCap refuse a second one), so in practice this is
   * the unpriced models; the caps page lists them.
   */
  uncovered(currency: string): { providerId: string; model: string }[] {
    const out = new Map<string, { providerId: string; model: string }>();
    const add = (providerId: string, model: string) => {
      const p = this.price(providerId, model);
      if (!p || p.currency !== currency) out.set(`${providerId}\u0000${model}`, { providerId, model });
    };
    for (const r of this.rowsSince(periodStart('month', this.now()))) add(r.provider_id, r.model);
    for (const f of this.inflight.values()) add(f.providerId, f.model);
    return [...out.values()];
  }
  /** the one currency prices and caps must share once a cap exists (the first cap's), or null with no caps */
  private capCurrency(except?: { scope: string; period: Period }): string | null {
    for (const c of this.caps())
      if (!except || c.scope !== except.scope || c.period !== except.period) return c.currency;
    return null;
  }

  // ---------- caps ----------
  caps(): CapRow[] {
    return this.app.raw.prepare('SELECT scope, period, amount, currency FROM budget_cap').all() as CapRow[];
  }
  cap(scope: string, period: Period): CapRow | null {
    return (
      (this.app.raw
        .prepare('SELECT scope, period, amount, currency FROM budget_cap WHERE scope = ? AND period = ?')
        .get(scope, period) as CapRow | undefined) ?? null
    );
  }
  setCap(scope: string, period: Period, v: Money | null) {
    if (v !== null) {
      // a cap counts only spend priced in its own currency: one currency for every cap and every price, or the
      // work on a model priced in another currency would never count toward any cap
      const other = this.capCurrency({ scope, period });
      const priced = this.prices().find((p) => p.currency !== v.currency);
      if ((other && other !== v.currency) || priced)
        throw new HttpError(
          409,
          `caps and prices must use one currency (${other ?? priced?.currency}); change them all first`,
          'currency_mismatch',
        );
    }
    if (v === null)
      this.app.raw.prepare('DELETE FROM budget_cap WHERE scope = ? AND period = ?').run(scope, period);
    else
      this.app.raw
        .prepare(
          `INSERT INTO budget_cap (scope, period, amount, currency, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (scope, period) DO UPDATE SET amount = excluded.amount, currency = excluded.currency,
           updated_at = excluded.updated_at`,
        )
        .run(scope, period, v.amount, v.currency, this.now());
  }
  /** the first cap this agent's work has reached (agent day, agent month, global day, global month), or null */
  hit(agentId: string): Hit | null {
    for (const [scope, key] of [
      ['agent', agentId],
      ['global', 'global'],
    ] as const) {
      for (const period of ['day', 'month'] as const) {
        const c = this.cap(key, period);
        if (!c) continue;
        const spent = this.spent(scope === 'agent' ? agentId : null, period, c.currency);
        if (spent >= c.amount) return { scope, period, cap: c.amount, spent, currency: c.currency };
      }
    }
    return null;
  }
  /** a workflow step item of a run a routine started: at the cap it is refused like the routine's own item */
  private routineWorkflow(item: { kind: string; payload?: unknown }): boolean {
    if (item.kind !== 'workflow') return false;
    const runId = (item.payload as { workflowRunId?: unknown } | null)?.workflowRunId;
    if (typeof runId !== 'string') return false;
    return this.app.flows.get()?.runState(runId)?.startedBy?.startsWith('routine:') ?? false;
  }
  /**
   * The queue gate: capped work waits until the period resets; a routine fire is refused (recorded as skipped), and
   * so is a step of a workflow a routine started (its run, and the fire with it, end with the budget reason).
   */
  gate(item: { agentId: string; chatId: string | null; kind: string; payload?: unknown }): QueueGateVerdict {
    const hit = this.hit(item.agentId);
    if (!hit) return null;
    const reason = `budget: ${hit.scope === 'global' ? 'global' : 'agent'} ${hit.period === 'day' ? 'daily' : 'monthly'} cap reached (${hit.spent} of ${hit.cap} ${hit.currency})`;
    const routine = item.kind === 'routine' || this.routineWorkflow(item);
    void this.alert(hit, item.agentId, routine ? null : item.chatId, routine ? 'skipped' : 'held');
    return routine ? { refuse: reason } : { hold: { until: periodEnd(hit.period, this.now()), reason } };
  }

  // ---------- alerts + the raise/keep card ----------
  private alertScope(hit: Hit, agentId: string) {
    return hit.scope === 'global' ? 'global' : agentId;
  }
  private async alert(hit: Hit, agentId: string, chatId: string | null, reason: CapCard['reason']) {
    try {
      const scope = this.alertScope(hit, agentId);
      const start = periodStart(hit.period, this.now());
      // one open card per cap, period and agent; a cut run always says so
      const open = this.app.raw
        .prepare(
          "SELECT * FROM budget_alert WHERE scope = ? AND period = ? AND period_start = ? AND agent_id = ? AND state = 'open'",
        )
        .get(scope, hit.period, start, agentId) as AlertRow | undefined;
      if (open && reason !== 'stopped') return;
      const agent = await this.app.agents.get(agentId);
      const id = ulid();
      const card: CapCard = {
        alertId: id,
        agentId,
        agentName: agent?.name ?? agentId,
        scope: hit.scope,
        period: hit.period,
        cap: hit.cap,
        spent: hit.spent,
        currency: hit.currency,
        reason,
        state: 'open',
      };
      let messageId: string | null = null;
      if (chatId) {
        const m = this.app.chats.post(asSystem('budget: cap reached card'), {
          chatId,
          authorKind: 'system',
          authorId: null,
          body: capText(card, (k, p) => this.app.i18n.t(`budget:server.${k}`, p)),
          blocks: [{ kind: CAP_KIND, v: 1, data: card }],
        });
        messageId = m.id;
      }
      this.app.raw
        .prepare(
          `INSERT INTO budget_alert (id, scope, period, period_start, agent_id, chat_id, message_id, cap, spent, currency,
           reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          id,
          scope,
          hit.period,
          start,
          agentId,
          chatId,
          messageId,
          hit.cap,
          hit.spent,
          hit.currency,
          reason,
          this.now(),
        );
      // the owner's pinned decision bar (W39) refreshes its list of open cap cards
      this.app.bus.publish('owner', 'budget.alert', { id, state: 'open' });
      if (!open)
        void this.app.notifier
          .notify({
            level: 'warn',
            title: capText(card),
            msg: { title: capMsg(card) },
            ...(chatId ? { href: `/chats/${chatId}` } : {}),
          })
          .catch(() => {});
    } catch (e) {
      this.app.log.warn('budget alert not posted', { error: (e as Error).message });
    }
  }
  alertRow(id: string): AlertRow | null {
    return (this.app.raw.prepare('SELECT * FROM budget_alert WHERE id = ?').get(id) as AlertRow) ?? null;
  }
  /** The owner's answer on a card: raise the cap (to more than it is) or keep it. Every open card of that cap settles. */
  async decide(alertId: string, d: { raise: number } | { keep: true }) {
    const a = this.alertRow(alertId);
    if (!a) throw new HttpError(404, 'card not found', 'not_found');
    if (a.state !== 'open') throw new HttpError(409, 'already decided', 'decided');
    const current = this.cap(a.scope, a.period);
    if ('raise' in d) {
      const base = current?.amount ?? a.cap;
      if (!(d.raise > base))
        throw new HttpError(400, 'the new cap must be higher than the current one', 'not_a_raise');
      this.setCap(a.scope, a.period, { amount: d.raise, currency: current?.currency ?? a.currency });
    }
    const state = 'raise' in d ? 'raised' : 'kept';
    const open = this.app.raw
      .prepare("SELECT * FROM budget_alert WHERE scope = ? AND period = ? AND state = 'open'")
      .all(a.scope, a.period) as AlertRow[];
    for (const o of open) {
      this.app.raw
        .prepare('UPDATE budget_alert SET state = ?, decided_at = ? WHERE id = ?')
        .run(state, this.now(), o.id);
      if (!o.message_id) continue;
      const agent = await this.app.agents.get(o.agent_id);
      const card: CapCard = {
        alertId: o.id,
        agentId: o.agent_id,
        agentName: agent?.name ?? o.agent_id,
        scope: o.scope === 'global' ? 'global' : 'agent',
        period: o.period,
        cap: o.cap,
        spent: o.spent,
        currency: o.currency,
        reason: o.reason,
        state,
        ...('raise' in d ? { newCap: d.raise } : {}),
      };
      try {
        this.app.chats.updateBlocks(asSystem('budget: the owner decided a cap card'), o.message_id, [
          { kind: CAP_KIND, v: 1, data: card },
        ]);
      } catch (e) {
        this.app.log.warn('budget card not updated', { error: (e as Error).message });
      }
    }
    this.app.bus.publish('owner', 'budget.alert', { id: alertId, state });
    if ('raise' in d) await this.release(a.scope === 'global' ? null : a.scope);
    return { state, cap: this.cap(a.scope, a.period) };
  }
  /** Open cap cards, oldest first (the owner's pinned decision bar lists them, W39). */
  openAlerts(): AlertRow[] {
    return this.app.raw
      .prepare("SELECT * FROM budget_alert WHERE state = 'open' ORDER BY created_at, id")
      .all() as AlertRow[];
  }
  /** budget-held work goes back to the queue now; the gate checks it again before it runs */
  async release(agentId: string | null) {
    const ids = agentId ? [agentId] : (await this.app.agents.list()).map((a) => a.id);
    let n = 0;
    for (const id of ids)
      for (const it of this.app.queue.list(id))
        if (it.state === 'held' && it.error?.startsWith('budget:')) {
          this.app.queue.hold(it.id, Date.now(), it.error);
          n++;
        }
    return n;
  }

  // ---------- views ----------
  summary(period: 'today' | 'month') {
    const from = periodStart(period === 'today' ? 'day' : 'month', this.now());
    const rows = this.rowsSince(from);
    type Agg = { runs: number; input: number; output: number; cache: number };
    const agents = new Map<string, Agg & { costs: Map<string, number>; unpricedRuns: number }>();
    const models = new Map<string, Agg & { providerId: string; model: string; cost: Money | null }>();
    const totals = new Map<string, number>();
    const unpriced = { runs: 0, input: 0, output: 0, cache: 0 };
    for (const r of rows) {
      const t = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheTokens: r.cache_tokens };
      const c =
        r.currency === null
          ? null
          : {
              amount:
                (t.inputTokens * (r.input_per_m ?? 0) +
                  t.outputTokens * (r.output_per_m ?? 0) +
                  t.cacheTokens * (r.cached_per_m ?? 0)) /
                1e6,
              currency: r.currency,
            };
      const a = agents.get(r.agent_id) ?? {
        runs: 0,
        input: 0,
        output: 0,
        cache: 0,
        costs: new Map<string, number>(),
        unpricedRuns: 0,
      };
      a.runs++;
      a.input += t.inputTokens;
      a.output += t.outputTokens;
      a.cache += t.cacheTokens;
      if (c) a.costs.set(c.currency, (a.costs.get(c.currency) ?? 0) + c.amount);
      else a.unpricedRuns++;
      agents.set(r.agent_id, a);
      const key = `${r.provider_id}\u0000${r.model}`;
      const m = models.get(key) ?? {
        providerId: r.provider_id,
        model: r.model,
        runs: 0,
        input: 0,
        output: 0,
        cache: 0,
        cost: c ? { amount: 0, currency: c.currency } : null,
      };
      m.runs++;
      m.input += t.inputTokens;
      m.output += t.outputTokens;
      m.cache += t.cacheTokens;
      if (c && m.cost) m.cost.amount += c.amount;
      models.set(key, m);
      if (c) totals.set(c.currency, (totals.get(c.currency) ?? 0) + c.amount);
      else {
        unpriced.runs++;
        unpriced.input += t.inputTokens;
        unpriced.output += t.outputTokens;
        unpriced.cache += t.cacheTokens;
      }
    }
    const money = (m: Map<string, number>) =>
      [...m].map(([currency, amount]) => ({ currency, amount: round(amount) }));
    return {
      period,
      from,
      totals: money(totals),
      unpriced,
      agents: [...agents].map(([agentId, a]) => ({
        agentId,
        runs: a.runs,
        input: a.input,
        output: a.output,
        cache: a.cache,
        costs: money(a.costs),
        unpricedRuns: a.unpricedRuns,
      })),
      models: [...models.values()].map((m) => ({
        ...m,
        cost: m.cost ? { currency: m.cost.currency, amount: round(m.cost.amount) } : null,
      })),
    };
  }
  tasks(limit: number) {
    const rows = this.app.raw
      .prepare('SELECT * FROM budget_usage ORDER BY at DESC, run_id DESC LIMIT ?')
      .all(limit) as UsageRow[];
    return rows.map((r) => ({
      runId: r.run_id,
      agentId: r.agent_id,
      chatId: r.chat_id,
      providerId: r.provider_id,
      model: r.model,
      state: r.state,
      estimated: r.estimated === 1,
      at: r.at,
      input: r.input_tokens,
      output: r.output_tokens,
      cache: r.cache_tokens,
      cost: this.costOf(r.provider_id, r.model, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheTokens: r.cache_tokens,
      }),
    }));
  }

  // ---------- portable agents ----------
  async exportAgent(
    actor: { kind: 'user'; id: string },
    agentId: string,
    passphrase: string,
    includeVault: boolean,
  ) {
    const agent = await this.app.agents.get(agentId);
    const base = agent ? this.app.agentAdmin.exportBundle(actor, agentId) : null;
    if (!agent || !base) throw new HttpError(404, 'agent not found', 'not_found');
    const memory: BundlePayload['memory'] = [];
    // W33: with the memory module loaded its export port carries the agent's private scope with provenance; the raw
    // backend listing is the fallback for a server without it (never both: the same items would import twice)
    const poolPort = this.app.memory.pool();
    const pool = poolPort ? await poolPort.exportAgent(actor, agentId) : undefined;
    for (const b of pool ? [] : this.app.memory.list()) {
      try {
        for (const m of await b.list({ agentId, limit: 20_000 }))
          if (m.agentId === agentId)
            memory.push({
              backend: b.id,
              text: this.app.redact(m.text),
              tags: m.tags,
              ...(m.source ? { source: m.source } : {}),
              createdAt: m.createdAt,
            });
      } catch (e) {
        this.app.log.warn('memory backend not exported', { backend: b.id, error: (e as Error).message });
      }
    }
    const workspace = readWorkspace(agent.workspaceDir);
    // W31: the approved manifests of the skills synced into its workspace (named by their sync marker)
    const manifestPort = this.app.skillManifests.port();
    const skillManifests = manifestPort
      ? ((await manifestPort.exportManifests(actor, syncedSkillIds(workspace))) as NonNullable<
          BundlePayload['skillManifests']
        >)
      : [];
    const vault: BundlePayload['vault'] = includeVault ? [] : undefined;
    if (vault)
      for (const s of await this.app.vault.list(`agent:${agentId}`))
        vault.push({
          name: s.name,
          value: await this.app.vault.get(s, {
            actor: `user:${actor.id}`,
            purpose: 'encrypted agent bundle export',
          }),
        });
    const payload: BundlePayload = {
      format: 'pasabot.agent-bundle.payload',
      v: 2,
      agent: base,
      memory,
      ...(pool ? { pool } : {}),
      workspace,
      ...(skillManifests.length ? { skillManifests } : {}),
      ...(vault ? { vault } : {}),
    };
    const file = await sealBundle(payload, passphrase, this.o.bundleKdf ? { kdf: this.o.bundleKdf } : {});
    return { file, slug: agent.slug };
  }

  async importAgent(actor: { kind: 'user'; id: string }, file: Buffer, passphrase: string) {
    // everything is authenticated and checked before the first write
    const p = await openBundle(file, passphrase);
    checkEntrySet(p.workspace.map((f) => f.path));
    const files = p.workspace.map((f) => ({
      path: checkEntryPath(f.path),
      data: Buffer.from(f.data, 'base64'),
    }));
    if (files.reduce((n, f) => n + f.data.length, 0) > MAX_WORKSPACE_BYTES)
      throw new BundleError('bad_payload', 'the bundle workspace is too large');
    // the file tree is laid out once (empty files, a private temp folder) before the agent exists: a tree this file
    // system cannot hold fails here, with nothing created
    rehearseTree(files.map((f) => f.path));
    const taken = new Set((await this.app.agents.list()).map((a) => a.name.toLowerCase()));
    const want = p.agent.agent.name;
    let name = want;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${want.slice(0, 72)} (${i})`;
    const res = this.app.agentAdmin.importBundle(actor, { ...p.agent, agent: { ...p.agent.agent, name } });
    const created = await this.app.agents.get(res.agentId);
    if (!created) throw new HttpError(500, 'imported agent not found', 'import_failed');
    // workspace: every file lands inside the new agent's own workspace (checked again on disk, symlinks included)
    const ws = created.workspaceDir;
    const written: string[] = [];
    try {
      mkdirSync(ws, { recursive: true, mode: 0o700 });
      const root = realpathSync(ws);
      for (const f of files) {
        const target = join(ws, ...f.path.split('/'));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const d = realpathSync(dirname(target));
        if (d !== root && !d.startsWith(root + sep))
          throw new BundleError('unsafe_path', 'path left the workspace');
        writeFileSync(target, f.data, { flag: 'wx', mode: 0o600 });
        written.push(target);
      }
    } catch (e) {
      // the agent and its chats exist (the AgentAdmin port has no undo): take back the files and say so plainly
      for (const t of written) rmSync(t, { force: true });
      this.app.log.warn('bundle import: workspace not written', { agentId: res.agentId, error: String(e) });
      throw new HttpError(
        500,
        `agent "${name}" was created but its workspace could not be written; delete it and try again`,
        'import_incomplete',
      );
    }
    // memory: the agent's own items, as data from elsewhere, never above the new agent's trust
    let memory = 0;
    for (const m of p.memory) {
      const b = this.app.memory.get(m.backend) ?? this.app.memory.get('local');
      if (!b) continue;
      await b.remember({
        agentId: res.agentId,
        text: this.app.redact(m.text),
        tags: m.tags,
        ...(m.source ? { source: m.source } : {}),
        origin: { sender: 'external', trust: minTrust('guarded', created.trustLevel as TrustLevel) },
      });
      memory++;
    }
    // W33 pool entries: into the new agent's private scope, all or nothing, each at most the new agent's trust
    if (p.pool?.length) {
      const poolPort = this.app.memory.pool();
      const maxTrust = minTrust('guarded', created.trustLevel as TrustLevel);
      try {
        if (poolPort) memory += await poolPort.importAgent(actor, res.agentId, p.pool, { maxTrust });
        else {
          const b = this.app.memory.get('local');
          for (const m of b ? p.pool : []) {
            await b!.remember({
              agentId: res.agentId,
              text: this.app.redact(m.text),
              tags: m.tags,
              ...(m.source ? { source: m.source } : {}),
              origin: { sender: 'external', trust: minTrust(maxTrust, m.trust) },
            });
            memory++;
          }
        }
      } catch (e) {
        this.app.log.warn('bundle import: memory not written', { agentId: res.agentId, error: String(e) });
        throw new HttpError(
          500,
          `agent "${name}" was created but its memory could not be imported; delete it and try again`,
          'import_incomplete',
        );
      }
    }
    // W31: skill manifests arrive as proposals the owner approves, never approved, at most the new agent's trust
    let manifests = 0;
    if (p.skillManifests?.length) {
      const manifestPort = this.app.skillManifests.port();
      if (!manifestPort)
        this.app.log.warn('bundle import: skill manifests not imported (no safety module)', {
          agentId: res.agentId,
          count: p.skillManifests.length,
        });
      else
        try {
          manifests = (
            await manifestPort.importProposals(actor, p.skillManifests, {
              by: res.agentId,
              maxTrust: minTrust('guarded', created.trustLevel as TrustLevel),
            })
          ).proposed;
        } catch (e) {
          this.app.log.warn('bundle import: skill manifests not written', {
            agentId: res.agentId,
            error: String(e),
          });
          throw new HttpError(
            500,
            `agent "${name}" was created but its skill permissions could not be imported; delete it and try again`,
            'import_incomplete',
          );
        }
    }
    let vault = 0;
    for (const v of p.vault ?? []) {
      await this.app.vault.put(`agent:${res.agentId}`, v.name, v.value);
      vault++;
    }
    return {
      agentId: res.agentId,
      name,
      chatIds: res.chatIds,
      files: files.length,
      memory,
      vault,
      manifestProposals: manifests,
    };
  }
}

type CapT = (key: string, params?: Record<string, string | number>) => string;
/** English, from the same `budget:server.*` keys (logs, old clients) */
const CAP_EN: Record<string, string> = {
  allAgents: 'All agents',
  capHeadDay: '{{what}} reached the daily budget ({{spent}} of {{cap}} {{currency}}).',
  capHeadMonth: '{{what}} reached the monthly budget ({{spent}} of {{cap}} {{currency}}).',
  capStopped: '{{name}} stopped; what it wrote so far is kept.',
  capHeld: 'New work waits until the cap resets or you raise it.',
  capSkipped: 'A routine run was skipped.',
  capCard: '{{head}} {{tail}}',
};
const capEn: CapT = (k, p = {}) => (CAP_EN[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(p[n] ?? ''));
/** a cap card's text as a `Msg` (notifications render it in each person's language): head, then the reason line */
function capMsg(c: CapCard) {
  const what = c.scope === 'global' ? { key: 'budget:server.allAgents' } : c.agentName;
  const head = {
    key: c.period === 'day' ? 'budget:server.capHeadDay' : 'budget:server.capHeadMonth',
    params: { what, spent: c.spent, cap: c.cap, currency: c.currency },
  };
  const tail =
    c.reason === 'stopped'
      ? { key: 'budget:server.capStopped', params: { name: c.agentName } }
      : c.reason === 'held'
        ? { key: 'budget:server.capHeld' }
        : c.reason === 'skipped'
          ? { key: 'budget:server.capSkipped' }
          : null;
  return tail ? { key: 'budget:server.capCard', params: { head, tail } } : head;
}
/**
 * The plain text of a cap card (also the message body, for search and channels), from the `budget:server.*` keys:
 * English by default, the owner's language when the server passes its `t` (keys without the `budget:server.` part).
 */
export function capText(c: CapCard, t: CapT = capEn): string {
  const what = c.scope === 'global' ? t('allAgents') : c.agentName;
  const head = t(c.period === 'day' ? 'capHeadDay' : 'capHeadMonth', {
    what,
    spent: c.spent,
    cap: c.cap,
    currency: c.currency,
  });
  const tail =
    c.reason === 'stopped'
      ? t('capStopped', { name: c.agentName })
      : c.reason === 'held'
        ? t('capHeld')
        : c.reason === 'skipped'
          ? t('capSkipped')
          : null;
  return tail ? t('capCard', { head, tail }) : head;
}

/** Lay the entry tree out as empty files in a private temp folder, then remove it: throws if this OS cannot. */
function rehearseTree(paths: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'pasabot-bundle-'));
  try {
    for (const p of paths) {
      const target = join(dir, ...p.split('/'));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
    }
  } catch {
    throw new BundleError('unsafe_path', 'the bundle workspace cannot be laid out on this file system');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The agent's workspace as bundle entries: regular files only (no symlinks), nothing under `.pasabot/`. */
/** The skill ids named by the sync markers in a workspace listing (a marker that does not parse is ignored). */
export function syncedSkillIds(workspace: BundlePayload['workspace']): string[] {
  const ids = new Set<string>();
  for (const f of workspace) {
    if (f.path !== SKILL_SYNC_MARKER && !f.path.endsWith(`/${SKILL_SYNC_MARKER}`)) continue;
    try {
      const id = (JSON.parse(Buffer.from(f.data, 'base64').toString('utf8')) as { id?: unknown }).id;
      if (typeof id === 'string' && id) ids.add(id);
    } catch {
      // not a marker the skills module wrote
    }
  }
  return [...ids];
}

function readWorkspace(dir: string): BundlePayload['workspace'] {
  const out: BundlePayload['workspace'] = [];
  if (!dir || !existsSync(dir)) return out;
  let bytes = 0;
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === '.pasabot') continue;
      const p = join(abs, name);
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        try {
          checkEntryPath(r);
        } catch {
          continue;
        }
        bytes += st.size;
        if (out.length >= MAX_WORKSPACE_FILES || bytes > MAX_WORKSPACE_BYTES)
          throw new HttpError(413, 'the workspace is too large to bundle', 'too_large');
        out.push({ path: r, data: readFileSync(p).toString('base64') });
      }
    }
  };
  walk(dir, '');
  return out;
}

// ---------- routes ----------
function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return p;
}
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .default('USD');
const money = z.number().finite().min(0).max(1_000_000_000);
const priceBody = z.object({
  providerId: z.string().min(1).max(80),
  model: z.string().max(200),
  inputPerM: money,
  outputPerM: money,
  cachedPerM: money,
  currency,
});
const capBody = z.object({
  scope: z.string().min(1).max(40),
  period: z.enum(['day', 'month']),
  amount: money.nullable(),
  currency,
});
const passphrase = z.string().min(8).max(1024);
const bundleErr = (e: unknown): never => {
  if (e instanceof BundleError)
    throw new HttpError(e.code === 'unsupported_version' ? 422 : 400, e.message, e.code);
  throw e;
};

export function createBudgetModule(o: BudgetOptions = {}): PasaBotModule & { budget(): Budget } {
  let budget: Budget | null = null;
  return {
    id: 'budget',
    migrations: join(here, '..', 'migrations'),
    budget() {
      if (!budget) throw new Error('budget not registered yet');
      return budget;
    },
    register(app) {
      const b = new Budget(app, o);
      budget = b;
      app.blocks.register(CAP_KIND, capCardSchema);
      app.queue.addGate((item) => b.gate(item));
      const work = (f: () => unknown) => {
        try {
          const r = f();
          if (r instanceof Promise)
            r.catch((e) => app.log.warn('budget bookkeeping failed', { error: String(e) }));
        } catch (e) {
          app.log.warn('budget bookkeeping failed', { error: String(e) });
        }
      };
      app.bus.subscribe((ev) => {
        if (!app.raw.open) return;
        // a live reply's text so far: the run's output grows (the mid-run estimate; real adapters report usage late)
        if (ev.live) {
          if (ev.type === 'message.delta' && ev.topic.startsWith('chat:'))
            work(() => b.onDelta(ev.data as { runId?: unknown; text?: unknown }));
          return;
        }
        if (ev.type === 'run.started' && ev.topic.startsWith('agent:'))
          work(() => b.onRunStarted(ev.data as RunDTO));
        else if (ev.type === 'run.event' && ev.topic.startsWith('run:'))
          work(() => b.onRunEvent(ev.data as RunEventDTO));
        else if (ev.type === 'run.finished' && ev.topic.startsWith('agent:'))
          work(() => b.onRunFinished(ev.data as RunDTO));
      });

      const names = async () => new Map((await app.agents.list()).map((a) => [a.id, a.name]));

      app.http.route({
        method: 'GET',
        url: '/summary',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const period = ctx.query.period === 'month' ? 'month' : 'today';
          const s = b.summary(period);
          const n = await names();
          return { ...s, agents: s.agents.map((a) => ({ ...a, name: n.get(a.agentId) ?? a.agentId })) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/tasks',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const limit = Math.min(200, Math.max(1, Number(ctx.query.limit) || 50));
          const n = await names();
          return { tasks: b.tasks(limit).map((t) => ({ ...t, agentName: n.get(t.agentId) ?? t.agentId })) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/prices',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return { prices: b.priceTable() };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/prices',
        auth: 'session',
        body: priceBody,
        handler: (ctx) => {
          owner(ctx);
          b.setPrice(ctx.body);
          return { prices: b.priceTable() };
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/prices',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          b.removePrice(String(ctx.query.providerId ?? ''), String(ctx.query.model ?? ''));
          return { prices: b.priceTable() };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/caps',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const agents = (await app.agents.list()).filter((a) => !a.archivedAt);
          const view = (scope: string, agentId: string | null) =>
            Object.fromEntries(
              (['day', 'month'] as const).map((period) => {
                const c = b.cap(scope, period);
                return [
                  period,
                  c
                    ? { amount: c.amount, currency: c.currency, spent: b.spent(agentId, period, c.currency) }
                    : null,
                ];
              }),
            );
          const cur = b.caps()[0]?.currency ?? null;
          return {
            global: view('global', null),
            agents: agents.map((a) => ({ agentId: a.id, name: a.name, ...view(a.id, a.id) })),
            // models whose spend no cap counts (no price in the caps' currency)
            uncovered: cur ? b.uncovered(cur) : [],
          };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/caps',
        auth: 'session',
        body: capBody,
        handler: async (ctx) => {
          owner(ctx);
          const { scope, period, amount } = ctx.body;
          if (scope !== 'global' && !(await app.agents.get(scope)))
            throw new HttpError(404, 'agent not found', 'not_found');
          const before = b.cap(scope, period);
          b.setCap(scope, period, amount === null ? null : { amount, currency: ctx.body.currency });
          // a raised or removed cap lets held work be checked again
          if (before && (amount === null || amount > before.amount))
            await b.release(scope === 'global' ? null : scope);
          return { cap: b.cap(scope, period) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/alerts',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const n = await names();
          return {
            alerts: b.openAlerts().map((a) => ({
              alertId: a.id,
              agentId: a.agent_id,
              agentName: n.get(a.agent_id) ?? a.agent_id,
              scope: a.scope === 'global' ? 'global' : 'agent',
              period: a.period,
              cap: a.cap,
              spent: a.spent,
              currency: a.currency,
              reason: a.reason,
              state: a.state,
              chatId: a.chat_id,
            })),
          };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/alerts/:id/raise',
        auth: 'session',
        body: z.object({ amount: money }),
        handler: (ctx) => {
          owner(ctx);
          return b.decide(ctx.params.id!, { raise: ctx.body.amount });
        },
      });
      app.http.route({
        method: 'POST',
        url: '/alerts/:id/keep',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return b.decide(ctx.params.id!, { keep: true });
        },
      });

      // ---------- portable agents ----------
      app.http.route({
        method: 'POST',
        url: '/bundles/export',
        auth: 'session',
        body: z.object({
          agentId: z.string().min(1).max(40),
          passphrase,
          includeVault: z.boolean().default(false),
        }),
        handler: async (ctx) => {
          const p = owner(ctx);
          // vault values leave the server only with a fresh re-auth (7.3)
          if (ctx.body.includeVault && !p.reauthed)
            throw new HttpError(401, 'confirm your password to include vault entries', 'reauth_required');
          const { file, slug } = await b.exportAgent(
            { kind: 'user', id: p.userId },
            ctx.body.agentId,
            ctx.body.passphrase,
            ctx.body.includeVault,
          );
          return httpResponse(200, file, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${slug.replace(/[^a-z0-9-]/gi, '')}.pasabot-agent"`,
            'cache-control': 'no-store',
          });
        },
      });
      app.http.route({
        method: 'POST',
        url: '/bundles/import',
        auth: 'session',
        bodyLimit: 100 * 1024 * 1024,
        body: z.object({
          data: z
            .string()
            .min(1)
            .max(95 * 1024 * 1024),
          passphrase,
        }),
        handler: async (ctx) => {
          const p = owner(ctx);
          try {
            return httpResponse(
              201,
              await b.importAgent(
                { kind: 'user', id: p.userId },
                Buffer.from(ctx.body.data, 'base64'),
                ctx.body.passphrase,
              ),
            );
          } catch (e) {
            return bundleErr(e);
          }
        },
      });
    },
  };
}

export default defineModule(createBudgetModule());
