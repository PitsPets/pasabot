/**
 * Provider ops (W3): installs the real ProviderPolicy. Fallback chains on usage limits and auth failures (a limited
 * provider is skipped until its reported reset, or until the next usage check, every 15 min by default, so the
 * primary is retried after the reset), held work through the orchestrator when nothing is left, reseed summaries for
 * a provider switch or compaction, the per-agent compaction threshold with the two-empty-compactions stop, per-agent
 * provider accounts (each its own CLI config dir), token usage per run, and the chat notices for all of it.
 * The orchestrator (apps/server/src/runner) calls the policy; this module never runs a turn itself.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  brainKeyStamp,
  defineModule,
  HttpError,
  type ModuleHost,
  type PasaBotModule,
  type ProviderAccount,
  type ProviderErrorEvent,
  type ProviderId,
  type ProviderPolicy,
  ulid,
  vaultKeyNames,
} from '@pasabot/core';
import { providerDisplayName, SUPPORTED_LOCALES } from '@pasabot/i18n';
import type { AgentDTO, EventMap, MessageDTO, RunDTO, UsageSnapshot } from '@pasabot/protocol';
import { z } from 'zod';
import { CATALOG, listBrains, problemOf, TEST_PROMPT, TestLimiter } from './brains.js';

const here = dirname(fileURLToPath(import.meta.url));

export const NOTICE_KIND = 'provider-ops.notice';
export const noticeSchema = z.object({
  kind: z.enum(['switched', 'back', 'compacted', 'stopped']),
  reason: z.string().max(40).optional(),
  from: z.string().max(120).optional(),
  to: z.string().max(120).optional(),
  pct: z.number().min(0).max(1000).optional(),
});
export type Notice = z.infer<typeof noticeSchema>;

export interface ChatContext {
  chatId: string;
  agentId: string;
  providerId: string;
  model: string | null;
  used: number;
  window: number;
  pct: number;
}

declare module '@pasabot/protocol' {
  interface EventMap {
    /** latest context use of a chat (on `chat:<id>`, for the header gauge) */
    'provider-ops.context': ChatContext;
  }
}

export interface ChainEntry {
  providerId: string;
  model?: string;
  accountId?: string;
}
interface AgentRow {
  agent_id: string;
  fallback: string;
  account_id: string | null;
  compact_pct: number | null;
  compact_tokens: number | null;
  no_gain: number;
  pending_used: number | null;
  pending_window: number | null;
  compaction_stopped_at: number | null;
  last_provider: string | null;
}
interface AccountRow {
  id: string;
  provider_id: string;
  label: string;
  config_dir: string;
  created_at: number;
}

export interface ProviderOpsOptions {
  /** clock (tests) */
  now?: () => number;
  /** usage check interval: expired limits are cleared and a limit without a reported reset lasts this long (15 min) */
  checkMs?: number;
  /**
   * Where provider accounts keep their CLI config dirs. Never inside $PASABOT_HOME: the runner sandbox hides that
   * tree from every CLI. Default: `<$PASABOT_HOME>-accounts`, next to it (e.g. `~/.pasabot-accounts`).
   */
  accountsDir?: string;
  /** Brains page test: abort after this long (60 s) */
  testTimeoutMs?: number;
  /** Brains page test: at most this many per minute on this server (6) */
  testsPerMinute?: number;
}

/** The shell command that signs a CLI in to one account's config dir (null = only the folder is known). */
export function signInCommand(providerId: string, dir: string): string | null {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (providerId === 'claude') return `CLAUDE_CONFIG_DIR=${q(dir)} claude`;
  if (providerId === 'codex') return `CODEX_HOME=${q(dir)} codex login`;
  if (providerId === 'opencode')
    return `XDG_CONFIG_HOME=${q(join(dir, 'config'))} XDG_DATA_HOME=${q(join(dir, 'data'))} opencode auth login`;
  return null;
}

const DEFAULT_PCT = 80;
/** a compaction that frees less than this share of the window counts as empty */
const MIN_GAIN = 0.1;
const MAX_FALLBACK = 5;
/** A brain as the owner knows it: its display name (a local endpoint's own name), never a raw provider id. */
const brainLabel = (
  providers: { get(id: string): { displayName: string; displayNameKey?: string } | undefined },
  e: { providerId: string; model?: string | null },
  t?: (key: string) => string,
) => {
  const p = providers.get(e.providerId);
  const name = p ? (t ? providerDisplayName(p, (k) => t(k)) : p.displayName) : e.providerId;
  return e.model ? `${name} · ${e.model}` : name;
};

