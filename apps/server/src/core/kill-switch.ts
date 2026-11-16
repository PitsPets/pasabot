/**
 * The global stop (W31, ARCHITECTURE 12). One stored flag in `kill_switch`, read at boot before the dispatcher
 * leases anything. `stopAll` cancels every running queue item, leaves every waiting one `held` (with the stop marker,
 * so a resume releases exactly those), runs every module's `onStop` handler and keeps new work held until `resume`.
 * Any actor may stop; only an owner session with a fresh re-auth may resume.
 */
import {
  KillSwitchError,
  type KillSwitch as KillSwitchPort,
  type Logger,
  type StopActor,
  type StopHandler,
  type StoppedItem,
  type StopReport,
  type StopState,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { SqliteQueue } from './queue.js';

/** `error` of a queue item the stop left held; a resume releases exactly these. */
export const STOP_HOLD_ERROR = 'pasabot:stopped';
/** abort reason the dispatcher uses for items a stop cancels */
export const STOP_ABORT_REASON = 'pasabot:stopped';
/** far future: held items with this resume time never release on their own */
const NEVER = 8.64e15;

export interface StopDispatcher {
  /** abort every running item with `reason`, wait for them to settle, return their item ids */
  cancelAll(reason: string): Promise<string[]>;
}

interface Row {
  stopped: number;
  since: number | null;
  actor_kind: string | null;
  actor_id: string | null;
  reason: string | null;
  report: string | null;
}

const actorId = (a: StopActor): string => {
  switch (a.kind) {
    case 'owner':
      return a.userId;
    case 'linked-machine':
    case 'channel':
      return a.id;
    case 'automation':
      return a.tokenId;
    case 'agent':
      return a.agentId;
    case 'system':
      return a.reason;
  }
};

export class KillSwitch implements KillSwitchPort {
  private handlers = new Set<StopHandler>();
  private watchers = new Set<(s: StopState) => void>();
  private dispatcher: StopDispatcher | null = null;
  private cached: boolean;

  constructor(
    private readonly db: Sqlite,
    private readonly queue: SqliteQueue,
    private readonly log?: Logger,
  ) {
    this.cached = this.row().stopped === 1;
  }

  bindDispatcher(d: StopDispatcher): void {
    this.dispatcher = d;
  }

  isStopped(): boolean {
    return this.cached;
  }

  state(): StopState {
    const r = this.row();
    return {
      stopped: r.stopped === 1,
      since: r.since,
      actorKind: (r.actor_kind as StopActor['kind'] | null) ?? null,
      by: r.actor_id,
      reason: r.reason,
      report: r.report ? (JSON.parse(r.report) as StopReport) : null,
    };
  }

  async stopAll(actor: StopActor, reason: string): Promise<StopReport> {
    const at = Date.now();
    const why = String(reason || 'stop').slice(0, 200);
    const wasStopped = this.cached;
    // the flag first: from here on nothing new leases, even while the running items settle
    this.cached = true;
    if (!wasStopped)
      this.db
        .prepare(
          'UPDATE kill_switch SET stopped = 1, since = ?, actor_kind = ?, actor_id = ?, reason = ?, report = NULL WHERE id = 1',
        )
        .run(at, actor.kind, actorId(actor), why);
    const items: StoppedItem[] = [];
    // running turns: read what they were before cancelling them
    const running = this.db
      .prepare("SELECT id FROM queue_items WHERE state IN ('leased','running')")
      .all() as { id: string }[];
    const described = new Map(running.map((r) => [r.id, this.describeItem(r.id)]));
    const cancelled = this.dispatcher ? await this.dispatcher.cancelAll(STOP_ABORT_REASON) : [];
    for (const id of new Set([...running.map((r) => r.id), ...cancelled])) {
      const d = described.get(id) ?? this.describeItem(id);
      if (!d) continue;
      // a leased item that never started goes back as held (nothing ran); a running one ended cancelled
      const row = this.queue.getRow(id);
      const parked = row?.state === 'leased' || row?.state === 'queued';
      if (parked) this.queue.hold(id, NEVER, STOP_HOLD_ERROR);
      items.push({ ...d, kind: parked ? 'queued' : 'run', outcome: parked ? 'held' : 'cancelled' });
    }
    items.push(...this.holdQueued());
    for (const h of [...this.handlers]) {
      try {
        items.push(...(await h({ reason: why, at })));
      } catch (e) {
        this.log?.error('stop handler failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const prev = wasStopped ? this.state().report : null;
    const report: StopReport = {
      id: prev?.id ?? ulid(),
      at: prev?.at ?? at,
      actorKind: prev?.actorKind ?? actor.kind,
      by: prev?.by ?? actorId(actor),
      reason: prev?.reason ?? why,
      items: [...(prev?.items ?? []), ...items],
    };
    this.db.prepare('UPDATE kill_switch SET report = ? WHERE id = 1').run(JSON.stringify(report));
    this.log?.warn('kill switch: stopped', { actor: actor.kind, items: items.length });
    this.notify();
    return report;
  }

  resume(actor: StopActor, o: { reauthed: boolean }): StopState {
    if (actor.kind !== 'owner') throw new KillSwitchError('resume_forbidden');
    const u = this.db.prepare('SELECT kind, disabled_at FROM users WHERE id = ?').get(actor.userId) as
      | { kind: string; disabled_at: number | null }
      | undefined;
    if (u?.kind !== 'owner' || u.disabled_at) throw new KillSwitchError('resume_forbidden');
    if (!o.reauthed) throw new KillSwitchError('reauth_required');
    if (this.cached) {
      this.db
        .prepare('UPDATE kill_switch SET stopped = 0, resumed_at = ?, resumed_by = ? WHERE id = 1')
        .run(Date.now(), actor.userId);
      this.cached = false;
      const held = this.db
        .prepare("SELECT id FROM queue_items WHERE state = 'held' AND error = ?")
        .all(STOP_HOLD_ERROR) as { id: string }[];
      for (const h of held) this.queue.hold(h.id, 0);
      this.queue.releaseHeld();
      this.log?.warn('kill switch: resumed', { by: actor.userId, released: held.length });
    }
    this.notify();
    return this.state();
  }

  /** Every queued item becomes held with the stop marker (the dispatcher calls this on each tick while stopped). */
  holdQueued(): StoppedItem[] {
    const rows = this.db.prepare("SELECT id FROM queue_items WHERE state = 'queued'").all() as {
      id: string;
    }[];
    const out: StoppedItem[] = [];
    for (const r of rows) {
      const d = this.describeItem(r.id);
      this.queue.hold(r.id, NEVER, STOP_HOLD_ERROR);
      if (d) out.push({ ...d, kind: 'queued', outcome: 'held' });
    }
    return out;
  }

  onStop(h: StopHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  watch(fn: (s: StopState) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private notify(): void {
    const s = this.state();
    for (const w of [...this.watchers]) {
      try {
        w(s);
      } catch (e) {
        this.log?.error('kill switch watcher failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private row(): Row {
    return this.db.prepare('SELECT * FROM kill_switch WHERE id = 1').get() as Row;
  }

  /** A queue item as a report line: its run (if one started), agent, chat and kind (routine/workflow by name). */
  private describeItem(id: string): Omit<StoppedItem, 'outcome'> | null {
    const q = this.db
      .prepare('SELECT id, agent_id, chat_id, kind, payload FROM queue_items WHERE id = ?')
      .get(id) as
      | { id: string; agent_id: string; chat_id: string | null; kind: string; payload: string }
      | undefined;
    if (!q) return null;
    const run = this.db
      .prepare('SELECT id FROM runs WHERE queue_item_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(id) as { id: string } | undefined;
    // the kind goes out as data (the app names it in its own language); the label is only the routine's or
    // workflow's own name
    let label: string | null = null;
    try {
      const p = JSON.parse(q.payload) as Record<string, unknown>;
      const name = p.routineName ?? p.workflowName ?? p.name;
      if (typeof name === 'string' && name) label = name.slice(0, 80);
    } catch {
      // payload is json_valid by the table's CHECK
    }
    return {
      kind: run ? 'run' : 'queued',
      id: q.id,
      runId: run?.id ?? null,
      agentId: q.agent_id,
      chatId: q.chat_id,
      label,
      queueKind: q.kind,
    };
  }
}
