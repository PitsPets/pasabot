/**
 * Approvals (ARCHITECTURE 7.1): an `approvals` row + an approval card in the chat + a notification; the owner
 * approves or denies over REST; expiry (default 30 min) counts as denied. Plus the tier policy.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type ApprovalRequest,
  type ApprovalService,
  type ApprovalTier,
  type DetachedApprovalRequest,
  type EventBus,
  type Msg,
  type Notifier,
  type SenderInfo,
  type ServerI18n,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import {
  ACTION_CLASSES,
  type ActionClass,
  type ApprovalDTO,
  actionClassSchema,
  FIXED_ALWAYS_ASK,
  type MessageDTO,
  type TrustLevel,
} from '@pasabot/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthResolver } from '../core/services.js';

export type Decision = 'approved' | 'denied' | 'expired';
export const APPROVAL_BLOCK = 'core.approval' as const;

interface ApprovalRow {
  id: string;
  run_id: string | null;
  agent_id: string | null;
  subject: string | null;
  href: string | null;
  tier: number;
  action: string;
  summary: string;
  state: ApprovalDTO['state'];
  decided_by: string | null;
  decided_at: number | null;
  expires_at: number;
  ask: string | null;
  nonce: string | null;
  screen: number;
}
const toDTO = (r: ApprovalRow): ApprovalDTO => ({
  id: r.id,
  runId: r.run_id,
  agentId: r.agent_id,
  subject: r.subject,
  href: r.href,
  tier: r.tier,
  summary: r.summary,
  action: JSON.parse(r.action),
  state: r.state,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  expiresAt: r.expires_at,
  ask: r.ask ? JSON.parse(r.ask) : null,
  ...(r.nonce ? { nonce: r.nonce } : {}),
  ...(r.screen ? { screen: true } : {}),
});
/**
 * what modules read through their port: never the card's nonce. The owner's app gets it (owner-only topics, the chat
 * card, `GET /approvals`); no agent tool or module result carries it. The chat card and the `chat:<id>` events reach
 * the owner only: the shared serialiser (chat/view.ts) gives anyone else in the chat one neutral line instead, and
 * never an approval.
 */
const withoutNonce = (a: ApprovalDTO): ApprovalDTO => {
  const { nonce: _n, ...rest } = a;
  return rest;
};
const newNonce = () => randomBytes(16).toString('hex');
const sameNonce = (a: unknown, b: string | undefined) =>
  typeof a === 'string' && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** ARCHITECTURE 8 "Screen helpers": while a computer-use action runs and this long after, no approval goes through */
export const SCREEN_QUIET_MS = 2_000;
/** a helper grant this recent means a helper is driving a screen the owner uses */
export const SCREEN_ACTIVE_MS = 30_000;
/** what the owner reads when an approve is refused because a helper just used the screen */
export const SCREEN_BUSY_TEXT = 'Wait a moment — a helper just used the screen';

const lower = (t: TrustLevel): TrustLevel => (t === 'trusted' ? 'standard' : 'guarded');

/**
 * Whether an action at `tier` runs without asking (7.1 table + non-owner downgrade). This is the one place an
 * action may skip the ask, so a per-tool "always allow", if one is ever added, lands here too; a tool registered
 * with `noAlwaysAllow` (pass its `ToolDef`) is never covered by one: it asks every time, whatever its tier, the
 * agent's trust or the sender (7.1).
 */
export function autoApproves(
  tier: ApprovalTier,
  agentTrust: TrustLevel,
  sender: SenderInfo,
  tool?: { noAlwaysAllow?: boolean },
): boolean {
  if (tool?.noAlwaysAllow === true) return false;
  if (tier <= 1) return true;
  if (tier === 3) return false; // per-tool "always allow" for trusted agents is owner-set; not built yet
  const ownerTurn = sender.kind === 'owner';
  if (!ownerTurn) return false; // non-owner turns never auto-approve tier 2+
  // tier 2: trusted = auto; standard = auto only for allowlisted targets (no allowlists yet) -> ask.
  // The turn's own trust counts too: an owner turn that arrived by channel is capped at `standard` (5.2).
  return effectiveTrust(agentTrust, sender) === 'trusted';
}
export const effectiveTrust = (agentTrust: TrustLevel, sender: SenderInfo): TrustLevel => {
  const order: TrustLevel[] = ['guarded', 'standard', 'trusted'];
  const base = order[Math.min(order.indexOf(agentTrust), order.indexOf(sender.trust))]!;
  return sender.kind === 'owner' ? base : lower(base);
};