/** The policy and the bookkeeping behind it; one per server. */
export class ProviderOps implements ProviderPolicy {
  /** what `choose` last picked per agent (the provider a following error belongs to) */
  private last = new Map<string, ChainEntry>();
  readonly now: () => number;
  readonly checkMs: number;
  constructor(
    private readonly app: ModuleHost,
    o: ProviderOpsOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.checkMs = o.checkMs ?? 15 * 60_000;
    // dataDir = $PASABOT_HOME/modules/provider-ops
    const home = resolve(app.dataDir, '..', '..');
    this.accountsDir = resolve(o.accountsDir ?? `${home}-accounts`);
    if (this.accountsDir === home || this.accountsDir.startsWith(`${home}${sep}`))
      throw new Error(
        'provider-ops: accountsDir must be outside $PASABOT_HOME (the runner sandbox hides it)',
      );
  }
  /** root of the accounts' CLI config dirs (outside $PASABOT_HOME) */
  readonly accountsDir: string;

  // ---------- settings ----------
  row(agentId: string): AgentRow | null {
    return (
      (this.app.raw.prepare('SELECT * FROM provider_ops_agent WHERE agent_id = ?').get(agentId) as
        | AgentRow
        | undefined) ?? null
    );
  }
  private ensure(agentId: string) {
    this.app.raw
      .prepare('INSERT INTO provider_ops_agent (agent_id, updated_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(agentId, this.now());
  }
  private setCols(agentId: string, cols: Record<string, unknown>) {
    this.ensure(agentId);
    for (const [k, v] of Object.entries(cols))
      this.app.raw.prepare(`UPDATE provider_ops_agent SET ${k} = ? WHERE agent_id = ?`).run(v, agentId);
  }
  settings(agent: AgentDTO) {
    const r = this.row(agent.id);
    const fallback = r ? (JSON.parse(r.fallback) as ChainEntry[]) : [];
    // compaction state lives per session; the agent's view shows the latest stop and the worst streak
    const c = this.app.raw
      .prepare(
        'SELECT max(stopped_at) AS stopped, max(no_gain) AS noGain FROM provider_ops_compaction WHERE agent_id = ?',
      )
      .get(agent.id) as { stopped: number | null; noGain: number | null } | undefined;
    return {
      agentId: agent.id,
      fallback: fallback.length ? fallback : agent.fallback.map((f) => ({ ...f })),
      accountId: r?.account_id ?? null,
      compactPct: r?.compact_pct ?? null,
      compactTokens: r?.compact_tokens ?? null,
      effectivePct: r?.compact_pct ?? agent.limits.contextPctCompact ?? DEFAULT_PCT,
      compactionStopped: c?.stopped ?? null,
      noGain: c?.noGain ?? 0,
    };
  }
  saveSettings(
    agentId: string,
    s: {
      fallback: ChainEntry[];
      accountId: string | null;
      compactPct: number | null;
      compactTokens: number | null;
    },
  ) {
    this.setCols(agentId, {
      fallback: JSON.stringify(s.fallback),
      account_id: s.accountId,
      compact_pct: s.compactPct,
      compact_tokens: s.compactTokens,
      updated_at: this.now(),
    });
  }
  /** The owner resumes compaction for the agent: every session's streak and stop are cleared. */
  resumeCompaction(agentId: string) {
    this.app.raw.prepare('DELETE FROM provider_ops_compaction WHERE agent_id = ?').run(agentId);
  }
  private session(agentId: string, s?: { chatId: string | null; scope: string }) {
    const key = [agentId, s?.chatId ?? '', s?.scope ?? ''] as const;
    const row = this.app.raw
      .prepare('SELECT * FROM provider_ops_compaction WHERE agent_id = ? AND chat_id = ? AND scope = ?')
      .get(...key) as
      | {
          no_gain: number;
          pending_used: number | null;
          pending_window: number | null;
          stopped_at: number | null;
        }
      | undefined;
    const set = (cols: Record<string, unknown>) => {
      this.app.raw
        .prepare(
          'INSERT INTO provider_ops_compaction (agent_id, chat_id, scope) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        )
        .run(...key);
      for (const [k, v] of Object.entries(cols))
        this.app.raw
          .prepare(
            `UPDATE provider_ops_compaction SET ${k} = ? WHERE agent_id = ? AND chat_id = ? AND scope = ?`,
          )
          .run(v, ...key);
    };
    return { row, set };
  }

  // ---------- accounts ----------
  accounts(): {
    id: string;
    providerId: string;
    label: string;
    createdAt: number;
    configDir: string;
    signIn: string | null;
  }[] {
    return (
      this.app.raw.prepare('SELECT * FROM provider_ops_account ORDER BY created_at').all() as AccountRow[]
    ).map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      label: r.label,
      createdAt: r.created_at,
      configDir: r.config_dir,
      signIn: signInCommand(r.provider_id, r.config_dir),
    }));
  }
  addAccount(providerId: string, lbl: string) {
    const id = ulid();
    const dir = join(this.accountsDir, id);
    mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.app.raw
      .prepare(
        'INSERT INTO provider_ops_account (id, provider_id, label, config_dir, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, providerId, lbl, dir, this.now());
    return id;
  }
  removeAccount(id: string): boolean {
    const r = this.app.raw.prepare('SELECT * FROM provider_ops_account WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    if (!r) return false;
    this.app.raw.prepare('DELETE FROM provider_ops_account WHERE id = ?').run(id);
    this.app.raw.prepare('UPDATE provider_ops_agent SET account_id = NULL WHERE account_id = ?').run(id);
    for (const a of this.app.raw
      .prepare('SELECT agent_id, fallback FROM provider_ops_agent')
      .all() as AgentRow[]) {
      const f = (JSON.parse(a.fallback) as ChainEntry[]).map(({ accountId, ...e }) =>
        accountId === id ? e : { ...e, ...(accountId ? { accountId } : {}) },
      );
      this.app.raw
        .prepare('UPDATE provider_ops_agent SET fallback = ? WHERE agent_id = ?')
        .run(JSON.stringify(f), a.agent_id);
    }
    // only ever a folder this module created under its accounts root
    if (resolve(r.config_dir).startsWith(`${this.accountsDir}${sep}`))
      rmSync(r.config_dir, { recursive: true, force: true });
    return true;
  }
  account(accountId: string): ProviderAccount | undefined {
    const r = this.app.raw.prepare('SELECT * FROM provider_ops_account WHERE id = ?').get(accountId) as
      | AccountRow
      | undefined;
    return r
      ? { id: r.id, providerId: r.provider_id as ProviderId, label: r.label, configDir: r.config_dir }
      : undefined;
  }

  // ---------- limits ----------
  limits() {
    return (
      this.app.raw.prepare('SELECT * FROM provider_ops_limit ORDER BY until').all() as {
        provider_id: string;
        account_id: string;
        until: number;
        reason: string;
        at: number;
      }[]
    ).map((r) => ({
      providerId: r.provider_id,
      accountId: r.account_id || null,
      until: r.until,
      reason: r.reason,
    }));
  }
  private limited(e: ChainEntry): boolean {
    const r = this.app.raw
      .prepare('SELECT until FROM provider_ops_limit WHERE provider_id = ? AND account_id = ?')
      .get(e.providerId, e.accountId ?? '') as { until: number } | undefined;
    return !!r && r.until > this.now();
  }
  private limit(e: ChainEntry, err: ProviderErrorEvent) {
    const t = this.now();
    const until = t + (err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : this.checkMs);
    this.app.raw
      .prepare(
        `INSERT INTO provider_ops_limit (provider_id, account_id, until, reason, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider_id, account_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, at = excluded.at`,
      )
      .run(e.providerId, e.accountId ?? '', until, err.kind, t);
  }
  /** The usage check: limits whose reset passed are cleared, so the next turn tries the primary again. */
  check(): number {
    return this.app.raw.prepare('DELETE FROM provider_ops_limit WHERE until <= ?').run(this.now()).changes;
  }
  clearLimit(providerId: string, accountId: string | null): boolean {
    return (
      this.app.raw
        .prepare('DELETE FROM provider_ops_limit WHERE provider_id = ? AND account_id = ?')
        .run(providerId, accountId ?? '').changes > 0
    );
  }

  // ---------- ProviderPolicy ----------
  chain(agent: AgentDTO): ChainEntry[] {
    const s = this.settings(agent);
    const primary: ChainEntry = {
      providerId: agent.providerId,
      ...(agent.model ? { model: agent.model } : {}),
      ...(s.accountId ? { accountId: s.accountId } : {}),
    };
    return [primary, ...s.fallback];
  }
  choose(
    agent: AgentDTO,
    lastError?: ProviderErrorEvent,
  ): { providerId: ProviderId; model?: string; accountId?: string } | null {
    const chain = this.chain(agent);
    if (lastError?.kind === 'offline') {
      // W34: the brain could not be reached at all (an item marked "run even offline" asks). Not a usage limit, so
      // nothing is paused: the next reachable entry after the one that failed answers this one item.
      const failed = this.last.get(agent.id) ?? chain[0]!;
      const at = chain.findIndex((e) => e.providerId === failed.providerId && e.model === failed.model);
      const next = chain.slice(at + 1).find((e) => !this.limited(e) && this.app.providers.get(e.providerId));
      return next ? this.asChoice(next) : null;
    }
    if (
      lastError &&
      (lastError.kind === 'rate_limit' || lastError.kind === 'quota' || lastError.kind === 'auth')
    )
      this.limit(this.last.get(agent.id) ?? chain[0]!, lastError);
    const pick = chain.find((e) => !this.limited(e) && this.app.providers.get(e.providerId));
    if (!pick) {
      // after an error: nothing left to fall back to (the orchestrator holds the item until the reset)
      if (lastError) return null;
      this.last.set(agent.id, chain[0]!);
      return this.asChoice(chain[0]!);
    }
    this.last.set(agent.id, pick);
    return this.asChoice(pick);
  }
  private asChoice(e: ChainEntry) {
    return {
      providerId: e.providerId as ProviderId,
      ...(e.model ? { model: e.model } : {}),
      ...(e.accountId ? { accountId: e.accountId } : {}),
    };
  }
  /**
   * Called after each finished tool turn that reported its context use, with the turn's chat and session scope. The
   * turn after a compaction in that same session measures what it freed (other chats and scopes never do); two empty
   * ones in a row stop compaction in that session and notify the owner.
   */
  shouldCompact(
    agent: AgentDTO,
    usage: UsageSnapshot,
    session?: { chatId: string | null; scope: string },
  ): 'native' | 'reseed' | false {
    const used = usage.contextUsed;
    const window = usage.contextWindow;
    if (used === undefined || !window) return false;
    const st = this.session(agent.id, session);
    let stopped = st.row?.stopped_at ?? null;
    if (st.row && st.row.pending_used !== null && st.row.pending_window) {
      const freed = st.row.pending_used - used;
      const noGain = freed < st.row.pending_window * MIN_GAIN ? st.row.no_gain + 1 : 0;
      st.set({ no_gain: noGain, pending_used: null, pending_window: null });
      if (noGain >= 2 && !stopped) {
        stopped = this.now();
        st.set({ stopped_at: stopped });
        this.stoppedNotice(agent, session?.chatId ?? null);
      }
    }
    if (stopped) return false;
    const s = this.settings(agent);
    const hit =
      (s.compactTokens !== null && used >= s.compactTokens) || (used / window) * 100 >= s.effectivePct;
    if (!hit) return false;
    // the orchestrator compacts (or reseeds) right after this answer: the next turn of this session measures it
    st.set({ pending_used: used, pending_window: window });
    const adapter = this.app.providers.get(this.last.get(agent.id)?.providerId ?? agent.providerId);
    return adapter?.capabilities().nativeCompaction && adapter.compact ? 'native' : 'reseed';
  }
  private stoppedNotice(agent: AgentDTO, chatId: string | null) {
    this.notice(chatId, { kind: 'stopped' }, this.app.i18n.t('provider-ops:notice.stopped'));
    this.app.notifier
      .notify({
        level: 'warn',
        title: `${agent.name}: compaction stopped`,
        body: 'Two compactions in a row freed less than 10 % of the context. Start a new chat or resume compaction in Settings.',
        msg: {
          title: { key: 'provider-ops:server.stoppedTitle', params: { name: agent.name } },
          body: { key: 'provider-ops:server.stoppedBody' },
        },
        ...(chatId ? { href: `/chats/${chatId}` } : {}),
      })
      .catch((e) => this.app.log.warn('provider-ops notify failed', { error: String(e) }));
  }
  /** When held work may run again: the earliest end of a limit on the agent's chain (undefined = none known). */
  resumeAt(agent: AgentDTO): number | undefined {
    const t = this.now();
    let at: number | undefined;
    for (const e of this.chain(agent)) {
      const r = this.app.raw
        .prepare('SELECT until FROM provider_ops_limit WHERE provider_id = ? AND account_id = ?')
        .get(e.providerId, e.accountId ?? '') as { until: number } | undefined;
      if (!r || r.until <= t) continue;
      if (at === undefined || r.until < at) at = r.until;
    }
    return at;
  }
  /**
   * An extractive summary of the chat before the recent messages that go into the reseed verbatim: who said what,
   * oldest first, each line cut short. No model call (it cannot fail or cost tokens); the adapters quote it as data.
   * With `only` (the orchestrator's reseed), exactly those messages: the reseeded scope's own older turns.
   */
  async summarize(chatId: string, _upto: string, only?: readonly MessageDTO[]): Promise<string> {
    const older = only
      ? [...only]
      : this.app.chats
          .recent(asSystem('provider-ops: reseed summary of the chat'), chatId, 60)
          .slice(10)
          .reverse();
    if (!older.length) return '';
    const lines = older.map((m) => {
      const body = m.body.replace(/\s+/g, ' ').trim();
      return `- ${m.authorKind}: ${body.length > 200 ? `${body.slice(0, 200)}…` : body}`;
    });
    return `Earlier in this chat (${older.length} messages, oldest first):\n${lines.join('\n')}`;
  }

  // ---------- events ----------
  private notice(chatId: string | null, n: Notice, body: string) {
    if (!chatId) return;
    try {
      this.app.chats.post(asSystem('provider-ops: provider switch / compaction notice'), {
        chatId,
        authorKind: 'system',
        authorId: null,
        body,
        blocks: [{ kind: NOTICE_KIND, v: 1, data: n }],
      });
    } catch (e) {
      this.app.log.warn('provider-ops notice not posted', { error: (e as Error).message });
    }
  }
  onSwitched(d: EventMap['provider.switched']) {
    if (d.reason === 'context_overflow') {
      this.notice(
        d.chatId,
        { kind: 'compacted', reason: d.reason },
        this.app.i18n.t('provider-ops:notice.overflow'),
      );
      return;
    }
    const t = (k: string) => this.app.i18n.t(k);
    const from = brainLabel(this.app.providers, { providerId: d.from.providerId, model: d.from.model }, t);
    const to = brainLabel(this.app.providers, { providerId: d.to.providerId, model: d.to.model }, t);
    // the block carries the facts (the web names them in the reader's language); the body is the owner's language
    this.notice(
      d.chatId,
      { kind: 'switched', reason: d.reason, from, to },
      this.app.i18n.t('provider-ops:notice.switched', {
        from,
        to,
        reason: this.app.i18n.t(`provider-ops:notice.reason.${d.reason}`),
      }),
    );
  }
  async onRunStarted(run: RunDTO) {
    const prev = this.row(run.agentId)?.last_provider ?? null;
    this.setCols(run.agentId, { last_provider: run.providerId });
    if (!prev || prev === run.providerId) return;
    const agent = await this.app.agents.get(run.agentId);
    // "back on primary" only after a fallback ran (an owner's switch of the agent's provider is no "back")
    const wasFallback = agent && this.settings(agent).fallback.some((f) => f.providerId === prev);
    if (agent && wasFallback && prev !== agent.providerId && run.providerId === agent.providerId) {
      const to = brainLabel(this.app.providers, { providerId: run.providerId, model: run.model });
      this.notice(this.app.chats.runChat(run.id), { kind: 'back', to }, `Back on ${to}.`);
    }
  }
  async onRunFinished(run: RunDTO) {
    const u = run.usage;
    const chatId = this.app.chats.runChat(run.id);
    if (u) {
      this.app.raw
        .prepare(
          `INSERT OR IGNORE INTO provider_ops_usage (run_id, agent_id, chat_id, provider_id, model, input_tokens,
           output_tokens, cache_tokens, context_used, context_window, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.agentId,
          chatId,
          run.providerId,
          run.model,
          u.inputTokens,
          u.outputTokens,
          u.cacheTokens ?? 0,
          u.contextUsed ?? null,
          u.contextWindow ?? null,
          run.finishedAt ?? this.now(),
        );
      if (chatId && u.contextUsed !== undefined && u.contextWindow) {
        const ctx = this.contextOf(chatId);
        if (ctx) this.app.bus.publish(`chat:${chatId}`, 'provider-ops.context', ctx);
      }
    }
    // what a compaction freed is measured in shouldCompact, on the next turn of the same session (chat + scope)
  }
  onCompacted(d: EventMap['provider.compacted']) {
    const pct = Math.round((d.contextUsed / d.contextWindow) * 100);
    this.notice(
      d.chatId,
      { kind: 'compacted', reason: d.mode, pct },
      d.mode === 'native'
        ? `Context at ${pct} %: compacted.`
        : `Context at ${pct} %: the next reply starts a fresh session with a summary.`,
    );
  }

  // ---------- reads ----------
  contextOf(chatId: string): ChatContext | null {
    const r = this.app.raw
      .prepare(
        'SELECT * FROM provider_ops_usage WHERE chat_id = ? AND context_used IS NOT NULL AND context_window > 0 ORDER BY at DESC, run_id DESC LIMIT 1',
      )
      .get(chatId) as
      | {
          agent_id: string;
          provider_id: string;
          model: string | null;
          context_used: number;
          context_window: number;
        }
      | undefined;
    if (!r) return null;
    return {
      chatId,
      agentId: r.agent_id,
      providerId: r.provider_id,
      model: r.model,
      used: r.context_used,
      window: r.context_window,
      pct: Math.min(100, Math.round((r.context_used / r.context_window) * 100)),
    };
  }
  usage(sinceMs: number) {
    const q = (group: string) =>
      this.app.raw
        .prepare(
          `SELECT ${group} AS k, count(*) AS runs, sum(input_tokens) AS input, sum(output_tokens) AS output,
           sum(cache_tokens) AS cache FROM provider_ops_usage WHERE at >= ? GROUP BY ${group} ORDER BY input + output DESC`,
        )
        .all(sinceMs) as { k: string; runs: number; input: number; output: number; cache: number }[];
    return { agents: q('agent_id'), providers: q('provider_id') };
  }
}

function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return p;
}

const entrySchema = z.object({
  providerId: z.string().min(1).max(80),
  model: z.string().min(1).max(100).optional(),
  accountId: z.string().min(1).max(40).optional(),
});
const settingsBody = z.object({
  fallback: z.array(entrySchema).max(MAX_FALLBACK),
  accountId: z.string().min(1).max(40).nullable(),
  compactPct: z.number().int().min(10).max(100).nullable(),
  compactTokens: z.number().int().min(1000).max(10_000_000).nullable(),
});

export function createProviderOpsModule(o: ProviderOpsOptions = {}): PasaBotModule & { ops(): ProviderOps } {
  let ops: ProviderOps | null = null;
  return {
    id: 'provider-ops',
    migrations: join(here, '..', 'migrations'),
    ops() {
      if (!ops) throw new Error('provider-ops not registered yet');
      return ops;
    },
    register(app) {
      const p = new ProviderOps(app, o);
      ops = p;
      app.providers.setPolicy(p);
      app.blocks.register(NOTICE_KIND, noticeSchema);

      const work = (f: () => unknown) => {
        try {
          const r = f();
          if (r instanceof Promise)
            r.catch((e) => app.log.warn('provider-ops bookkeeping failed', { error: String(e) }));
        } catch (e) {
          app.log.warn('provider-ops bookkeeping failed', { error: String(e) });
        }
      };
      app.bus.subscribe((ev) => {
        if (ev.live || !app.raw.open) return;
        if (ev.type === 'provider.switched')
          work(() => p.onSwitched(ev.data as EventMap['provider.switched']));
        else if (ev.type === 'provider.compacted')
          work(() => p.onCompacted(ev.data as EventMap['provider.compacted']));
        else if (ev.type === 'run.started' && ev.topic.startsWith('agent:'))
          work(() => p.onRunStarted(ev.data as RunDTO));
        else if (ev.type === 'run.finished' && ev.topic.startsWith('agent:'))
          work(() => p.onRunFinished(ev.data as RunDTO));
      });
      if (p.checkMs > 0) {
        const t = setInterval(() => (app.raw.open ? p.check() : clearInterval(t)), p.checkMs);
        t.unref?.();
      }

      const providerOk = (id: string) => !!app.providers.get(id);
      const accountOk = (id: string, providerId: string) => p.account(id)?.providerId === providerId;

      // the context gauge: anyone who can read the chat
      app.http.route({
        method: 'GET',
        url: '/chats/:chatId/context',
        auth: 'session',
        handler: (ctx) => {
          const pr = ctx.principal;
          if (pr.kind !== 'session') throw new HttpError(403, 'session only', 'forbidden');
          const chatId = ctx.params.chatId!;
          if (!app.chats.canRead(chatId, { id: pr.userId, kind: pr.userKind }))
            throw new HttpError(404, 'chat not found', 'not_found');
          return { context: p.contextOf(chatId) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/usage',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const days = Math.min(365, Math.max(1, Number(ctx.query.days) || 30));
          const agents = await app.agents.list();
          const names = new Map(agents.map((a) => [a.id, a.name]));
          const u = p.usage(p.now() - days * 86_400_000);
          return {
            days,
            agents: u.agents.map((r) => ({ agentId: r.k, name: names.get(r.k) ?? r.k, ...strip(r) })),
            providers: u.providers.map((r) => ({ providerId: r.k, ...strip(r) })),
            limits: p.limits(),
          };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/check',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return { cleared: p.check(), limits: p.limits() };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/settings',
        auth: 'session',
        handler: async (ctx) => {
          const stored = app.i18n.language(owner(ctx).userId);
          // the page says which language it reads in (?lang=): a just-switched app language may not be stored yet
          const asked = typeof ctx.query.lang === 'string' ? ctx.query.lang : '';
          const lng = (SUPPORTED_LOCALES as readonly string[]).includes(asked) ? asked : stored;
          const agents = await app.agents.list();
          return {
            providers: app.providers.list().map((a) => ({
              id: a.id,
              name: providerDisplayName(a, (k) => app.i18n.t(k, undefined, lng)),
            })),
            accounts: p.accounts(),
            agents: agents
              .filter((a) => !a.archivedAt)
              .map((a) => ({ ...p.settings(a), name: a.name, providerId: a.providerId, model: a.model })),
          };
        },
      });
      // one agent's chain (the details panel's "Backup" line): owner only, like the settings it reads
      app.http.route({
        method: 'GET',
        url: '/agents/:id',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const agent = await app.agents.get(ctx.params.id!);
          if (!agent) throw new HttpError(404, 'agent not found', 'not_found');
          return { settings: p.settings(agent) };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/agents/:id',
        auth: 'session',
        body: settingsBody,
        handler: async (ctx) => {
          owner(ctx);
          const agent = await app.agents.get(ctx.params.id!);
          if (!agent) throw new HttpError(404, 'agent not found', 'not_found');
          const b = ctx.body;
          for (const e of b.fallback) {
            if (!providerOk(e.providerId))
              throw new HttpError(400, `unknown provider ${e.providerId}`, 'unknown_provider');
            if (e.accountId && !accountOk(e.accountId, e.providerId))
              throw new HttpError(400, 'account does not belong to that provider', 'bad_account');
          }
          if (b.accountId && !accountOk(b.accountId, agent.providerId))
            throw new HttpError(400, 'account does not belong to the agent provider', 'bad_account');
          p.saveSettings(agent.id, b);
          return { settings: p.settings(agent) };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/agents/:id/compaction/resume',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const agent = await app.agents.get(ctx.params.id!);
          if (!agent) throw new HttpError(404, 'agent not found', 'not_found');
          p.resumeCompaction(agent.id);
          return { settings: p.settings(agent) };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/accounts',
        auth: 'session',
        body: z.object({ providerId: z.string().min(1).max(80), label: z.string().trim().min(1).max(60) }),
        handler: (ctx) => {
          owner(ctx);
          if (!providerOk(ctx.body.providerId))
            throw new HttpError(400, 'unknown provider', 'unknown_provider');
          return { id: p.addAccount(ctx.body.providerId, ctx.body.label), accounts: p.accounts() };
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/accounts/:id',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          if (!p.removeAccount(ctx.params.id!)) throw new HttpError(404, 'account not found', 'not_found');
          return { accounts: p.accounts() };
        },
      });
      // ---------- Brains page (SPEC "Simplify" §5) ----------
      const lngOf = (ctx: AuthedCtx, userId: string) => {
        const asked = typeof ctx.query.lang === 'string' ? ctx.query.lang : '';
        return (SUPPORTED_LOCALES as readonly string[]).includes(asked) ? asked : app.i18n.language(userId);
      };
      app.http.route({
        method: 'GET',
        url: '/brains',
        auth: 'session',
        handler: async (ctx) => {
          const lng = lngOf(ctx, owner(ctx).userId);
          const t = (k: string, params?: Record<string, unknown>) =>
            app.i18n.t(
              k.includes(':') ? k : `provider-ops:${k}`,
              params as Record<string, string | number> | undefined,
              lng,
            );
          const agents = await app.agents.list();
          return {
            brains: await listBrains(
              app,
              agents,
              (a) => p.settings(a).fallback,
              t,
              await vaultKeyNames(app.vault),
              (id) => brainKeyStamp(app.vault, id),
            ),
            // the install steps name the server's own terminal: PowerShell and Enter on Windows, Terminal elsewhere
            ...(process.platform === 'win32' ? { serverOs: 'windows' as const } : {}),
          };
        },
      });
      const limiter = new TestLimiter(o.testsPerMinute ?? 6, 60_000, p.now);
      app.http.route({
        method: 'POST',
        url: '/brains/:id/test',
        auth: 'session',
        body: z.object({
          providerId: z.string().min(1).max(120).optional(),
          model: z.string().min(1).max(100).optional(),
        }),
        handler: async (ctx) => {
          owner(ctx);
          const id = ctx.params.id!;
          const c = CATALOG.find((e) => e.id === id);
          const members = app.providers
            .list()
            .filter((a) => (c?.prefix ? a.id.startsWith(c.prefix) : a.id === id));
          const chosen = ctx.body.providerId ? members.find((m) => m.id === ctx.body.providerId) : members[0];
          if (ctx.body.providerId && !chosen) throw new HttpError(404, 'no such brain', 'not_found');
          const wait = limiter.take();
          if (wait > 0)
            throw new HttpError(
              429,
              `too many tests: try again in ${Math.ceil(wait / 1000)} s`,
              'rate_limited',
            );
          if (!chosen) return { result: { ok: false, problem: 'not_installed', message: '', ms: 0 } };
          let installed = true;
          try {
            installed = (await chosen.detect()).installed;
          } catch {
            installed = false;
          }
          if (!installed)
            return {
              result: { ok: false, problem: 'not_installed', message: '', ms: 0, providerId: chosen.id },
            };
          if (!app.providers.probe) throw new HttpError(501, 'brain test is not available', 'unavailable');
          const r = await app.providers.probe(chosen.id, {
            prompt: TEST_PROMPT,
            timeoutMs: o.testTimeoutMs ?? 60_000,
            ...(ctx.body.model ? { model: ctx.body.model } : {}),
          });
          // the tile and the agent header follow how the test really went (no account: the brain's own sign-in)
          if (r.ok) app.providers.noteSignIn?.(chosen.id, true);
          else if (problemOf(r) === 'auth')
            app.providers.noteSignIn?.(chosen.id, false, await brainKeyStamp(app.vault, chosen.id));
          // never stored: the result lives only in this answer (and the page's memory)
          return r.ok
            ? {
                result: {
                  ok: true,
                  reply: app.redact(r.reply),
                  ms: r.ms,
                  providerId: chosen.id,
                  ...(r.model ? { model: r.model } : {}),
                },
              }
            : {
                result: {
                  ok: false,
                  problem: problemOf(r),
                  message: app.redact(r.message),
                  ms: r.ms,
                  providerId: chosen.id,
                  // a usage limit the CLI said when it resets: the page names the time
                  ...(r.retryAfterMs && problemOf(r) === 'limit'
                    ? { resetAt: p.now() + r.retryAfterMs }
                    : {}),
                },
              };
        },
      });

      // is the account's CLI installed and signed in? (the adapter's own check, against that account's config dir)
      app.http.route({
        method: 'GET',
        url: '/accounts/:id/status',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const acct = p.account(ctx.params.id!);
          if (!acct) throw new HttpError(404, 'account not found', 'not_found');
          const adapter = app.providers.get(acct.providerId);
          if (!adapter) return { status: { installed: false, signedIn: false } };
          const st = await adapter.detect(acct);
          return { status: { installed: st.installed, signedIn: st.signedIn } };
        },
      });
    },
  };
}
const strip = (r: { runs: number; input: number; output: number; cache: number }) => ({
  runs: r.runs,
  input: r.input ?? 0,
  output: r.output ?? 0,
  cache: r.cache ?? 0,
});

export default defineModule(createProviderOpsModule());
