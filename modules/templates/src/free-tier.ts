/**
 * The free-tier gate: a thin wrapper around the OpenCode adapter. Turns on a model from the free list share one
 * quota, so they run one at a time across every agent (no parallel fan-out on the shared model). A rate-limit or
 * quota error closes the gate until the reset and becomes one plain message ("the free model is busy or out of
 * quota, try again at …"); while the gate is closed a free-model turn ends with that message at once, without
 * calling the model, so the core's single retry and hold (W3) can never become a retry storm. A turn waiting for the
 * gate leaves at once when its run is cancelled (it never starts the CLI), and gives up with the busy message after
 * `maxWaitMs`, so a hung free turn cannot pin every other free-model agent. `brokenAfter` consecutive auth errors or
 * "model not found" answers on a free model mark it broken (the owner's "pick another brain" notice); one success
 * resets the count and reports the model working again. Turns on any other model pass straight through.
 */
import type {
  ModelInfo,
  NativeSessionRef,
  ProviderAccount,
  ProviderAdapter,
  ProviderCaps,
  ProviderEvent,
  ProviderStatus,
  TurnContext,
  TurnInput,
} from '@pasabot/core';

export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** how long a free-model turn waits for the one running before it gives up with the busy message */
export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
/** consecutive auth / not-found failures before a free model counts as broken */
export const DEFAULT_BROKEN_AFTER = 3;

/** how a routine fire skipped by the free model's limit is recorded (`skipped`, with this reason first) */
export const RATE_LIMITED = 'rate limited';
/** matches the text of `busyMessage` (a held item's error) */
export const BUSY_RE = /free model is busy or out of quota/;