// ---------- always-ask classes (7.1 "Always asks") ----------
export const ALWAYS_ASK_KEY = 'approvals.alwaysAsk';
/** The classes that always ask: money and outbound messages, plus whatever the owner added (never fewer). */
export function alwaysAskClasses(db: Sqlite): Set<ActionClass> {
  const out = new Set<ActionClass>(FIXED_ALWAYS_ASK);
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(ALWAYS_ASK_KEY) as
    | { value: string }
    | undefined;
  if (r) {
    try {
      for (const c of JSON.parse(r.value) as unknown[]) {
        const p = actionClassSchema.safeParse(c);
        if (p.success) out.add(p.data);
      }
    } catch {
      // a broken row adds nothing; the fixed classes still ask
    }
  }
  return out;
}
export function setAlwaysAskExtra(db: Sqlite, extra: ActionClass[]): ActionClass[] {
  const keep = ACTION_CLASSES.filter((c) => extra.includes(c) && !FIXED_ALWAYS_ASK.includes(c));
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(ALWAYS_ASK_KEY, JSON.stringify(keep));
  return keep;
}
/** Stable fingerprint of one call (tool + arguments), so the same refused action is not asked again. */
export function callFingerprint(tool: string, input: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify([tool, stable(input)]))
    .digest('hex')
    .slice(0, 32);
}
/** how many refusals of one class a run (or an agent within 10 min) gets before it is refused without asking */
export const ASK_REFUSALS_PER_RUN = 3;
export const ASK_REFUSALS_PER_AGENT = 5;
/**
 * A refused always-ask action is not asked again in a loop: the same call in the same run is refused at once, and
 * after a few refusals of its class (per run, or per agent in 10 minutes) every further one is refused without a
 * card. Returns why, or null when the owner may be asked.
 */
export function repeatRefusal(
  db: Sqlite,
  o: { runId: string; agentId: string; cls: ActionClass; fp: string },
): string | null {
  const denied = "state IN ('denied','expired')";
  const same = db
    .prepare(
      `SELECT 1 FROM approvals WHERE run_id = ? AND ${denied} AND json_extract(action, '$.fp') = ? LIMIT 1`,
    )
    .get(o.runId, o.fp);
  if (same) return 'the owner already refused this exact action in this turn';
  const perRun = db
    .prepare(
      `SELECT count(*) AS n FROM approvals WHERE run_id = ? AND ${denied} AND json_extract(ask, '$.class') = ?`,
    )
    .get(o.runId, o.cls) as { n: number };
  if (perRun.n >= ASK_REFUSALS_PER_RUN) return `the owner refused ${perRun.n} ${o.cls} actions in this turn`;
  const perAgent = db
    .prepare(
      `SELECT count(*) AS n FROM approvals WHERE agent_id = ? AND ${denied} AND json_extract(ask, '$.class') = ? AND decided_at > ?`,
    )
    .get(o.agentId, o.cls, Date.now() - 10 * 60_000) as { n: number };
  if (perAgent.n >= ASK_REFUSALS_PER_AGENT)
    return `the owner refused ${perAgent.n} ${o.cls} actions in the last 10 minutes`;
  return null;
}

/** Real path of `p`, resolving its deepest existing ancestor (the target itself may not exist yet). */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...tail.reverse());
      } catch {
        return p;
      }
    }
    const up = dirname(cur);
    if (up === cur) return p;
    tail.push(basename(cur));
    cur = up;
  }
}
const within = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
/** A glob that names an absolute path, the home dir or a parent dir reaches outside whatever base it is given. */
const globEscapes = (g: unknown) =>
  typeof g === 'string' && (isAbsolute(g) || g.startsWith('~') || g.split(/[\\/]/).includes('..'));

/**
 * Workspace folders a provider CLI reads as its own config (lower case); a write, edit, move or delete into them is
 * tier 3. Every provider's folder counts, whichever provider this agent runs (the owner may switch it later): a file
 * there can widen what the CLI runs without asking, e.g. `.claude/settings*.json` permission rules and hooks,
 * `.gemini/settings.json` allowed tools and MCP servers, `.grok/settings.json`, `.codex/config.toml`, `.opencode/`.
 */
