/** Crash-safe per-agent queue (ARCHITECTURE.md 6). All writes are synchronous better-sqlite3 transactions. */
import {
  type EnqueueInput,
  type EventBus,
  type Logger,
  QUEUE_PRIORITY,
  type QueueGate,
  type QueueGateVerdict,
  type QueueKindSpec,
  type QueueService,
  type SenderInfo,
  ulid,
} from '@pasabot/core';
import type { CoreDatabase, Sqlite } from '@pasabot/db';
import type { QueueItemDTO, QueueState, RunDTO } from '@pasabot/protocol';

export type QueueRow = CoreDatabase['queue_items'];

export class QueueError extends Error {
  constructor(
    readonly code: 'queue_full' | 'unknown_kind' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

type SenderLike = { kind?: unknown; id?: unknown };
const ACTIVE: QueueState[] = ['queued', 'leased', 'running', 'held', 'interrupted'];
const CORE_KINDS: Record<string, QueueKindSpec> = {
  message: { priority: QUEUE_PRIORITY.chat, blocksOnInterrupt: true },
  task: { priority: QUEUE_PRIORITY.task, blocksOnInterrupt: true },
  handoff: { priority: QUEUE_PRIORITY.handoff, blocksOnInterrupt: true },
  routine: { priority: QUEUE_PRIORITY.routine, blocksOnInterrupt: false, idempotent: true },
  workflow: { priority: QUEUE_PRIORITY.workflow, blocksOnInterrupt: false },
};
/** Max automatic attempts for items of an `idempotent` kind whose payload says `retryOnCrash: true`. */
export const MAX_CRASH_ATTEMPTS = 3;

export const toQueueDTO = (r: QueueRow): QueueItemDTO => ({
  id: r.id,
  agentId: r.agent_id,
  chatId: r.chat_id,
  seq: r.seq,
  priority: r.priority,
  kind: r.kind,
  state: r.state,
  attempts: r.attempts,
  resumeAt: r.resume_at,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
});

export interface QueueOptions {
  depthCap?: number;
  leaseMs?: number;
  now?: () => number;
  /** the server's (redacted) log: where a crashing gate's details go, never into the visible hold reason */
  log?: Logger;
}
/** the visible reason of an item held because a gate threw (the exception stays in the log) */
export const GATE_FAILED_REASON = 'held: a safety check could not run; it tries again in a minute';

export class SqliteQueue implements QueueService {
  private kinds = new Map(Object.entries(CORE_KINDS));
  private changeListeners = new Set<(agentId: string) => void>();
  private gates = new Set<QueueGate>();
  /** set by the dispatcher so cancel() can abort a running item */
  abortRunning: (id: string) => boolean = () => false;
  readonly depthCap: number;
  readonly leaseMs: number;
  private now: () => number;
  private log: Logger | undefined;

  constructor(
    private readonly db: Sqlite,
    private readonly bus: EventBus | null,
    opts: QueueOptions = {},
  ) {
    this.depthCap = opts.depthCap ?? 50;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
  }

  registerKind(kind: string, spec: QueueKindSpec): void {
    if (this.kinds.has(kind) && CORE_KINDS[kind]) throw new Error(`queue kind "${kind}" is a core kind`);
    if (spec.idempotent && spec.blocksOnInterrupt)
      throw new Error(`queue kind "${kind}": a blocksOnInterrupt kind cannot be idempotent`);
    this.kinds.set(kind, spec);
  }
  kindSpec(kind: string): QueueKindSpec | undefined {
    return this.kinds.get(kind);
  }
  /** The kind's `admit` verdict for a leased item: a refusal reason, or null to run it (a throw refuses). */
  admitRefusal(row: QueueRow): string | null {
    // a member or guest the owner turned off (W23) never gets another turn, whatever the kind
    if (this.disabledPerson(row)) return 'refused: the person who asked for this was turned off';
    const admit = this.kinds.get(row.kind)?.admit;
    if (!admit) return null;
    try {
      return admit({
        id: row.id,
        agentId: row.agent_id,
        kind: row.kind,
        payload: safeJson(row.payload),
        source: safeJson(row.source),
      });
    } catch (e) {
      return `refused: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  addGate(gate: QueueGate): () => void {
    this.gates.add(gate);
    return () => this.gates.delete(gate);
  }
  /** The gates' verdict for a leased item: the first refusal or hold wins; a throwing gate holds it for a minute. */
  gateVerdict(row: QueueRow): QueueGateVerdict {
    for (const gate of this.gates) {
      try {
        const v = gate({
          id: row.id,
          agentId: row.agent_id,
          chatId: row.chat_id,
          kind: row.kind,
          payload: safeJson(row.payload),
          source: safeJson(row.source),
        });
        if (v) return v;
      } catch (e) {
        // the exception may name anything (a path, a value): it goes to the redacted log only
        this.log?.error('queue gate failed', {
          item: row.id,
          kind: row.kind,
          error: e instanceof Error ? e.message : String(e),
        });
        return { hold: { until: this.now() + 60_000, reason: GATE_FAILED_REASON } };
      }
    }
    return null;
  }
  /** A dispatch-time refusal (admit or gate): `cancelled` with the reason, and `queue.refused` for its owner module. */
  refuse(id: string, reason: string): void {
    this.setState(id, 'cancelled', { finished: true, error: reason });
    const r = this.getRow(id);
    if (!r) return;
    const wf = (safeJson(r.source) as { workflowRunId?: unknown } | null)?.workflowRunId;
    this.bus?.publish(`agent:${r.agent_id}`, 'queue.refused', {
      itemId: r.id,
      agentId: r.agent_id,
      chatId: r.chat_id,
      kind: r.kind,
      reason,
      ...(typeof wf === 'string' ? { workflowRunId: wf } : {}),
    });
    this.changed(r.agent_id);
  }
  private disabledPerson(row: QueueRow): boolean {
    const src = safeJson(row.source) as { sender?: SenderLike; origin?: SenderLike } | null;
    for (const who of [src?.sender, src?.origin]) {
      if (!who || (who.kind !== 'member' && who.kind !== 'guest') || typeof who.id !== 'string') continue;
      const u = this.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(who.id) as
        | { disabled_at: number | null }
        | undefined;
      if (u?.disabled_at != null) return true;
    }
    return false;
  }
  onChange(fn: (agentId: string) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  enqueue(input: EnqueueInput): { item: QueueItemDTO; duplicate: boolean } {
    const spec = this.kinds.get(input.kind);
    if (!spec) throw new QueueError('unknown_kind', `unknown queue kind "${input.kind}"`);
    const tx = this.db.transaction((): { row: QueueRow; duplicate: boolean } => {
      if (input.idemKey) {
        const dup = this.db.prepare('SELECT * FROM queue_items WHERE idem_key = ?').get(input.idemKey) as
          | QueueRow
          | undefined;
        if (dup) return { row: dup, duplicate: true };
      }
      const { n } = this.db
        .prepare(
          `SELECT count(*) AS n FROM queue_items WHERE agent_id = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`,
        )
        .get(input.agentId, ...ACTIVE) as { n: number };
      if (n >= this.depthCap) throw new QueueError('queue_full', `queue for agent ${input.agentId} is full`);
      const { s } = this.db
        .prepare('SELECT coalesce(max(seq), 0) + 1 AS s FROM queue_items WHERE agent_id = ?')
        .get(input.agentId) as { s: number };
      const row: QueueRow = {
        id: ulid(),
        agent_id: input.agentId,
        chat_id: input.chatId ?? null,
        seq: s,
        priority: input.priority ?? spec.priority,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        source: JSON.stringify(input.source ?? {}),
        idem_key: input.idemKey ?? null,
        state: 'queued',
        attempts: 0,
        lease_owner: null,
        lease_until: null,
        resume_at: null,
        created_at: this.now(),
        started_at: null,
        finished_at: null,
        error: null,
      };
      this.db
        .prepare(
          `INSERT INTO queue_items (id, agent_id, chat_id, seq, priority, kind, payload, source, idem_key, state, attempts, created_at)
           VALUES (@id, @agent_id, @chat_id, @seq, @priority, @kind, @payload, @source, @idem_key, @state, @attempts, @created_at)`,
        )
        .run(row);
      return { row, duplicate: false };
    });
    const { row, duplicate } = tx.immediate();
    if (!duplicate) this.changed(input.agentId);
    return { item: toQueueDTO(row), duplicate };
  }

  getRow(id: string): QueueRow | null {
    return (
      (this.db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as QueueRow | undefined) ?? null
    );
  }
  hasIdem(idemKey: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM queue_items WHERE idem_key = ?').get(idemKey);
  }
  get(id: string): QueueItemDTO | null {
    const r = this.getRow(id);
    return r ? toQueueDTO(r) : null;
  }
  input(id: string): { payload: unknown; source: { sender?: SenderInfo; [k: string]: unknown } } | null {
    const r = this.getRow(id);
    if (!r) return null;
    const source = safeJson(r.source);
    return {
      payload: safeJson(r.payload),
      source: source && typeof source === 'object' ? (source as { sender?: SenderInfo }) : {},
    };
  }
  list(agentId: string, opts: { includeFinished?: boolean } = {}): QueueItemDTO[] {
    const where = opts.includeFinished ? '' : `AND state IN (${ACTIVE.map((s) => `'${s}'`).join(',')})`;
    return (
      this.db
        .prepare(`SELECT * FROM queue_items WHERE agent_id = ? ${where} ORDER BY priority, seq`)
        .all(agentId) as QueueRow[]
    ).map(toQueueDTO);
  }
  isPaused(agentId: string): boolean {
    const r = this.db.prepare('SELECT paused FROM agent_queue_state WHERE agent_id = ?').get(agentId) as
      | { paused: number }
      | undefined;
    return r?.paused === 1;
  }
  pause(agentId: string, reason?: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_queue_state (agent_id, paused, paused_reason) VALUES (?, 1, ?)
         ON CONFLICT(agent_id) DO UPDATE SET paused = 1, paused_reason = excluded.paused_reason`,
      )
      .run(agentId, reason ?? null);
    this.changed(agentId);
  }
  resume(agentId: string): void {
    this.db
      .prepare('UPDATE agent_queue_state SET paused = 0, paused_reason = NULL WHERE agent_id = ?')
      .run(agentId);
    this.changed(agentId);
  }
  cancel(id: string): boolean {
    const r = this.getRow(id);
    if (!r) return false;
    if (r.state === 'running' || r.state === 'leased') return this.abortRunning(id);
    if (r.state !== 'queued' && r.state !== 'held') return false;
    this.setState(id, 'cancelled', { finished: true });
    this.changed(r.agent_id);
    return true;
  }
  /** interrupted|failed -> queued, keeping seq so it runs before anything queued after it. */
  retry(id: string): boolean {
    const r = this.getRow(id);
    if (!r || (r.state !== 'interrupted' && r.state !== 'failed')) return false;
    this.db
      .prepare("UPDATE queue_items SET state = 'queued', error = NULL, finished_at = NULL WHERE id = ?")
      .run(id);
    this.changed(r.agent_id);
    return true;
  }
  /** interrupted -> cancelled, unblocking the agent's queue. */
  skip(id: string): boolean {
    const r = this.getRow(id);
    if (r?.state !== 'interrupted') return false;
    this.setState(id, 'cancelled', { finished: true });
    this.changed(r.agent_id);
    return true;
  }
  hold(id: string, resumeAt: number, error?: string): void {
    const r = this.getRow(id);
    if (!r) return;
    this.db
      .prepare(
        "UPDATE queue_items SET state = 'held', resume_at = ?, error = ?, lease_owner = NULL, lease_until = NULL WHERE id = ?",
      )
      .run(resumeAt, error ?? null, id);
    this.changed(r.agent_id);
  }

  // ---------- dispatcher side ----------
  private blockingKinds(): string[] {
    return [...this.kinds].filter(([, s]) => s.blocksOnInterrupt).map(([k]) => k);
  }
  /** Agents that have queued work and are not paused. */
  agentsWithWork(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT q.agent_id AS a FROM queue_items q
           LEFT JOIN agent_queue_state s ON s.agent_id = q.agent_id
           WHERE q.state = 'queued' AND coalesce(s.paused, 0) = 0 ORDER BY q.agent_id`,
        )
        .all() as { a: string }[]
    ).map((r) => r.a);
  }
  /** Is the agent's queue blocked behind an interrupted conversational item? */
  blockedBy(agentId: string): QueueRow | null {
    const kinds = this.blockingKinds();
    if (kinds.length === 0) return null;
    return (
      (this.db
        .prepare(
          `SELECT * FROM queue_items WHERE agent_id = ? AND state = 'interrupted' AND kind IN (${kinds.map(() => '?').join(',')})
           ORDER BY priority, seq LIMIT 1`,
        )
        .get(agentId, ...kinds) as QueueRow | undefined) ?? null
    );
  }
  /** Lease the head item (priority, seq) iff nothing else of this agent is leased/running and it is not blocked. */
  leaseNext(agentId: string, owner: string): QueueRow | null {
    const tx = this.db.transaction((): QueueRow | null => {
      if (this.isPaused(agentId)) return null;
      const busy = this.db
        .prepare("SELECT 1 FROM queue_items WHERE agent_id = ? AND state IN ('leased','running') LIMIT 1")
        .get(agentId);
      if (busy || this.blockedBy(agentId)) return null;
      const head = this.db
        .prepare(
          "SELECT * FROM queue_items WHERE agent_id = ? AND state = 'queued' ORDER BY priority, seq LIMIT 1",
        )
        .get(agentId) as QueueRow | undefined;
      if (!head) return null;
      const now = this.now();
      this.db
        .prepare(
          "UPDATE queue_items SET state = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?",
        )
        .run(owner, now + this.leaseMs, head.id);
      return {
        ...head,
        state: 'leased',
        lease_owner: owner,
        lease_until: now + this.leaseMs,
        attempts: head.attempts + 1,
      };
    });
    return tx.immediate();
  }
  markRunning(id: string, owner: string): void {
    this.db
      .prepare(
        "UPDATE queue_items SET state = 'running', started_at = ?, lease_until = ? WHERE id = ? AND lease_owner = ?",
      )
      .run(this.now(), this.now() + this.leaseMs, id, owner);
    const r = this.getRow(id);
    if (r) this.changed(r.agent_id);
  }
  renew(id: string, owner: string): void {
    this.db
      .prepare(
        "UPDATE queue_items SET lease_until = ? WHERE id = ? AND lease_owner = ? AND state IN ('leased','running')",
      )
      .run(this.now() + this.leaseMs, id, owner);
  }
  finish(id: string, state: 'done' | 'failed' | 'cancelled', error?: string): void {
    this.setState(id, state, { finished: true, error });
    const r = this.getRow(id);
    if (r) this.changed(r.agent_id);
  }
  /** held items whose resume_at passed go back to queued. */
  releaseHeld(): number {
    const rows = this.db
      .prepare("SELECT id, agent_id FROM queue_items WHERE state = 'held' AND resume_at <= ?")
      .all(this.now()) as { id: string; agent_id: string }[];
    for (const r of rows) {
      this.db.prepare("UPDATE queue_items SET state = 'queued', resume_at = NULL WHERE id = ?").run(r.id);
      this.changed(r.agent_id);
    }
    return rows.length;
  }
  /**
   * Lease recovery (at boot, and by the dispatcher's runtime sweep with `skip` = items it is still running).
   * `leased` -> `queued` (nothing ran). `running` whose lease belongs to another boot or has expired ->
   * `interrupted` (never retried automatically), except items of an `idempotent` kind whose payload says
   * `retryOnCrash: true` and that still have attempts left, which requeue. One server owns a $PASABOT_HOME, so a
   * lease from another boot is dead. The crashed turns' `runs` rows become `interrupted` and their run bearers are
   * revoked in the same transaction; `run.finished` is published after commit.
   */
  recover(
    bootId: string,
    opts: { skip?: ReadonlySet<string> } = {},
  ): { requeued: QueueRow[]; interrupted: QueueRow[] } {
    const skip = opts.skip ?? new Set<string>();
    const tx = this.db.transaction(() => {
      const now = this.now();
      const requeued = (
        this.db
          .prepare(
            "SELECT * FROM queue_items WHERE state = 'leased' AND (lease_owner IS NOT ? OR lease_until < ?)",
          )
          .all(bootId, now) as QueueRow[]
      ).filter((r) => !skip.has(r.id));
      const crashed = (
        this.db
          .prepare(
            "SELECT * FROM queue_items WHERE state = 'running' AND (lease_owner IS NOT ? OR lease_until < ?)",
          )
          .all(bootId, now) as QueueRow[]
      ).filter((r) => !skip.has(r.id));
      const interrupted: QueueRow[] = [];
      for (const r of requeued) {
        this.db
          .prepare(
            "UPDATE queue_items SET state = 'queued', lease_owner = NULL, lease_until = NULL, attempts = max(attempts - 1, 0) WHERE id = ?",
          )
          .run(r.id);
      }
      const finishedRuns: { id: string; agent_id: string }[] = [];
      for (const r of crashed) {
        const payload = safeJson(r.payload) as { retryOnCrash?: boolean } | null;
        const idempotent = this.kinds.get(r.kind)?.idempotent === true;
        if (idempotent && payload?.retryOnCrash === true && r.attempts < MAX_CRASH_ATTEMPTS) {
          this.db
            .prepare(
              "UPDATE queue_items SET state = 'queued', lease_owner = NULL, lease_until = NULL WHERE id = ?",
            )
            .run(r.id);
          requeued.push(r);
        } else {
          this.db
            .prepare(
              "UPDATE queue_items SET state = 'interrupted', lease_owner = NULL, lease_until = NULL, finished_at = ?, error = 'interrupted' WHERE id = ?",
            )
            .run(now, r.id);
          interrupted.push({ ...r, state: 'interrupted' });
        }
        // the crashed turn is over either way: close its run and kill its run bearer
        const runs = this.db
          .prepare("SELECT id, agent_id FROM runs WHERE queue_item_id = ? AND state = 'running'")
          .all(r.id) as { id: string; agent_id: string }[];
        for (const run of runs) {
          this.db
            .prepare(
              "UPDATE runs SET state = 'interrupted', finished_at = ?, stop_reason = coalesce(stop_reason, 'interrupted') WHERE id = ?",
            )
            .run(now, run.id);
          this.db
            .prepare('UPDATE run_tokens SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL')
            .run(now, run.id);
          finishedRuns.push(run);
        }
      }
      return { requeued, interrupted, finishedRuns };
    });
    const { finishedRuns, ...res } = tx.immediate();
    for (const run of finishedRuns) {
      const dto = runDTO(this.db, run.id);
      if (dto) this.bus?.publish(`agent:${run.agent_id}`, 'run.finished', dto);
    }
    for (const a of new Set([...res.requeued, ...res.interrupted].map((r) => r.agent_id))) this.changed(a);
    return res;
  }

  private setState(id: string, state: QueueState, o: { finished?: boolean; error?: string } = {}) {
    this.db
      .prepare(
        'UPDATE queue_items SET state = ?, lease_owner = NULL, lease_until = NULL, finished_at = ?, error = ? WHERE id = ?',
      )
      .run(state, o.finished ? this.now() : null, o.error ?? null, id);
  }
  private changed(agentId: string) {
    this.bus?.publish(`agent:${agentId}`, 'queue.changed', {
      agentId,
      items: this.list(agentId),
      paused: this.isPaused(agentId),
    });
    for (const l of this.changeListeners) l(agentId);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** `runs` row -> RunDTO (shared by the run executor and lease recovery). */
export function runDTO(db: Sqlite, id: string): RunDTO | null {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as CoreDatabase['runs'] | undefined;
  if (!r) return null;
  return {
    id: r.id,
    queueItemId: r.queue_item_id,
    agentId: r.agent_id,
    providerId: r.provider_id,
    model: r.model,
    state: r.state,
    usage: r.usage ? JSON.parse(r.usage) : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    stopReason: r.stop_reason,
  } as RunDTO;
}