export function busyMessage(until: number): string {
  return `The free model is busy or out of quota, try again at ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}

export interface FreeTierOptions {
  inner: ProviderAdapter | null;
  isFree(model: string | undefined): boolean;
  onBroken(model: string, reason: string): void;
  /** a free-model turn ended normally (clears a broken mark) */
  onWorking?(model: string): void;
  now?: () => number;
  cooldownMs?: number;
  maxWaitMs?: number;
  brokenAfter?: number;
}

export class FreeTierGate implements ProviderAdapter {
  readonly id = 'opencode' as const;
  readonly displayName: string;
  private inner: ProviderAdapter | null;
  private blockedUntil = 0;
  private tail: Promise<void> = Promise.resolve();
  /** consecutive auth / not-found failures per free model */
  private failures = new Map<string, number>();
  /** free-model calls that reached the inner adapter (tests count them) */
  calls = 0;

  constructor(private readonly o: FreeTierOptions) {
    this.inner = o.inner;
    this.displayName = o.inner?.displayName ?? 'OpenCode';
  }
  setInner(p: ProviderAdapter) {
    this.inner = p;
  }
  hasInner() {
    return this.inner !== null;
  }
  /** forget the failure count of a model (the owner asked to re-check it) */
  resetFailures(model: string) {
    this.failures.delete(model);
  }
  /** a turn on this model goes through the free-tier rules (the free list, or a model a starter agent runs on) */
  isFreeModel(model: string | undefined): boolean {
    return this.o.isFree(model);
  }
  blocked(): number {
    return this.blockedUntil > this.now() ? this.blockedUntil : 0;
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }
  private must(): ProviderAdapter {
    if (!this.inner) throw new Error('OpenCode is not installed');
    return this.inner;
  }

  async detect(acct?: ProviderAccount): Promise<ProviderStatus> {
    if (!this.inner) return { installed: false, signedIn: false, hint: 'OpenCode CLI not installed' };
    return this.inner.detect(acct);
  }
  capabilities(): ProviderCaps {
    return (
      this.inner?.capabilities() ?? {
        resume: true,
        images: false,
        mcp: true,
        nativeCompaction: false,
        permissionBridge: false,
        subagentEvents: false,
        contextReport: false,
      }
    );
  }
  /**
   * The inner adapter's list with the free list's models marked free, and the first of them that OpenCode offers
   * pre-ticked for a new agent (a first-timer on the free starter never has to choose).
   */
  async listModels(acct?: ProviderAccount): Promise<ModelInfo[]> {
    const list = (await this.inner?.listModels?.(acct)) ?? [];
    const first = list.find((m) => this.o.isFree(m.id))?.id;
    return list.map((m) => {
      if (!this.o.isFree(m.id)) return m;
      return { ...m, hint: 'free' as const, ...(m.id === first ? { recommended: true } : {}) };
    });
  }
  skillsDir(workspace: string): string {
    return this.inner?.skillsDir?.(workspace) ?? `${workspace}/.opencode/skill`;
  }
  async steer(runId: string, text: string): Promise<boolean> {
    return (await this.inner?.steer?.(runId, text)) ?? false;
  }
  async compact(ref: NativeSessionRef, ctx: TurnContext): Promise<NativeSessionRef> {
    const c = this.must().compact;
    if (!c) throw new Error('no native compaction');
    return c.call(this.inner, ref, ctx);
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const model = input.model ?? input.agent.model ?? undefined;
    if (!this.o.isFree(model)) {
      yield* this.must().runTurn(input, signal);
      return;
    }
    // one turn at a time on the shared free model; the next waiter goes after both the previous turn and this one,
    // so a waiter that leaves early (cancelled, timed out) never lets two turns run at once
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.tail;
    this.tail = prev.then(() => mine);
    try {
      const turn = await waitTurn(prev, signal, this.o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
      if (turn === 'cancelled' || signal.aborted) {
        yield { type: 'done', stop: 'cancelled' };
        return;
      }
      if (turn === 'timeout') {
        const retry = 60_000;
        yield {
          type: 'error',
          kind: 'rate_limit',
          message: busyMessage(this.now() + retry),
          retryAfterMs: retry,
        };
        yield { type: 'done', stop: 'error' };
        return;
      }
      const until = this.blocked();
      if (until) {
        yield {
          type: 'error',
          kind: 'rate_limit',
          message: busyMessage(until),
          retryAfterMs: until - this.now(),
        };
        yield { type: 'done', stop: 'error' };
        return;
      }
      this.calls++;
      let failed = false;
      for await (const ev of this.must().runTurn(input, signal)) {
        if (ev.type === 'error') failed = true;
        if (ev.type === 'error' && (ev.kind === 'rate_limit' || ev.kind === 'quota')) {
          const wait =
            ev.retryAfterMs && ev.retryAfterMs > 0
              ? ev.retryAfterMs
              : (this.o.cooldownMs ?? DEFAULT_COOLDOWN_MS);
          this.blockedUntil = this.now() + wait;
          yield { type: 'error', kind: ev.kind, message: busyMessage(this.blockedUntil), retryAfterMs: wait };
          continue;
        }
        if (
          ev.type === 'error' &&
          (ev.kind === 'auth' || /model.{0,20}not.{0,5}found|unknown model/i.test(ev.message))
        ) {
          const n = (this.failures.get(model!) ?? 0) + 1;
          this.failures.set(model!, n);
          if (n >= (this.o.brokenAfter ?? DEFAULT_BROKEN_AFTER))
            this.o.onBroken(model!, ev.kind === 'auth' ? 'needs a key or login now' : 'no longer available');
        }
        if (ev.type === 'done' && ev.stop === 'end' && !failed) {
          this.failures.delete(model!);
          this.o.onWorking?.(model!);
        }
        yield ev;
      }
    } finally {
      release();
    }
  }
}

/** Wait for the previous free turn, unless the run is cancelled or the wait runs past `maxWaitMs`. */
function waitTurn(prev: Promise<void>, signal: AbortSignal, maxWaitMs: number) {
  if (signal.aborted) return Promise.resolve('cancelled' as const);
  return new Promise<'go' | 'cancelled' | 'timeout'>((resolve) => {
    const finish = (v: 'go' | 'cancelled' | 'timeout') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), maxWaitMs);
    signal.addEventListener('abort', onAbort, { once: true });
    prev.then(() => finish('go'));
  });
}
