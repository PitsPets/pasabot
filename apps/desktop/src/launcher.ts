/**
 * The desktop launcher: everything the tray/menu-bar shell does, minus the drawing. It owns the single-instance
 * lock, picks ports, runs the server as a child (ServerProcess), presses the global stop, toggles open-at-login and
 * the (off by default) update check, and describes the menu in already-translated `status` events. A shell (Swift
 * on macOS, PowerShell on Windows) only renders those events and sends back commands (`main.ts` has the wire).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { type AutostartTarget, autostartPossible, isAutostartOn, setAutostart } from './autostart.js';
import { type DesktopConfig, readConfig, writeConfig } from './config.js';
import { acquireInstance, alive, type InstanceDeps, type InstanceLock, poke } from './instance.js';
import { LOOPBACK, pickPort, portOf } from './ports.js';
import { helperAppPath, removeHelperKey, startScreenHelper } from './screen-helper.js';
import { type DesktopOffer, type ServerLaunch, ServerProcess, type ServerReady } from './server-proc.js';
import { loadStrings, pickLocale, type Strings, t } from './strings.js';
import { checkForUpdate, type Fetcher, type UpdateResult } from './update.js';

export type ServerStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'external';

export type Command =
  | { cmd: 'status' }
  | { cmd: 'start' }
  | { cmd: 'stop' }
  | { cmd: 'open' }
  | { cmd: 'stop-all' }
  | { cmd: 'logs' }
  | { cmd: 'autostart'; on: boolean }
  | { cmd: 'update-check'; on: boolean }
  | { cmd: 'check-now' }
  | { cmd: 'open-update' }
  /** the window's web page needs a fresh first-run setup link (or the window came back while there is no owner) */
  | { cmd: 'setup-link' }
  | { cmd: 'quit' };

/** words of a shell that has its own app window (macOS): standard menus, dialogs; keys `app.<name>` in the locales */
export const APP_LABELS = [
  'openInBrowser',
  'about',
  'hide',
  'edit',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'view',
  'reload',
  'actualSize',
  'zoomIn',
  'zoomOut',
  'window',
  'minimize',
  'zoom',
  'close',
  'ok',
  'cancel',
] as const;
export type AppLabel = (typeof APP_LABELS)[number];

export interface StatusEvent {
  event: 'status';
  server: ServerStatus;
  url: string | null;
  /** the sandboxed sites origin the app embeds (the app window lets it load in frames), null when unknown */
  sitesUrl: string | null;
  allStopped: boolean;
  autostart: boolean;
  /** null when this build cannot turn it on here (no app path to start at login) */
  autostartAvailable: boolean;
  updateCheck: boolean;
  /** one line about updates, or null when there is nothing to say */
  updateLine: string | null;
  updatePage: string | null;
  labels: Record<
    | 'title'
    | 'status'
    | 'open'
    | 'stopAll'
    | 'start'
    | 'stop'
    | 'autostart'
    | 'updateCheck'
    | 'checkNow'
    | 'logs'
    | 'quit'
    /** the Windows tray's first-run balloon and its can't-start box */
    | 'trayHint'
    | 'trayFailed'
    | AppLabel,
    string
  >;
  can: { open: boolean; stopAll: boolean; start: boolean; stop: boolean };
}

export type ShellEvent =
  | StatusEvent
  /** handedOff: the first copy was asked to show its window, so this copy only quits; else it opens `url` */
  | { event: 'already-running'; url: string | null; handedOff: boolean }
  /** bring up the app's window (a second launch asked for it) */
  | { event: 'show' }
  | { event: 'open'; url: string }
  /** answer to `setup-link`: a fresh first-run setup link for the app window, or null (an owner exists, no server) */
  | { event: 'setup-link'; url: string | null }
  | { event: 'reveal'; path: string }
  | { event: 'notice'; text: string }
  | { event: 'bye' };

