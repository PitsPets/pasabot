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
