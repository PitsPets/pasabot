/**
 * Client for the datastore process (worker/sql-worker.mjs): one SQLite connection to the separate `datastore.db`,
 * held in a child process, calls run one at a time, and a call that runs past its time limit kills that process with
 * SIGKILL (the next call starts a fresh one). A process, not a worker thread: SQLite work inside one native
 * `sqlite3_step` (an aggregate over an endless recursive CTE) ignores `Worker.terminate()` and would keep a core,
 * the WAL write lock and a read snapshot for ever; SIGKILL ends it at once, so no agent SQL can stall the server.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface TableInfo {
  name: string;
  ddl: string;
  rows: number;
  columns: { name: string; type: string }[];
}
export type Cell = string | number | null | { blob: string };
export interface ReadResult {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}
export type Param = string | number | boolean | null;
export type Params = Param[] | Record<string, Param>;

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

const WORKER_PATH = fileURLToPath(new URL('../worker/sql-worker.mjs', import.meta.url));
const IDLE_MS = 30_000;
/** a stopped process that has not closed its file within this long is killed */
const STOP_GRACE_MS = 1000;

/** Every live datastore process; killed when the server process exits, even mid-statement. */
const live = new Set<ChildProcess>();
let exitHook = false;
function track(c: ChildProcess) {
  live.add(c);
  c.once('exit', () => live.delete(c));
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => {
      for (const p of live) p.kill('SIGKILL');
    });
  }
}

export interface StoreOptions {
  path: string;
  /** SQLite pages (4 KiB each) the file may grow to; writes past it fail with "database or disk is full" */
  maxPageCount: number;
  /** per call, in ms */
  timeoutMs: number;
}

type Reply = {
  id?: number;
  ok?: boolean;
  ready?: boolean;
  result?: unknown;
  error?: { message: string; code: string };
};

export class Datastore {
  private worker: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: StoreOptions) {}

  /** The current datastore process id (tests check that a stopped one is really gone). */
  get workerPid(): number | undefined {
    return this.worker?.pid;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const w = fork(
      WORKER_PATH,
      [JSON.stringify({ path: this.opts.path, maxPageCount: this.opts.maxPageCount })],
      {
        // only our own file runs there: no inherited loaders/flags, no inherited environment (secrets stay out)
        execArgv: [],
        env: {},
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'advanced',
      },
    );
    track(w);
    // modules have no shutdown hook: an unref'd process never keeps the server alive, and an idle one stops
    w.unref();
    w.channel?.unref();
    this.worker = w;
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (m: Reply) => {
        if (m?.ready) {
          w.off('message', onReady);
          resolve();
        }
      };
      w.on('message', onReady);
      w.once('error', reject);
      w.once('exit', () => reject(new StoreError('datastore process stopped while starting', 'worker')));
    });
    w.on('message', (m: Reply) => {
      if (typeof m?.id !== 'number') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new StoreError(m.error?.message ?? 'datastore error', m.error?.code ?? 'sqlite'));
    });
    w.on('error', (e) => this.fail(w, new StoreError(`datastore process failed: ${e.message}`, 'worker')));
    w.on('exit', () => this.fail(w, new StoreError('datastore process stopped', 'worker')));
    return this.ready;
  }

  /** Drops a dead or stopped process and fails whatever was waiting on it. */
  private fail(w: ChildProcess, e: Error) {
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** Ends a process: SIGKILL at once (a runaway statement), or a clean close first (idle, shutdown). */
  private stop(w: ChildProcess, graceful: boolean): Promise<void> {
    if (w.exitCode !== null || w.signalCode !== null) return Promise.resolve();
    const gone = new Promise<void>((resolve) => w.once('exit', () => resolve()));
    if (graceful && w.connected) {
      w.disconnect(); // the process closes its database and exits
      const t = setTimeout(() => w.kill('SIGKILL'), STOP_GRACE_MS);
      t.unref();
      void gone.then(() => clearTimeout(t));
    } else {
      w.kill('SIGKILL');
    }
    return gone;
  }

  /** One call to the process, after every earlier call has finished; times out by killing the process. */
  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = this.opts.timeoutMs): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) throw new StoreError('datastore is closed', 'closed');
      await this.start();
      const w = this.worker!;
      const id = ++this.seq;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new StoreError(`the statement ran longer than ${timeoutMs} ms and was stopped`, 'timeout'));
          this.fail(w, new StoreError('datastore process restarted', 'worker'));
          void this.stop(w, false);
        }, timeoutMs);
        this.pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        w.send({ id, op, args }, (err) => {
          if (err)
            this.pending
              .get(id)
              ?.reject(new StoreError(`datastore process unreachable: ${err.message}`, 'worker'));
        });
      });
    };
    if (this.idle) clearTimeout(this.idle);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    void this.chain.then(() => this.armIdle());
    return p;
  }

  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Stops the process (and closes the file) after a quiet spell; the next call starts a fresh one. */
  private armIdle() {
    if (this.pending.size > 0) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      const w = this.worker;
      if (!w || this.pending.size > 0) return;
      this.fail(w, new StoreError('datastore process stopped while idle', 'worker'));
      void this.stop(w, true);
    }, IDLE_MS);
    this.idle.unref();
  }

  tables() {
    return this.call<TableInfo[]>('tables');
  }
  exists(name: string) {
    return this.call<boolean>('exists', { name });
  }
  /**
   * Creates one table in a single step inside the process (existence check, table cap and the DDL together), so
   * no other call can slip in between; `created: false` means it already existed and nothing ran.
   */
  createTable(sql: string, name: string, maxTables: number) {
    return this.call<{ created: boolean }>('create', { sql, name, maxTables });
  }
  query(sql: string, params: Params | undefined, limit: number, maxBytes: number) {
    return this.call<ReadResult>('query', { sql, params, limit, maxBytes });
  }
  browse(name: string, limit: number, offset: number, maxBytes: number) {
    return this.call<ReadResult>('browse', { name, limit, offset, maxBytes });
  }
  write(sql: string, params?: Params, rows?: Params[]) {
    return this.call<{ changes: number; lastInsertRowid?: Cell; returning?: ReadResult }>('write', {
      sql,
      params,
      rows,
    });
  }
  ddl(sql: string) {
    return this.call<{ ok: true }>('ddl', { sql });
  }
  size() {
    return this.call<{ bytes: number; maxBytes: number }>('size');
  }

  async close() {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    const w = this.worker;
    if (!w) return;
    const busy = this.pending.size > 0;
    this.fail(w, new StoreError('datastore is closed', 'closed'));
    await this.stop(w, !busy);
  }
}
