/**
 * JSON-RPC 2.0 over a child's stdio, one JSON object per line (the Agent Client Protocol transport). PasaBot is the
 * client: it sends requests and notifications, answers the agent's own requests through `onRequest`, and receives
 * notifications through `onNotification`. Written for PasaBot from the public protocol description.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export const METHOD_NOT_FOUND = -32601;

type Pending = { resolve(v: any): void; reject(e: Error): void };

export class StdioRpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closedWith: Error | null = null;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async (m) => {
    throw new RpcError(METHOD_NOT_FOUND, `method not found: ${m}`);
  };
  /** resolves when stdout ends */
  readonly ended: Promise<void>;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    out.on('error', () => {});
    const rl = createInterface({ input });
    this.ended = (async () => {
      try {
        for await (const raw of rl) this.handle(raw);
      } catch {
        /* stream error: treated as the end */
      }
      this.close(new Error('agent closed its output'));
    })();
  }

  private send(msg: object) {
    if (this.closedWith) return;
    try {
      this.out.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    } catch {
      /* the agent is gone; pending requests fail when stdout ends */
    }
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  close(err: Error) {
    if (this.closedWith) return;
    this.closedWith = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private handle(raw: string) {
    const line = raw.trim();
    if (!line.startsWith('{')) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (!hasId) {
        try {
          this.onNotification(msg.method, msg.params);
        } catch {
          /* a bad notification never kills the turn */
        }
        return;
      }
      this.onRequest(msg.method, msg.params).then(
        (result) => this.send({ id: msg.id, result: result ?? null }),
        (e: unknown) =>
          this.send({
            id: msg.id,
            error:
              e instanceof RpcError
                ? { code: e.code, message: e.message }
                : { code: -32603, message: 'internal error' },
          }),
      );
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    if (msg.error)
      p.reject(
        new RpcError(Number(msg.error.code ?? -32603), String(msg.error.message ?? 'error'), msg.error.data),
      );
    else p.resolve(msg.result);
  }
}

/** A push/pull queue the turn's generator reads while the protocol driver writes. */
export class EventQueue<T> implements AsyncIterable<T> {
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
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}