export interface LauncherOptions {
  /** $PASABOT_HOME for the server and this app */
  home: string;
  /** how to run the server (env gets PASABOT_HOME added) */
  server: Omit<ServerLaunch, 'env' | 'logFile'> & {
    env?: NodeJS.ProcessEnv;
    /**
     * the server's one-shot setup-link minter (`mint-setup-link`, beside the entry by default), for a server this
     * launcher did not start (status `external`) and for a second launch that opens the browser
     */
    mintEntry?: string;
  };
  /** this launcher's own entry file (single-instance pid-reuse guard) */
  entry: string;
  /** version of the bundled server, for the update check */
  version: string;
  emit(e: ShellEvent): void;
  locale?: string | null;
  /** what open-at-login starts; null = toggle unavailable */
  appPath?: string | null;
  platform?: NodeJS.Platform;
  /** the environment open-at-login reads (APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME; default this process's) */
  env?: NodeJS.ProcessEnv;
  userHome: string;
  /** release file baked into the build (config.updateUrl wins) */
  updateUrl?: string | null;
  fetcher?: Fetcher;
  instanceDeps?: InstanceDeps;
  /** open the first-run setup link in the browser once the server is ready (default true) */
  openSetupLink?: boolean;
  /** the shell can show a window when a second launch asks (macOS); recorded in the lock (default false) */
  canShow?: boolean;
  /**
   * this launcher opens links itself, with no shell (the Linux starter, `--open-urls`): a second launch then pokes it
   * (recorded in the lock like a window) and it opens the app in the browser, a fresh setup link while unclaimed
   */
  opensUrls?: boolean;
  /** start the server as soon as the app starts (default true) */
  startOnLaunch?: boolean;
  /**
   * how this process quits when the web app's Settings asks (main.ts: quit, then exit); default `quit()` alone, for a
   * shell that exits on `bye`
   */
  onQuitRequest?: () => void;
  stopGraceMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;

export class Launcher {
  private lock: InstanceLock | null = null;
  private config: DesktopConfig;
  private readonly strings: Strings;
  private server: ServerProcess | null = null;
  private status: ServerStatus = 'stopped';
  private url: string | null = null;
  private sitesUrl: string | null = null;
  private failReason = '';
  private allStopped = false;
  private update: UpdateResult = { status: 'off' };
  private updateTimer: NodeJS.Timeout | null = null;
  private quitting: Promise<void> | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private setupAsk: Promise<void> | null = null;

  constructor(private readonly o: LauncherOptions) {
    this.config = readConfig(o.home);
    this.strings = loadStrings(pickLocale(o.locale));
  }

  get logFile() {
    return join(this.o.home, 'logs', 'desktop-server.log');
  }

  get serverPid(): number | null {
    return this.server?.pid ?? null;
  }

  private get autostartTarget(): AutostartTarget | null {
    if (!this.o.appPath) return null;
    const env = this.o.env ?? process.env;
    const t: AutostartTarget = {
      platform: this.o.platform ?? process.platform,
      userHome: this.o.userHome,
      appPath: this.o.appPath,
      // a redirected roaming profile keeps its Startup folder under %APPDATA%, not <home>\AppData\Roaming
      ...(env.APPDATA ? { appData: env.APPDATA } : {}),
      env,
    };
    // a Windows install path cmd.exe could misread: the toggle says unavailable instead of silently doing nothing
    return autostartPossible(t) ? t : null;
  }

  /** take the lock and start; false when another copy already runs (it has been told to open instead) */
  async init(): Promise<boolean> {
    const deps = this.o.instanceDeps;
    const got = acquireInstance(
      this.o.home,
      this.o.entry,
      deps,
      process.pid,
      this.o.canShow === true || this.o.opensUrls === true,
    );
    if (!got.ok) {
      const handedOff =
        got.holder.show === true && (deps ? (deps.poke?.(got.holder.pid) ?? false) : poke(got.holder.pid));
      // a shell without a window opens the address in the browser: while there is no owner, a fresh setup link
      // instead, so a second launch never lands on a bare or expired claim page (null: the address as before)
      const url =
        !handedOff && got.holder.url
          ? ((await this.mintOffline(got.holder.url)) ?? got.holder.url)
          : got.holder.url;
      this.o.emit({ event: 'already-running', url, handedOff });
      return false;
    }
    this.lock = got.lock;
    if (this.externalServer()) {
      this.status = 'external';
      this.url = `http://${LOOPBACK}:${this.config.port}`;
      this.emitStatus();
      // no boot link comes from a server this launcher did not start: a shell without a window (the Linux starter has
      // no other UI at all) opens a freshly minted one instead while unclaimed; once an owner exists nothing opens,
      // as for a server it starts itself
      if (this.o.canShow !== true && this.o.openSetupLink !== false) {
        const link = await this.mintOffline(this.url);
        if (link) this.o.emit({ event: 'open', url: link });
      }
    } else if (this.o.startOnLaunch !== false) {
      await this.start();
    } else this.emitStatus();
    if (this.config.updateCheck) void this.checkNow();
    this.scheduleUpdates();
    return true;
  }

