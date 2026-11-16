/**
 * Client for the speech process (worker/voice-worker.mjs). One child process, started on first use and again
 * after it dies: a crash, a kill or a call past its time limit rejects the calls in flight with `worker_crashed`
 * (or `timeout`) and never touches the server process. Calls run one at a time, at most `maxPending` of them waiting
 * or running (more are refused with `busy`), and each one's time limit counts from the moment it was asked, queue
 * time included. The process is stopped by `close()`, after `idleMs` without calls, and when the server process exits.
 *
 * The process runs native code on audio members upload and on model files from the internet, so it gets no inherited
 * environment: only the variables in `WORKER_ENV_ALLOW` pass (secrets such as the vault passphrase stay out).
 */
import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Pcm } from './wav.js';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface WorkerConfig {
  driver: 'sherpa' | 'fake';
  stt?: { encoder: string; decoder: string; tokens: string; language?: string };
  tts?: { model: string; tokens: string; dataDir?: string };
  fakeTranscripts?: Record<string, string>;
  fakeDefault?: string;
}

export interface EngineOptions {
  /** read on every (re)start, so a model downloaded meanwhile is picked up by the next process */
  config(): WorkerConfig;
  /** per call, counted from the call (queue time included); default 60 s */
  timeoutMs?: number;
  idleMs?: number;
  /** calls waiting or running at once; more are refused with `busy` (default 4) */
  maxPending?: number;
}

/** The only variables the speech process inherits (the native loaders may need a library path). */
export const WORKER_ENV_ALLOW = ['PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'] as const;
export function workerEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of WORKER_ENV_ALLOW) {
    const v = from[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

const WORKER_PATH = fileURLToPath(new URL('../worker/voice-worker.mjs', import.meta.url));

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

type Reply = {
  id?: number;
  ok?: boolean;
  ready?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export class SpeechEngine {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private chain: Promise<unknown> = Promise.resolve();
  /** calls waiting or running */
  private inFlight = 0;
  private idle: NodeJS.Timeout | null = null;
  private closed = false;
  /** how many processes this engine has started (tests: a crash is followed by a fresh one) */
  starts = 0;

  constructor(private readonly opts: EngineOptions) {}

  /** pid of the running speech process, or null */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  transcribe(pcm: Pcm): Promise<string> {
    return this.call<{ text: string }>({ op: 'stt', samples: pcm.samples, sampleRate: pcm.sampleRate }).then(
      (r) => r.text,
    );
  }
  synthesize(text: string): Promise<Pcm> {
    return this.call<{ samples: Float32Array; sampleRate: number }>({ op: 'tts', text }).then((r) => ({
      samples:
        r.samples instanceof Float32Array ? r.samples : Float32Array.from(r.samples as ArrayLike<number>),
      sampleRate: r.sampleRate,
    }));
  }
  /** `envKeys`: names (never values) of the variables the process sees; tests prove nothing secret got in */
  ping(): Promise<{ pid: number; envKeys: string[] }> {
    return this.call({ op: 'ping' });
  }

  /** Stop the process; the next call starts a fresh one (used after a model download). */
  restart() {
    this.stop();
  }
  close() {
    this.closed = true;
    this.stop();
  }

  private stop() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const c = this.child;
    this.child = null;
    this.ready = null;
    if (c && c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new EngineError('the speech engine is closed', 'closed'));
    if (this.inFlight >= (this.opts.maxPending ?? 4))
      return Promise.reject(new EngineError('the speech engine is busy, try again shortly', 'busy'));
    this.inFlight++;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 60_000);
    const run = this.chain
      .then(() => this.send<T>(msg, deadline))
      .finally(() => {
        this.inFlight--;
      });
    this.chain = run.catch(() => {});
    return run;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = fork(WORKER_PATH, [JSON.stringify(this.opts.config())], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: workerEnv(),
    });
    child.stderr?.resume();
    this.starts++;
    track(child);
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      child.on('message', (m: Reply) => {
        if (m.ready) return resolve();
        const p = m.id === undefined ? undefined : this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id as number);
        if (m.ok) p.resolve(m.result);
        else
          p.reject(
            new EngineError(m.error?.message ?? 'speech engine error', m.error?.code ?? 'engine_error'),
          );
      });
      child.once('exit', (code, signal) => {
        const err = new EngineError(
          `the speech process stopped (${signal ?? `exit ${code}`})`,
          'worker_crashed',
        );
        reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
      });
      child.once('error', reject);
    });
    return this.ready;
  }

  private async send<T>(msg: Record<string, unknown>, deadline: number): Promise<T> {
    if (this.closed) throw new EngineError('the speech engine is closed', 'closed');
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const left = deadline - Date.now();
    // it waited in the queue past its own limit: never sent
    if (left <= 0) throw new EngineError('the speech engine took too long', 'timeout');
    const id = ++this.seq;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        let done = false;
        const settle = (f: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.pending.delete(id);
          f();
        };
        // the limit covers starting the process too
        timer = setTimeout(() => {
          settle(() => reject(new EngineError('the speech engine took too long', 'timeout')));
          this.stop();
        }, left);
        this.start().then(
          () => {
            if (done) return;
            const child = this.child;
            if (!child)
              return settle(() => reject(new EngineError('the speech process stopped', 'worker_crashed')));
            this.pending.set(id, {
              resolve: (v) => settle(() => resolve(v as T)),
              reject: (e) => settle(() => reject(e)),
            });
            child.send({ ...msg, id });
          },
          (e: Error) => settle(() => reject(e)),
        );
      });
    } finally {
      clearTimeout(timer);
      if (!this.closed && this.child) {
        this.idle = setTimeout(() => this.stop(), this.opts.idleMs ?? 120_000);
        this.idle.unref();
      }
    }
  }
}
