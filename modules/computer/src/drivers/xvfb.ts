/**
 * Linux: a virtual X display per agent (Xvfb), driven with xdotool and captured with ImageMagick `import`.
 * The agent's display is never the owner's: Xvfb picks a free display itself (`-displayfd`), the number is
 * refused if it equals the owner's `$DISPLAY`, and every helper runs with a scrubbed environment that carries
 * only `PATH`, the agent's own `DISPLAY` and that display's own `XAUTHORITY` (never the owner's `XAUTHORITY`,
 * `WAYLAND_DISPLAY` or session bus).
 *
 * Only PasaBot's own helpers may connect: each display gets a fresh MIT-MAGIC-COOKIE-1 in a 0600 file under the
 * module's data dir ($PASABOT_HOME, which the agent sandbox hides), Xvfb is started with `-auth <file>`, so a client
 * without the cookie (an agent's CLI running `xdotool` from its workspace shell) is refused, and with
 * `-nolisten tcp -nolisten local`, so there is no TCP port and no Linux abstract socket (`@/tmp/.X11-unix/X<n>`)
 * that a sandbox with its own /tmp could still reach. The cookie file is removed when the display stops. Every
 * Xvfb this process started is killed (and its cookie removed) when the process exits.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { DisplayInfo, Png, PointerOrKeyAction } from '@pasabot/core';
import { pngSize } from '../png.js';
import { checkAction, checkKeys, type ManagedDriver, type Runner, runCommand } from './types.js';

export interface XvfbBins {
  xvfb: string;
  xdotool: string;
  /** ImageMagick `import` */
  import: string;
}
export interface XvfbOptions {
  width?: number;
  height?: number;
  bins?: Partial<XvfbBins>;
  /** the owner's display (default `process.env.DISPLAY`); the agent's display is never this one */
  ownerDisplay?: string;
  /** PATH for the helpers (default `process.env.PATH`) */
  path?: string;
  startTimeoutMs?: number;
  run?: Runner;
  /**
   * Folder for the display's cookie file (created 0700; the file is 0600). The server passes the module's data
   * dir under $PASABOT_HOME, which agent sandboxes cannot read. Default: a fresh private temp folder.
   */
  authDir?: string;
}

const live = new Map<ChildProcess, string>();
let hooked = false;
function track(c: ChildProcess, authFile: string) {
  live.set(c, authFile);
  c.once('exit', () => live.delete(c));
  if (!hooked) {
    hooked = true;
    process.once('exit', () => {
      for (const [p, f] of live) {
        p.kill('SIGKILL');
        rmSync(f, { force: true });
      }
    });
  }
}

const COOKIE_NAME = 'MIT-MAGIC-COOKIE-1';
/**
 * One Xauthority entry (the libXau file format): family FamilyWild (0xffff, any host), empty display number (any
 * display), so the file is complete before Xvfb has picked its number. Xvfb loads every cookie in its `-auth` file.
 */
export function xauthEntry(cookie: Uint8Array): Buffer {
  const field = (b: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from(COOKIE_NAME, 'latin1')),
    field(Buffer.from(cookie)),
  ]);
}

/** A fresh 16-byte cookie written to a new 0600 file in `dir` (made 0700); returns the file's path. */
export function writeCookieFile(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `display-${randomBytes(8).toString('hex')}.xauth`);
  // 'wx': never follow or reuse something already there
  writeFileSync(file, xauthEntry(randomBytes(16)), { mode: 0o600, flag: 'wx' });
  return file;
}

/** Display number from `:N`, `:N.S` or `host:N`; null when there is none. */
export function displayNumber(d: string | undefined): number | null {
  if (!d) return null;
  const at = d.lastIndexOf(':');
  if (at < 0) return null;
  const n = Number.parseInt(d.slice(at + 1).split('.')[0] ?? '', 10);
  return Number.isInteger(n) ? n : null;
}

