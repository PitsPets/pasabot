/** Small helpers kept inside the package (channel packages share code only through @pasabot/core). */

/** Push-side queue exposed as the connection's `inbound` stream; `end()` finishes every reader. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;
  push(v: T) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

/**
 * Like AsyncQueue, for one reader, plus in-order acknowledgements: `ack(fn)` runs `fn` only once the reader has
 * taken every item pushed before it and come back for the next one (a `for await` asks for the next item only after
 * its body finished with the previous). Used to save the board cursor only past messages the runtime handled.
 * Items still queued (or taken but not finished) when the stream ends are never acknowledged.
 */
export class AckQueue<T> implements AsyncIterable<T> {
  private items: ({ v: T } | { ack: () => void })[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  /** an item was handed out and the reader has not come back yet */
  private held = false;
  private ended = false;
  push(v: T) {
    if (this.ended) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.held = true;
      w({ value: v, done: false });
    } else this.items.push({ v });
  }
  ack(fn: () => void) {
    if (this.ended) return;
    if (!this.items.length && !this.held) return fn();
    const last = this.items.at(-1);
    // a later acknowledgement supersedes one still waiting behind the same items
    if (last && 'ack' in last) this.items[this.items.length - 1] = { ack: fn };
    else this.items.push({ ack: fn });
  }
  end() {
    this.ended = true;
    this.items = [];
    const w = this.waiter;
    this.waiter = null;
    w?.({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        this.held = false;
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        for (;;) {
          const head = this.items.shift();
          if (!head) break;
          if ('ack' in head) {
            head.ack();
            continue;
          }
          this.held = true;
          return Promise.resolve({ value: head.v, done: false });
        }
        return new Promise((r) => {
          this.waiter = r;
        });
      },
    };
  }
}

/** Resolves after `ms`, or rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 1 s, 2 s, 4 s … capped at 30 s. */
export const backoff = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));

/** Split text into platform-sized chunks, preferring line breaks; never returns an empty list. */
export function chunkText(text: string, max: number): string[] {
  const t = text.length ? text : '…';
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}