  /** a server started by `pasabot start` (pid file) for this same data dir: never start a second one on it */
  private externalServer(): boolean {
    try {
      const pid = Number(
        readFileSync(join(this.o.home, 'run', 'server.pid'), 'utf8')
          .split('\n')[0]
          ?.trim(),
      );
      return Number.isInteger(pid) && pid > 1 && (this.o.instanceDeps?.alive ?? alive)(pid);
    } catch {
      return false;
    }
  }

  /** run one command; commands are serialised so a double click cannot start two servers */
  handle(c: Command): Promise<void> {
    // a link ask never waits behind a start or a stop all: the window is waiting on it
    if (c.cmd === 'setup-link') return this.freshSetupLink();
    const run = this.busy.then(() => this.dispatch(c));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async dispatch(c: Command): Promise<void> {
    switch (c.cmd) {
      case 'status':
        return this.emitStatus();
      case 'start':
        return this.start();
      case 'stop':
        return this.stop();
      case 'open':
        return this.openApp();
      case 'stop-all':
        return this.stopAll();
      case 'logs':
        this.o.emit({ event: 'reveal', path: this.logFile });
        return;
      case 'autostart': {
        const target = this.autostartTarget;
        if (target) setAutostart(target, c.on === true);
        return this.emitStatus();
      }
      case 'update-check':
        this.config = { ...this.config, updateCheck: c.on === true };
        writeConfig(this.o.home, this.config);
        this.update = { status: 'off' };
        this.scheduleUpdates();
        if (this.config.updateCheck) return this.checkNow();
        return this.emitStatus();
      case 'check-now':
        return this.checkNow();
      case 'open-update':
        if (this.update.status === 'available' && this.update.info.page)
          this.o.emit({ event: 'open', url: this.update.info.page });
        return;
      case 'setup-link':
        return this.freshSetupLink();
      case 'quit':
        return this.quit();
    }
  }

  /**
   * Open the web app. A shell without a window (the Windows tray, the Linux starter) opens the browser: while there is
   * no owner it gets a fresh setup link (asked at this moment, so never one that ran out), never the bare address
   * that would ask for a code; once an owner exists, the bare address. The macOS window asks on its own.
   */
  private async openApp(): Promise<void> {
    if (!this.url) return;
    const link = this.o.canShow === true ? null : await this.setupLinkNow();
    const url = this.url;
    if (url) this.o.emit({ event: 'open', url: link ?? url });
  }

  /**
   * A fresh first-run setup link for the shell's window, asked over the server's private channel (the only way one is
   * minted besides the boot link and `pasabot setup-link`). One ask at a time; the server itself hands the same link
   * back for a few seconds, so a reload loop cannot churn its table. The link goes only to the shell (stdout).
   */
  private freshSetupLink(): Promise<void> {
    if (this.setupAsk) return this.setupAsk;
    this.setupAsk = (async () => {
      const url = await this.setupLinkNow();
      this.o.emit({ event: 'setup-link', url });
    })().finally(() => {
      this.setupAsk = null;
    });
    return this.setupAsk;
  }

  /**
   * A fresh setup link, or null once an owner exists: over the channel from the server this launcher runs; from the
   * data dir's database (the one-shot minter, as `pasabot setup-link` does) for a server it did not start.
   */
  private async setupLinkNow(): Promise<string | null> {
    const proc = this.server;
    if (proc && this.status === 'running') return proc.requestSetupLink();
    if (this.status === 'external' && this.url) return this.mintOffline(this.url);
    return null;
  }

  /**
   * Runs the server's one-shot minter (`mint-setup-link`) on this data dir: a fresh link on `base`, or null (an owner
   * exists, no database, no minter, it failed or took too long). Its output goes only to the caller, never to a log.
   */
  private mintOffline(base: string): Promise<string | null> {
    const s = this.o.server;
    const entry = s.mintEntry ?? join(dirname(s.entry), `mint-setup-link${extname(s.entry)}`);
    if (!existsSync(entry)) return Promise.resolve(null);
    const prefix = `${base.replace(/\/$/, '')}/#/setup?token=`;
    return new Promise((resolve) => {
      execFile(
        s.node,
        [...(s.execArgv ?? []), entry, base],
        {
          env: { ...(s.env ?? process.env), PASABOT_HOME: this.o.home },
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (err, stdout) => {
          const link = err ? '' : String(stdout).trim();
          resolve(link.startsWith(prefix) && !/\s/.test(link) ? link : null);
        },
      );
    });
  }

  private async start(): Promise<void> {
    if (this.server || this.status === 'external' || this.quitting) return this.emitStatus();
    this.status = 'starting';
    this.allStopped = false;
    this.emitStatus();
    let ready: ServerReady | null = null;
    let lastError = '';
    const port = await pickPort(this.config.port);
    const sitesPort = await pickPort(this.config.sitesPort);
    // first try the preferred ports; if one was taken between the probe and the bind, retry once with 0/0
    for (const [p, sp] of port === 0 && sitesPort === 0
      ? [[0, 0]]
      : [
          [port, sitesPort],
          [0, 0],
        ]) {
      const proc = new ServerProcess({
        ...this.o.server,
        env: { ...(this.o.server.env ?? process.env), PASABOT_HOME: this.o.home },
        logFile: this.logFile,
      });
      this.server = proc;
      try {
        ready = await proc.start(p as number, sp as number);
        this.watch(proc);
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await proc.stop(this.o.stopGraceMs);
        this.server = null;
      }
    }
    if (!ready) {
      this.status = 'failed';
      this.failReason = lastError;
      return this.emitStatus();
    }
    this.status = 'running';
    this.url = ready.url;
    this.sitesUrl = ready.sitesUrl || null;
    this.allStopped = ready.stopped;
    this.lock?.update({ url: ready.url, serverPid: this.server?.pid ?? null });
    // remember the ports actually used, so the phone's paired address stays the same next time
    const used = {
      port: portOf(ready.url),
      sitesPort: ready.sitesUrl ? portOf(ready.sitesUrl) : this.config.sitesPort,
    };
    if (used.port !== this.config.port || used.sitesPort !== this.config.sitesPort) {
      this.config = { ...this.config, ...used };
      writeConfig(this.o.home, this.config);
    }
    this.emitStatus();
    if (ready.setupLink && this.o.openSetupLink !== false)
      this.o.emit({ event: 'open', url: ready.setupLink });
    // W16: the Screen Helper gets this launch's key and starts through LaunchServices (macOS app builds only)
    const helperApp =
      (this.o.platform ?? process.platform) === 'darwin' ? helperAppPath(this.o.appPath) : null;
    if (helperApp) void startScreenHelper({ home: this.o.home, app: helperApp });
  }

  private watch(proc: ServerProcess) {
    proc.on('state', (s) => {
      this.allStopped = s.stopped;
      this.emitStatus();
    });
    // the web app's Settings (Windows and Linux): Quit PasaBot and Open at sign-in, the same commands as the tray's
    proc.on('desktop-ask', (a) => {
      if (!this.desktopOffer().quit) return;
      if (a.what === 'quit') {
        if (this.o.onQuitRequest) this.o.onQuitRequest();
        else void this.quit();
      } else void this.handle({ cmd: 'autostart', on: a.on });
    });
    proc.once('exit', (code, signal) => {
      if (this.server !== proc) return;
      this.server = null;
      this.lock?.update({ serverPid: null });
      if (this.status === 'stopping' || this.quitting) return;
      // it died on its own: say so, never restart in a loop
      this.status = 'failed';
      this.failReason = signal ?? `exit ${code}`;
      this.emitStatus();
    });
  }

  private async stop(): Promise<void> {
    const proc = this.server;
    if (!proc) {
      if (this.status !== 'external') this.status = 'stopped';
      return this.emitStatus();
    }
    this.status = 'stopping';
    this.emitStatus();
    await proc.stop(this.o.stopGraceMs);
    this.server = null;
    this.status = 'stopped';
    this.lock?.update({ serverPid: null });
    // the Screen Helper quits once its key is gone
    removeHelperKey(this.o.home);
    this.emitStatus();
  }

  private async stopAll(): Promise<void> {
    if (this.status === 'external' && this.url) {
      // a service-run server: the stop button is in the web app (it needs a signed-in session there); unclaimed, a
      // shell without a window opens a fresh setup link there, as for Open
      return this.openApp();
    }
    if (!this.server) return this.emitStatus();
    try {
      const s = await this.server.stopAll();
      this.allStopped = s.stopped;
    } catch (e) {
      this.o.emit({
        event: 'notice',
        text: t(this.strings, 'stopAll.failed', { reason: e instanceof Error ? e.message : String(e) }),
      });
    }
    this.emitStatus();
  }

  private scheduleUpdates() {
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.updateTimer = null;
    if (!this.config.updateCheck) return;
    this.updateTimer = setInterval(() => void this.handle({ cmd: 'check-now' }), DAY);
    this.updateTimer.unref();
  }

  async checkNow(): Promise<void> {
    this.update = await checkForUpdate({
      enabled: this.config.updateCheck,
      current: this.o.version,
      url: this.config.updateUrl ?? this.o.updateUrl ?? null,
      fetcher: this.o.fetcher,
    });
    this.emitStatus();
  }

  /**
   * A second launch poked this copy: tell the shell to bring its window up; a launcher that opens links itself (no
   * window) opens the app in the browser instead, a fresh setup link while there is no owner (asked over its own
   * channel, so the server's 10 s reuse holds for a double click)
   */
  requestShow(): void {
    if (!this.lock || this.quitting) return;
    if (this.o.canShow === true) this.o.emit({ event: 'show' });
    else if (this.o.opensUrls === true)
      void this.handle({ cmd: 'open' }).catch((e: unknown) => {
        this.o.emit({ event: 'notice', text: e instanceof Error ? e.message : String(e) });
      });
  }

  /** stop the server, drop the lock, say bye; safe to call more than once */
  quit(): Promise<void> {
    if (!this.quitting)
      this.quitting = (async () => {
        if (this.updateTimer) clearInterval(this.updateTimer);
        const proc = this.server;
        if (proc) {
          this.status = 'stopping';
          await proc.stop(this.o.stopGraceMs);
          this.server = null;
        }
        this.status = 'stopped';
        this.lock?.release();
        this.o.emit({ event: 'bye' });
      })();
    return this.quitting;
  }

  private updateLine(): string | null {
    const u = this.update;
    switch (u.status) {
      case 'available':
        return t(this.strings, 'update.available', { version: u.info.version });
      case 'current':
        return t(this.strings, 'update.current');
      case 'no-source':
        return t(this.strings, 'update.noSource');
      case 'failed':
        return t(this.strings, 'update.failed', { reason: u.reason });
      case 'off':
        return null;
    }
  }

  snapshot(): StatusEvent {
    const s = this.strings;
    const statusKey: Record<ServerStatus, string> = {
      starting: 'status.starting',
      running: 'status.running',
      stopping: 'status.stopping',
      stopped: 'status.stopped',
      failed: 'status.failed',
      external: 'status.external',
    };
    const running = this.status === 'running';
    const target = this.autostartTarget;
    return {
      event: 'status',
      server: this.status,
      url: running || this.status === 'external' ? this.url : null,
      sitesUrl: running ? this.sitesUrl : null,
      allStopped: this.allStopped,
      autostart: target ? isAutostartOn(target) : false,
      autostartAvailable: target !== null,
      updateCheck: this.config.updateCheck,
      updateLine: this.updateLine(),
      updatePage: this.update.status === 'available' ? this.update.info.page : null,
      labels: {
        title: t(s, 'app.name'),
        status:
          running && this.allStopped
            ? t(s, 'status.allStopped')
            : t(s, statusKey[this.status], { reason: this.failReason }),
        open: t(s, 'menu.open'),
        stopAll: t(s, 'menu.stopAll'),
        start: t(s, 'menu.startServer'),
        stop: t(s, 'menu.stopServer'),
        autostart: t(s, 'menu.autostart'),
        updateCheck: t(s, 'menu.updateCheck'),
        checkNow: t(s, 'menu.checkNow'),
        logs: t(s, 'menu.logs'),
        quit: t(s, 'menu.quit'),
        trayHint: t(s, 'tray.hint'),
        trayFailed: t(s, 'tray.failed'),
        ...(Object.fromEntries(APP_LABELS.map((k) => [k, t(s, `app.${k}`)])) as Record<AppLabel, string>),
      },
      can: {
        open: (running || this.status === 'external') && this.url !== null,
        stopAll: (running && !this.allStopped) || this.status === 'external',
        start: this.status === 'stopped' || this.status === 'failed',
        stop: running || this.status === 'starting',
      },
    };
  }

  /**
   * Which of its own controls this launcher lets the web app's Settings offer: on Windows and Linux, where there may
   * be no tray icon at all, Quit and (when this build can) Open at sign-in. macOS has its own app menus for both.
   */
  desktopOffer(): DesktopOffer {
    if ((this.o.platform ?? process.platform) === 'darwin')
      return { quit: false, autostart: false, autostartAvailable: false };
    const target = this.autostartTarget;
    return {
      quit: true,
      autostart: target ? isAutostartOn(target) : false,
      autostartAvailable: target !== null,
    };
  }

  private emitStatus(): void {
    if (this.quitting && this.status === 'stopped') return;
    this.o.emit(this.snapshot());
    this.server?.tellDesktop(this.desktopOffer());
  }
}