/** First executable named `name` on `path`, or null. */
export function which(name: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Which of the Linux helpers are missing from `path`. */
export function missingXvfbBins(path = process.env.PATH ?? ''): string[] {
  return (['Xvfb', 'xdotool', 'import'] as const).filter((b) => !which(b, path));
}

export class XvfbDriver implements ManagedDriver {
  readonly kind = 'xvfb' as const;
  readonly sharesOwnerScreen = false;
  private child: ChildProcess | null = null;
  private num: number | null = null;
  private authFile: string | null = null;
  private readonly w: number;
  private readonly h: number;
  private readonly bins: XvfbBins;
  private readonly run: Runner;

  constructor(private readonly o: XvfbOptions = {}) {
    this.w = o.width ?? 1280;
    this.h = o.height ?? 800;
    this.bins = { xvfb: 'Xvfb', xdotool: 'xdotool', import: 'import', ...o.bins };
    this.run = o.run ?? runCommand;
  }

  /** remove a display's cookie file (and its folder when it was our own temp folder) */
  private drop(authFile: string) {
    rmSync(this.o.authDir ? authFile : dirname(authFile), { recursive: true, force: true });
  }

  /** the only environment a helper sees */
  env(): NodeJS.ProcessEnv {
    if (this.num === null || this.authFile === null) throw new Error('the display is not running');
    return {
      PATH: this.o.path ?? process.env.PATH ?? '/usr/bin:/bin',
      DISPLAY: `:${this.num}`,
      XAUTHORITY: this.authFile,
    };
  }
  label() {
    return this.num === null ? '' : `:${this.num}`;
  }
  pid() {
    return this.child?.pid ?? null;
  }
  alive() {
    return this.child !== null;
  }
  display(): DisplayInfo {
    return { width: this.w, height: this.h, scale: 1 };
  }

  async start(): Promise<void> {
    if (this.child) return;
    const owner = displayNumber(this.o.ownerDisplay ?? process.env.DISPLAY);
    const authFile = writeCookieFile(this.o.authDir ?? mkdtempSync(join(tmpdir(), 'pasabot-xauth-')));
    let child: ChildProcess;
    try {
      child = spawn(
        this.bins.xvfb,
        [
          '-displayfd',
          '3',
          '-auth',
          authFile,
          '-screen',
          '0',
          `${this.w}x${this.h}x24`,
          '-nolisten',
          'tcp',
          '-nolisten',
          'local',
          '-noreset',
        ],
        {
          env: { PATH: this.o.path ?? process.env.PATH ?? '/usr/bin:/bin' },
          stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        },
      );
    } catch (e) {
      this.drop(authFile);
      throw e;
    }
    track(child, authFile);
    let err = '';
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 2000) err += b.toString('utf8');
    });
    const num = await new Promise<number>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => fail(new Error('Xvfb did not start in time')),
        this.o.startTimeoutMs ?? 10_000,
      );
      const fail = (e: Error) => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        this.drop(authFile);
        reject(e);
      };
      const fd3 = child.stdio[3] as NodeJS.ReadableStream | null;
      fd3?.on('data', (b: Buffer) => {
        buf += b.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        const n = Number.parseInt(buf.slice(0, nl).trim(), 10);
        if (!Number.isInteger(n) || n < 0) fail(new Error('Xvfb reported no display number'));
        else resolve(n);
      });
      child.once('error', (e) => fail(e));
      child.once('close', (code) =>
        fail(new Error(`Xvfb exited (${code}) before it was ready: ${err.trim().slice(0, 200)}`)),
      );
    });
    if (owner !== null && num === owner) {
      child.kill('SIGKILL');
      this.drop(authFile);
      throw new Error("Xvfb picked the owner's own display; refusing to use it");
    }
    this.child = child;
    this.num = num;
    this.authFile = authFile;
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.num = null;
        this.authFile = null;
      }
      this.drop(authFile);
    });
  }

  async stop(): Promise<void> {
    const c = this.child;
    const f = this.authFile;
    if (!c) return;
    this.child = null;
    this.num = null;
    this.authFile = null;
    if (c.exitCode !== null || c.signalCode !== null) {
      if (f) this.drop(f);
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => c.kill('SIGKILL'), 2000);
      c.once('exit', () => {
        clearTimeout(t);
        if (f) this.drop(f);
        resolve();
      });
      c.kill('SIGTERM');
    });
  }

  /** the helper command for an action (exact argv, no shell) */
  argv(a: PointerOrKeyAction): string[] {
    switch (a.kind) {
      case 'click':
        return ['mousemove', '--sync', String(a.x), String(a.y), 'click', a.button === 'right' ? '3' : '1'];
      case 'move':
        return ['mousemove', '--sync', String(a.x), String(a.y)];
      case 'type':
        return ['type', '--delay', '12', '--', a.text];
      case 'key':
        return ['key', '--clearmodifiers', '--', ...checkKeys(a.keys)];
    }
  }

  async act(a: PointerOrKeyAction): Promise<void> {
    checkAction(a, this.display());
    await this.run(this.bins.xdotool, this.argv(a), { env: this.env(), timeoutMs: 30_000 });
  }

  async screenshot(): Promise<Png> {
    const { stdout } = await this.run(this.bins.import, ['-window', 'root', 'png:-'], {
      env: this.env(),
      timeoutMs: 15_000,
    });
    if (!pngSize(stdout)) throw new Error('the screenshot is not a PNG');
    return new Uint8Array(stdout);
  }
}
