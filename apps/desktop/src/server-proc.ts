/**
 * The server as a child process with a parent channel (ARCHITECTURE 4.3). The channel is what makes "no orphan
 * server" hold even when the launcher is killed: the server shuts down when it closes. A clean stop first closes the
 * channel (the server's own graceful path, on every OS), then sends SIGTERM, and only after `graceMs` SIGKILL.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ServerLaunch {
  /** node binary that runs the server */
  node: string;
  /** server entry: `<root>/apps/server/dist/host/main.js` (or main.ts with a loader in dev and tests) */
  entry: string;
  /** node flags before the entry, e.g. `--import tsx` in dev */
  execArgv?: string[];
  /** full environment for the server (PASABOT_HOME etc.); PASABOT_PORT / PASABOT_SITES_PORT are set per start */
  env: NodeJS.ProcessEnv;
  /** server stdout + stderr are appended here (0600); null = discarded */
  logFile?: string | null;
  readyTimeoutMs?: number;
}

export interface ServerReady {
  url: string;
  sitesUrl: string;
  /** first-run setup link (single use, 30 min) while the server has no owner; `requestSetupLink` asks for a fresh one */
  setupLink: string | null;
  stopped: boolean;
}

export interface StopFlag {
  stopped: boolean;
  since: number | null;
}

type Events = {
  exit: [code: number | null, signal: NodeJS.Signals | null];
  state: [StopFlag];
  failure: [string];
  'setup-link': [string | null];
  /** the owner tapped one of the desktop controls in the web app's Settings (desktop-bridge.ts on the server) */
  'desktop-ask': [{ what: 'quit' } | { what: 'autostart'; on: boolean }];
};

/** what the web app may offer of this launcher's own controls (the server's DesktopBridge) */
export interface DesktopOffer {
  quit: boolean;
  autostart: boolean;
  autostartAvailable: boolean;
}

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null;

export class ServerProcess extends EventEmitter<Events> {
  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;

  constructor(private readonly launch: ServerLaunch) {
    super();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(port: number, sitesPort: number): Promise<ServerReady> {
    if (this.child) return Promise.reject(new Error('server already started'));
    const { node, entry, execArgv = [], env, logFile, readyTimeoutMs = 90_000 } = this.launch;
    let fd: number | 'ignore' = 'ignore';
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      fd = openSync(logFile, 'a', 0o600);
    }
    let child: ChildProcess;
    try {
      child = spawn(node, [...execArgv, entry], {
        stdio: ['ignore', fd, fd, 'ipc'],
        env: { ...env, PASABOT_PORT: String(port), PASABOT_SITES_PORT: String(sitesPort) },
        windowsHide: true,
      });
    } finally {
      if (typeof fd === 'number') closeSync(fd);
    }
    this.child = child;
    this.exited = new Promise((resolve) => {
      let done = false;
      const gone = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        if (this.child === child) this.child = null;
        this.emit('exit', code, signal);
        resolve();
      };
      child.once('exit', gone);
      // a spawn failure (missing node binary) may never emit 'exit'
      child.on('error', () => {
        if (child.pid === undefined) gone(null, null);
      });
    });
    child.on('message', (m: unknown) => {
      if (!isObj(m)) return;
      if (m.type === 'pasabot:state')
        this.emit('state', { stopped: m.stopped === true, since: num(m.since) });
      else if (m.type === 'pasabot:error') this.emit('failure', String(m.message ?? 'error'));
      else if (m.type === 'pasabot:setup-link')
        this.emit('setup-link', typeof m.setupLink === 'string' ? m.setupLink : null);
      else if (m.type === 'pasabot:desktop-ask') {
        if (m.what === 'quit') this.emit('desktop-ask', { what: 'quit' });
        else if (m.what === 'autostart' && typeof m.on === 'boolean')
          this.emit('desktop-ask', { what: 'autostart', on: m.on });
      }
    });
    return new Promise<ServerReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        void this.stop(2000);
        reject(new Error(`server did not report ready within ${readyTimeoutMs} ms`));
      }, readyTimeoutMs);
      const onMessage = (m: unknown) => {
        if (!isObj(m) || m.type !== 'pasabot:ready' || typeof m.url !== 'string') return;
        cleanup();
        resolve({
          url: m.url,
          sitesUrl: typeof m.sitesUrl === 'string' ? m.sitesUrl : '',
          setupLink: typeof m.setupLink === 'string' ? m.setupLink : null,
          stopped: m.stopped === true,
        });
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`server exited before it was ready (${signal ?? `exit ${code}`})`));
      };
      const onSpawnError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onSpawnError);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onSpawnError);
    });
  }

  private send(m: Record<string, unknown>): boolean {
    const c = this.child;
    if (!c?.connected) return false;
    c.send(m);
    return true;
  }

  /** tells the server which of this launcher's controls the web app may offer (false when it is not running) */
  tellDesktop(d: DesktopOffer): boolean {
    return this.send({ type: 'pasabot:desktop', ...d });
  }

  /** the global stop flag, asked over the channel */
  requestState(timeoutMs = 5000): Promise<StopFlag> {
    return this.awaitState(
      () => this.send({ type: 'pasabot:state' }),
      () => true,
      timeoutMs,
    );
  }

  /** press the global stop (W31) as the `system` actor; resolves once the server reports it stopped */
  stopAll(timeoutMs = 30_000): Promise<StopFlag> {
    return this.awaitState(
      () => this.send({ type: 'pasabot:stop-all' }),
      (s) => s.stopped,
      timeoutMs,
    );
  }

  /**
   * a fresh first-run setup link, asked over the channel (never HTTP); null once the server has an owner, when it does
   * not answer in time, or when it is not running
   */
  requestSetupLink(timeoutMs = 5000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('setup-link', onLink);
        resolve(null);
      }, timeoutMs);
      const onLink = (link: string | null) => {
        clearTimeout(timer);
        resolve(link);
      };
      this.once('setup-link', onLink);
      if (!this.send({ type: 'pasabot:setup-link' })) {
        clearTimeout(timer);
        this.off('setup-link', onLink);
        resolve(null);
      }
    });
  }

  private awaitState(
    ask: () => boolean,
    done: (s: StopFlag) => boolean,
    timeoutMs: number,
  ): Promise<StopFlag> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('the server did not answer'));
      }, timeoutMs);
      const onState = (s: StopFlag) => {
        if (!done(s)) return;
        cleanup();
        resolve(s);
      };
      const onError = (msg: string) => {
        cleanup();
        reject(new Error(msg));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('state', onState);
        this.off('failure', onError);
      };
      this.on('state', onState);
      this.on('failure', onError);
      if (!ask()) {
        cleanup();
        reject(new Error('the server is not running'));
      }
    });
  }

  /** clean shutdown: close the channel, SIGTERM, then SIGKILL after `graceMs`; resolves once the process is gone */
  async stop(graceMs = 10_000): Promise<void> {
    const c = this.child;
    const exited = this.exited;
    if (!c || !exited) return;
    if (c.connected) c.disconnect();
    if (process.platform !== 'win32') c.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const killed = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (killed) {
      c.kill('SIGKILL');
      await exited;
    }
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
