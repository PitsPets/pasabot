/** One runner per agent, a global pool across agents, leases renewed while running (ARCHITECTURE.md 6). */
import type { Logger } from '@pasabot/core';
import type { QueueRow, SqliteQueue } from './queue.js';

/** Abort reason used by `Dispatcher.stop()`: the work is not cancelled, the server is going away. */
export const SHUTDOWN_REASON = 'pasabot:shutdown';
export const isShutdownAbort = (signal: AbortSignal): boolean =>
  signal.aborted && signal.reason === SHUTDOWN_REASON;

export interface ExecuteResult {
  state: 'done' | 'failed' | 'cancelled' | 'held';
  error?: string;
  /** for `held` */
  resumeAt?: number;
}
export type Executor = (
  item: QueueRow,
  ctx: { signal: AbortSignal; bootId: string },
) => Promise<ExecuteResult>;

export interface DispatcherOptions {
  bootId: string;
  maxConcurrentAgents?: number;
  renewMs?: number;
  pollMs?: number;
  /** how often expired leases are recovered while running (default 15 s) */
  sweepMs?: number;
  log?: Logger;
  /** told about items the runtime lease sweep moved to `interrupted`/`queued` (chat card, notification) */
  onRecovered?: (res: { requeued: QueueRow[]; interrupted: QueueRow[] }) => void;
  /**
   * The W31 kill switch: while it says stopped, nothing is leased and `whileStopped` runs instead on every tick (it
   * parks newly queued items as held). Read before the first lease, so a stop survives a restart.
   */
  stop?: { isStopped(): boolean; whileStopped(): void };
}

export class Dispatcher {
  private running = new Map<string, { itemId: string; abort: AbortController; done: Promise<void> }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private scheduled = false;
  private unlisten: (() => void) | null = null;
  private lastSweep = Date.now();
  readonly maxConcurrentAgents: number;

  constructor(
    private readonly queue: SqliteQueue,
    private readonly execute: Executor,
    private readonly o: DispatcherOptions,
  ) {
    this.maxConcurrentAgents = o.maxConcurrentAgents ?? 3;
    queue.abortRunning = (id) => this.cancel(id);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unlisten = this.queue.onChange(() => this.kick());
    this.timer = setInterval(() => this.kick(), this.o.pollMs ?? 1000);
    this.timer.unref?.();
    this.kick();
  }

  /**
   * Stop leasing; abort running items with SHUTDOWN_REASON and wait for them to settle. A shutdown is not a cancel:
   * the items stay `running` with this boot's lease, so the next boot recovers them as `interrupted` (Retry/Skip),
   * exactly like a crash.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unlisten?.();
    for (const r of this.running.values()) r.abort.abort(SHUTDOWN_REASON);
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  kick(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  cancel(itemId: string): boolean {
    for (const r of this.running.values()) {
      if (r.itemId === itemId) {
        r.abort.abort();
        return true;
      }
    }
    return false;
  }

  /** Abort every running item with `reason` (a cancel, not a shutdown) and wait for them to settle (W31 stop). */
  async cancelAll(reason: string): Promise<string[]> {
    const entries = [...this.running.values()];
    for (const r of entries) r.abort.abort(reason);
    await Promise.allSettled(entries.map((r) => r.done));
    return entries.map((r) => r.itemId);
  }

  runningItems(): string[] {
    return [...this.running.values()].map((r) => r.itemId);
  }

  /** Resolves once nothing is running and no agent has leaseable work. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (this.running.size === 0) {
        const leaseable = this.queue.agentsWithWork().some((a) => !this.queue.blockedBy(a));
        if (!leaseable) return;
      }
      if (Date.now() > until) throw new Error('dispatcher did not become idle');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      if (this.o.stop?.isStopped()) {
        this.o.stop.whileStopped();
        return;
      }
      this.sweep();
      this.queue.releaseHeld();
      for (const agentId of this.queue.agentsWithWork()) {
        if (this.running.size >= this.maxConcurrentAgents) break;
        if (this.running.has(agentId)) continue;
        const item = this.queue.leaseNext(agentId, this.o.bootId);
        if (item) this.launch(item);
      }
    } catch (e) {
      // e.g. SQLITE_BUSY: the next tick tries again
      this.o.log?.error('dispatcher tick failed', { error: errText(e) });
    }
  }

  /** Recover leases that expired while the server is up (e.g. a finish() that failed); skips live items. */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < (this.o.sweepMs ?? 15_000)) return;
    this.lastSweep = now;
    const res = this.queue.recover(this.o.bootId, { skip: new Set(this.runningItems()) });
    if (res.requeued.length + res.interrupted.length > 0) {
      this.o.log?.warn('recovered expired leases', {
        requeued: res.requeued.map((r) => r.id),
        interrupted: res.interrupted.map((r) => r.id),
      });
      this.o.onRecovered?.(res);
    }
  }

  private launch(item: QueueRow): void {
    const abort = new AbortController();
    const bootId = this.o.bootId;
    // registered before any state write, so a write that throws can never leave a stale entry behind
    const entry = { itemId: item.id, abort, done: Promise.resolve() };
    this.running.set(item.agent_id, entry);
    entry.done = (async () => {
      let renew: NodeJS.Timeout | null = null;
      try {
        this.queue.markRunning(item.id, bootId);
        renew = setInterval(() => {
          try {
            this.queue.renew(item.id, bootId);
          } catch (e) {
            this.o.log?.warn('lease renew failed', { item: item.id, error: errText(e) });
          }
        }, this.o.renewMs ?? 10_000);
        let res: ExecuteResult;
        // the kind's dispatch-time check (e.g. its token was revoked while it waited), then the queue gates (W32
        // budgets): refused items never run, held ones wait
        const refused = this.queue.admitRefusal(item);
        const gate = refused ? null : this.queue.gateVerdict(item);
        if (refused || (gate && 'refuse' in gate)) {
          clearInterval(renew);
          renew = null;
          this.queue.refuse(item.id, refused ?? (gate as { refuse: string }).refuse);
          return;
        }
        try {
          res =
            gate && 'hold' in gate
              ? { state: 'held', resumeAt: gate.hold.until, error: gate.hold.reason }
              : await this.execute(item, { signal: abort.signal, bootId });
        } catch (e) {
          res = { state: abort.signal.aborted ? 'cancelled' : 'failed', error: errText(e) };
        }
        clearInterval(renew);
        renew = null;
        // a shutdown is not a cancel: leave the row `running` for boot recovery (-> interrupted, Retry/Skip)
        if (isShutdownAbort(abort.signal) && res.state !== 'done') return;
        if (res.state === 'held') this.queue.hold(item.id, res.resumeAt ?? Date.now() + 60_000, res.error);
        else this.queue.finish(item.id, res.state, res.error);
      } catch (e) {
        // state write failed (e.g. SQLITE_BUSY): the row keeps its lease, which expires and is swept
        this.o.log?.error('queue state write failed', { item: item.id, error: errText(e) });
      } finally {
        if (renew) clearInterval(renew);
        if (this.running.get(item.agent_id) === entry) this.running.delete(item.agent_id);
        this.kick();
      }
    })();
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