const CLI_CONFIG_DIRS = ['.claude', '.gemini', '.grok', '.codex', '.opencode'];

/** Prefix of the PasaBot gateway's own tools as the CLI names them; the gateway enforces their real tier. */
export const GATEWAY_TOOL_PREFIX = 'mcp__pasabot__';

/**
 * A provider CLI's own terminal or raw web/HTTP tool (7.1): it can send a message or pay with no classified tool in
 * between (a shell `curl`, an `osascript`), so the always-ask cards cannot see what it does. Names compared lower case
 * with `_`, `-` and spaces dropped; MCP tools (`mcp__…`) are never in this list (the gateway classes those itself).
 */
const SHELL_WEB_TOOLS = new Set([
  // terminals
  'bash',
  'bashoutput',
  'shell',
  'localshell',
  'execcommand',
  'exec',
  'runshellcommand',
  'runterminalcmd',
  'terminal',
  'powershell',
  'cmd',
  'writestdin',
  'acpexecute', // an ACP agent's (Gemini, Grok) `kind: 'execute'` call, as the provider names it
  // raw web / HTTP
  'acpfetch',
  'webfetch',
  'fetch',
  'urlfetch',
  'httprequest',
  'http',
  'curl',
  'wget',
]);
export function isShellOrRawWebTool(tool: string): boolean {
  if (tool.startsWith('mcp__')) return false;
  let n = '';
  for (const ch of tool.toLowerCase()) if (ch !== '_' && ch !== '-' && ch !== ' ' && ch !== '.') n += ch;
  return SHELL_WEB_TOOLS.has(n);
}
/** "Ask before terminal and raw web commands": the owner's choice, else on below `trusted` and off at `trusted`. */
export const asksBeforeShellWeb = (agent: { trustLevel: TrustLevel; askShellWeb?: boolean | null }) =>
  agent.askShellWeb ?? agent.trustLevel !== 'trusted';
/** May a provider CLI's own tool (permission bridge) run without a card? `autoApproves`, plus the shell/web toggle. */
export const cliToolAutoApproves = (
  tool: string,
  tier: ApprovalTier,
  agent: { trustLevel: TrustLevel; askShellWeb?: boolean | null },
  sender: SenderInfo,
) =>
  autoApproves(tier, agent.trustLevel, sender) && !(isShellOrRawWebTool(tool) && asksBeforeShellWeb(agent));

/** Tier of a provider CLI's own tool (permission bridge), by category. */
export function tierForCliTool(tool: string, input: unknown, workspace: string): ApprovalTier {
  const i = (input ?? {}) as Record<string, unknown>;
  const ws = realish(resolve(workspace));
  // lexical check first, then the real path (a symlink in the workspace may point anywhere)
  const inside = (p: unknown) => {
    if (typeof p !== 'string') return false;
    const abs = isAbsolute(p) ? p : resolve(workspace, p);
    return within(resolve(workspace), abs) && within(ws, realish(abs));
  };
  // a CLI's own config folder in the workspace (`.claude/`, `.gemini/`, … : settings with permission rules, allowed
  // tools, MCP servers and hooks, skills, commands, agents) is never a plain workspace write: a rule written there
  // would be an agent-granted "always allow" (ARCHITECTURE 7.1). Lexical and real path, compared case-blind (a
  // case-insensitive disk opens `.CLAUDE` the same).
  const inConfig = (p: unknown) => {
    if (typeof p !== 'string') return false;
    const abs = isAbsolute(p) ? p : resolve(workspace, p);
    const first = (root: string, q: string) => relative(root, q).split(/[\\/]/)[0]!.toLowerCase();
    return CLI_CONFIG_DIRS.some((d) => first(resolve(workspace), abs) === d || first(ws, realish(abs)) === d);
  };
  // gateway tools (`--strict-mcp-config` makes the `pasabot` server ours alone) are tiered again at tools/call
  if (tool.startsWith(GATEWAY_TOOL_PREFIX)) return 0;
  if (tool === 'Glob' && globEscapes(i.pattern)) return 3;
  if (tool === 'Grep' && globEscapes(i.glob)) return 3;
  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite'].includes(tool))
    return inside(i.file_path ?? i.path ?? workspace) ? 0 : 3;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    // every place the write touches: an ACP edit/move/delete names all its `locations` (a move's source and
    // destination), and any one outside the workspace or in a CLI config folder makes the whole call tier 3
    const targets = [i.file_path ?? i.notebook_path, ...(Array.isArray(i.locations) ? i.locations : [])];
    return targets.every((t) => inside(t) && !inConfig(t)) ? 1 : 3;
  }
  return 2; // shell, web, MCP tools and anything unknown: visible or outbound effect
}

export class ApprovalServiceImpl implements ApprovalService {
  private waiters = new Map<string, { resolve(d: Decision): void; timer: NodeJS.Timeout }>();
  /** expiry timers of detached approvals (nobody awaits them; the decision travels as an event) */
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private readonly d: {
      db: Sqlite;
      bus: EventBus;
      notifier: Notifier;
      defaultExpiresMs?: number;
      /** W24: the stored summary in the owner's saved language (channels, push and chat cards read it) */
      i18n?: ServerI18n;
    },
  ) {
    // approvals left pending by an earlier boot have no waiting run any more; detached ones outlive a restart
    d.db
      .prepare(
        "UPDATE approvals SET state = 'expired', decided_at = ? WHERE state = 'pending' AND subject IS NULL",
      )
      .run(Date.now());
    for (const r of d.db
      .prepare("SELECT id, expires_at FROM approvals WHERE state = 'pending' AND subject IS NOT NULL")
      .all() as { id: string; expires_at: number }[])
      this.armExpiry(r.id, r.expires_at);
  }

  private armExpiry(id: string, expiresAt: number) {
    // setTimeout caps at ~24.8 days; a longer wait is re-armed when it fires early
    const wait = Math.min(Math.max(0, expiresAt - Date.now()), 2 ** 31 - 1);
    const timer = setTimeout(() => {
      const r = this.get(id);
      if (r?.state !== 'pending') return;
      if (r.expiresAt > Date.now()) this.armExpiry(id, r.expiresAt);
      else this.finish(id, 'expired', null);
    }, wait);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Files a detached approval (a workflow step); idempotent while one with the same subject is pending. */
  /** the summary a person reads: `msg` in the owner's saved language, else the English one */
  private summaryOf(r: { summary: string; msg?: Msg }): string {
    if (!r.msg || !this.d.i18n) return r.summary;
    try {
      return this.d.i18n.render(r.msg).slice(0, 500) || r.summary;
    } catch {
      return r.summary;
    }
  }
  private static readonly NEEDED: Msg = { key: 'core:server.approvalNeeded' };

  open(raw: DetachedApprovalRequest): string {
    const r = { ...raw, summary: this.summaryOf(raw) };
    const { db, bus } = this.d;
    const existing = db
      .prepare("SELECT id FROM approvals WHERE subject = ? AND state = 'pending'")
      .get(r.subject) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = ulid();
    const expiresAt = Date.now() + (r.expiresInMs ?? this.d.defaultExpiresMs ?? 30 * 60_000);
    db.prepare(
      'INSERT INTO approvals (id, subject, href, tier, action, summary, expires_at, ask, nonce) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      r.subject,
      r.href ?? null,
      r.tier,
      JSON.stringify(r.action ?? {}),
      r.summary,
      expiresAt,
      r.ask ? JSON.stringify(r.ask) : null,
      newNonce(),
    );
    this.armExpiry(id, expiresAt);
    bus.publish('owner', 'approval.requested', this.get(id)!);
    void this.d.notifier
      .notify({
        level: 'info',
        title: 'Approval needed',
        body: r.summary,
        msg: { title: ApprovalServiceImpl.NEEDED },
        category: 'approval',
        ...(r.href ? { href: r.href } : {}),
      })
      .catch(() => {});
    return id;
  }

  /** A pending detached approval nobody needs any more (its run was cancelled) ends as `expired`. */
  withdraw(id: string): void {
    if (this.get(id)?.subject) this.finish(id, 'expired', null);
  }

  /**
   * W31 global stop: every pending approval (run-bound and detached) ends as `expired`, so a card still showing in
   * the app or a channel can no longer be approved into an action while everything is stopped.
   */
  expireAllPending(): ApprovalDTO[] {
    const ids = this.d.db.prepare("SELECT id FROM approvals WHERE state = 'pending'").all() as {
      id: string;
    }[];
    const out: ApprovalDTO[] = [];
    for (const { id } of ids) {
      const dto = this.finish(id, 'expired', null);
      if (dto) out.push(dto);
    }
    return out;
  }

  get(id: string): ApprovalDTO | null {
    const r = this.d.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    return r ? toDTO(r) : null;
  }
  list(state?: ApprovalDTO['state']): ApprovalDTO[] {
    const rows = (
      state
        ? this.d.db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY expires_at').all(state)
        : this.d.db.prepare('SELECT * FROM approvals ORDER BY expires_at DESC LIMIT 200').all()
    ) as ApprovalRow[];
    return rows.map(toDTO);
  }

  private chatOf(runId: string | null): string | null {
    if (!runId) return null;
    const r = this.d.db
      .prepare('SELECT q.chat_id FROM runs r JOIN queue_items q ON q.id = r.queue_item_id WHERE r.id = ?')
      .get(runId) as { chat_id: string | null } | undefined;
    return r?.chat_id ?? null;
  }

  async request(raw: ApprovalRequest): Promise<Decision> {
    const r = { ...raw, summary: this.summaryOf(raw) };
    const { db, bus } = this.d;
    // ARCHITECTURE 8 "Screen helpers": at most one computer-use approval pending per agent (checked and filed in the
    // same tick, so two parallel calls cannot both get a card); the second is refused without a card
    if (r.screen && this.hasPendingScreen(r.agentId)) return 'denied';
    const id = ulid();
    const now = Date.now();
    const expiresAt = now + (r.expiresInMs ?? this.d.defaultExpiresMs ?? 30 * 60_000);
    db.prepare(
      'INSERT INTO approvals (id, run_id, agent_id, tier, action, summary, expires_at, ask, nonce, screen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      r.runId,
      r.agentId,
      r.tier,
      JSON.stringify(r.action ?? {}),
      r.summary,
      expiresAt,
      r.ask ? JSON.stringify(r.ask) : null,
      newNonce(),
      r.screen ? 1 : 0,
    );
    // the waiter + expiry timer exist before anything can decide the approval (a fast client, close())
    const decided = new Promise<Decision>((resolveDecision) => {
      const timer = setTimeout(() => this.finish(id, 'expired', null), Math.max(0, expiresAt - now));
      timer.unref?.();
      this.waiters.set(id, { resolve: resolveDecision, timer });
    });
    const dto = this.get(id)!;
    const chatId = this.chatOf(r.runId);
    bus.publish(`agent:${r.agentId}`, 'approval.requested', dto);
    if (chatId) {
      bus.publish(`chat:${chatId}`, 'approval.requested', dto);
      this.writeCard(chatId, dto, true);
    }
    try {
      await this.d.notifier.notify({
        level: 'info',
        title: 'Approval needed',
        body: r.summary,
        msg: { title: ApprovalServiceImpl.NEEDED },
        category: 'approval',
        ...(chatId ? { href: `/chats/${chatId}` } : {}),
      });
    } catch {
      // a failed notification never strands the run: the card and the expiry still stand
    }
    return decided;
  }

  /** Owner decision (server code: REST after its checks, channel replies, tests); null when not pending any more. */
  decide(id: string, decision: 'approved' | 'denied', userId: string): ApprovalDTO | null {
    return this.finish(id, decision, userId);
  }

  /** Only the owner's own web session may approve this (tier 3, or an always-ask card): never a channel or module. */
  static deviceOnly(a: Pick<ApprovalDTO, 'tier' | 'ask' | 'screen'> | null | undefined): boolean {
    return !!a && (a.tier >= 3 || !!a.ask || !!a.screen);
  }

  // ---------- screen helpers (ARCHITECTURE 8 "Screen helpers") ----------
  private screenRunning = 0;
  private screenEndedAt = 0;
  private screenGrantAt = 0;
  /** an agent's computer-use action starts (the gateway, around the tool call); pair with `screenActionEnded` */
  screenActionStarted(): void {
    this.screenRunning++;
  }
  screenActionEnded(): void {
    this.screenRunning = Math.max(0, this.screenRunning - 1);
    this.screenEndedAt = Date.now();
  }
  /** a computer-use action runs now, or ended less than 2 s ago: no approval of any kind goes through */
  screenBusy(now = Date.now()): boolean {
    return this.screenRunning > 0 || now - this.screenEndedAt < SCREEN_QUIET_MS;
  }
  /** a helper was just handed control of a screen the owner uses (a grant was issued) */
  noteScreenGrant(): void {
    this.screenGrantAt = Date.now();
  }
  /** a helper got a grant in the last 30 s: sensitive approvals need a fresh re-auth for that one card */
  screenActive(now = Date.now()): boolean {
    return now - this.screenGrantAt < SCREEN_ACTIVE_MS;
  }
  hasPendingScreen(agentId: string): boolean {
    return !!this.d.db
      .prepare("SELECT 1 FROM approvals WHERE agent_id = ? AND screen = 1 AND state = 'pending' LIMIT 1")
      .get(agentId);
  }
  /**
   * Does approving `a` need a fresh re-auth for this one card (never the 5-minute window)? Every computer-use card;
   * and while a helper is active, every card that pays, deletes, messages other people, opens the vault or changes
   * trust or permissions (tier 3 or an always-ask card).
   */
  needsFreshReauth(a: Pick<ApprovalDTO, 'tier' | 'ask' | 'screen'>, now = Date.now()): boolean {
    return !!a.screen || (this.screenActive(now) && (a.tier >= 3 || !!a.ask));
  }

  /**
   * The port modules get (`ModuleHost.approvals`): the same service, except that `decide` refuses to approve a tier-3
   * or always-ask approval (money, outbound messages), which only the REST route under an owner session answers.
   */
  forModules(): ApprovalService {
    return {
      request: (r) => this.request(r),
      open: (r) => this.open(r),
      get: (id) => {
        const a = this.get(id);
        return a ? withoutNonce(a) : null;
      },
      withdraw: (id) => this.withdraw(id),
      // a channel or module yes never approves while a helper just used the screen (it may be that helper's click)
      decide: (id, decision, by) =>
        decision === 'approved' && (ApprovalServiceImpl.deviceOnly(this.get(id)) || this.screenBusy())
          ? null
          : this.decide(id, decision, by),
      noteScreenGrant: () => this.noteScreenGrant(),
    };
  }

  private finish(id: string, state: Decision, by: string | null): ApprovalDTO | null {
    const res = this.d.db
      .prepare(
        "UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(state, by, Date.now(), id);
    if (res.changes !== 1) return null;
    const dto = this.get(id)!;
    if (dto.agentId) this.d.bus.publish(`agent:${dto.agentId}`, 'approval.resolved', dto);
    if (dto.subject) this.d.bus.publish('owner', 'approval.resolved', dto);
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    const chatId = this.chatOf(dto.runId);
    if (chatId) {
      this.d.bus.publish(`chat:${chatId}`, 'approval.resolved', dto);
      this.writeCard(chatId, dto, false);
    }
    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve(state);
    }
    return dto;
  }

  /** The approval card is a system message whose id is derived from the approval id. */
  private writeCard(chatId: string, a: ApprovalDTO, create: boolean) {
    const { db, bus } = this.d;
    const msgId = `apv-${a.id}`;
    const blocks = [{ kind: APPROVAL_BLOCK, v: 1, data: a }];
    const now = Date.now();
    if (create) {
      db.prepare(
        "INSERT INTO messages (id, chat_id, author_kind, body, blocks, status, run_id, created_at) VALUES (?, ?, 'system', ?, ?, 'final', ?, ?)",
      ).run(msgId, chatId, a.summary, JSON.stringify(blocks), a.runId, now);
    } else {
      db.prepare('UPDATE messages SET blocks = ?, edited_at = ? WHERE id = ?').run(
        JSON.stringify(blocks),
        now,
        msgId,
      );
    }
    const row = db.prepare('SELECT created_at, edited_at FROM messages WHERE id = ?').get(msgId) as
      | { created_at: number; edited_at: number | null }
      | undefined;
    const msg: MessageDTO = {
      id: msgId,
      chatId,
      authorKind: 'system',
      authorId: null,
      replyTo: null,
      body: a.summary,
      blocks: blocks as MessageDTO['blocks'],
      status: 'final',
      runId: a.runId,
      createdAt: row?.created_at ?? now,
      editedAt: row?.edited_at ?? null,
    };
    bus.publish(`chat:${chatId}`, create ? 'message.created' : 'message.updated', msg);
  }

  /** Server shutdown: every waiting run gets `expired` (= denied). */
  close() {
    for (const id of [...this.waiters.keys()]) this.finish(id, 'expired', null);
    // detached approvals stay pending across the restart; only their timers stop
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * `reauthed(sessionId)`: approving tier 3 needs a recent re-auth of the deciding session (8, "Stolen device");
   * without it the approve answers 401 `reauth_required` and the approval stays pending. Deny never needs it.
   * `freshReauth(sessionId, approvalId)`: takes (once) a re-auth this session made for this one card just now; a
   * computer-use card, and a sensitive card while a helper is active, need it (8, "Screen helpers").
   */
  registerRoutes(
    app: FastifyInstance,
    resolveAuth: AuthResolver,
    opts: {
      reauthed?: (sessionId: string) => boolean;
      freshReauth?: (sessionId: string, approvalId: string) => boolean;
    } = {},
  ) {
    const owner = (req: { headers: Record<string, string | string[] | undefined>; ip: string }) => {
      const p = resolveAuth(req);
      return p?.kind === 'session' && p.userKind === 'owner' ? p : null;
    };
    // 7.1 "Always asks": money and outbound messages always; the owner may add classes, never remove those two.
    // Owner session only (adding narrows, but the list is the owner's own setting, never a tool).
    const view = () => {
      const all = alwaysAskClasses(this.d.db);
      return {
        fixed: [...FIXED_ALWAYS_ASK],
        extra: ACTION_CLASSES.filter((c) => all.has(c) && !FIXED_ALWAYS_ASK.includes(c)),
        available: ACTION_CLASSES.filter((c) => !FIXED_ALWAYS_ASK.includes(c)),
      };
    };
    app.get('/api/v1/settings/always-ask', async (req, reply) => {
      if (!owner(req)) return reply.code(401).send({ error: 'unauthorized' });
      return view();
    });
    app.put('/api/v1/settings/always-ask', async (req, reply) => {
      if (!owner(req)) return reply.code(401).send({ error: 'unauthorized' });
      const b = z
        .object({ extra: z.array(actionClassSchema).max(16) })
        .strict()
        .safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid_input' });
      setAlwaysAskExtra(this.d.db, b.data.extra);
      return view();
    });
    app.get('/api/v1/approvals', async (req, reply) => {
      if (!owner(req)) return reply.code(401).send({ error: 'unauthorized' });
      const state = (req.query as { state?: ApprovalDTO['state'] }).state;
      return { approvals: this.list(state) };
    });
    for (const [verb, decision] of [
      ['approve', 'approved'],
      ['deny', 'denied'],
    ] as const) {
      // owner-only, REST-only: never reachable through /mcp (7.4)
      app.post(`/api/v1/approvals/:id/${verb}`, async (req, reply) => {
        const p = owner(req);
        if (!p) return reply.code(401).send({ error: 'unauthorized' });
        const id = (req.params as { id: string }).id;
        if (decision === 'approved') {
          const current = this.get(id);
          if (!current || current.state !== 'pending') return reply.code(409).send({ error: 'not_pending' });
          // 8 "Screen helpers": a helper's synthetic click may be what pressed Approve; nothing goes through while
          // a computer-use action runs or just ran (deny still does: refusing is always safe)
          if (this.screenBusy())
            return reply.code(409).send({ error: 'screen_busy', message: SCREEN_BUSY_TEXT });
          // the card's own nonce: one card's answer never approves another, and a made-up request has none
          const nonce = (req.body as { nonce?: unknown } | undefined)?.nonce;
          if (!sameNonce(nonce, current.nonce)) return reply.code(403).send({ error: 'wrong_card' });
          if (this.needsFreshReauth(current)) {
            // a re-auth for this one card, made just now; the 5-minute window never counts here
            if (!opts.freshReauth?.(p.sessionId, id))
              return reply.code(401).send({ error: 'reauth_required', fresh: true });
          } else if (
            opts.reauthed &&
            current.tier >= 3 &&
            !opts.reauthed(p.sessionId) &&
            // a re-auth made for this very card counts too (the app's sheet makes one per card)
            !opts.freshReauth?.(p.sessionId, id)
          )
            return reply.code(401).send({ error: 'reauth_required' });
        }
        // the re-auth was checked above, so this goes straight to the decision
        const dto = this.finish(id, decision, p.userId);
        if (!dto) return reply.code(409).send({ error: 'not_pending' });
        return { approval: dto };
      });
    }
  }
}
