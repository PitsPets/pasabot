/**
 * A stand-in for PasaBot Screen Helper that speaks the real protocol over a real unix socket, with the reference
 * guard (guard.ts) and the practice test app as its "screen". Tests use it to prove the macOS driver end to end, and
 * the e2e run starts it (`e2e/fake-helper.ts`) so the setup and approval cards are exercised in a browser on any OS.
 * Its permissions start off and flip on when the matching settings pane is "opened" (as if the owner flipped the
 * switch), so the setup card's ticks can be watched turning green.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { PointerOrKeyAction } from '@pasabot/core';
import { PracticeDriver } from '../drivers/practice.js';
import { helperPaths } from './client.js';
import { type GuardOptions, HelperGuard, Refusal } from './guard.js';
import {
  type Grant,
  helloMessage,
  hmacHex,
  PROTOCOL_VERSION,
  parseKey,
  SETTINGS_PANES,
  sameHex,
  type WireRequest,
} from './protocol.js';

export interface FakeHelperOptions {
  /** the run folder ($PASABOT_HOME/run); created 0700 */
  dir: string;
  /** write a fresh key file (as the launcher does); default true */
  writeKey?: boolean;
  /** flip a permission on this long after its pane was opened (default 300 ms; null = never) */
  autoGrantMs?: number | null;
  permissions?: { screenRecording?: boolean; accessibility?: boolean };
  guard?: GuardOptions;
}

export class FakeHelper {
  readonly paths: ReturnType<typeof helperPaths>;
  readonly screen = new PracticeDriver();
  readonly perms = { screenRecording: false, accessibility: false };
  /** test switches: a password box has the keyboard; the target is a protected window */
  secureInput = false;
  protectedTarget = false;
  readonly opened: string[] = [];
  readonly log: { verb: string; ok: boolean; code?: string }[] = [];
  private server: Server | null = null;
  private readonly conns = new Set<Socket>();
  private guard!: HelperGuard;
  private key!: Buffer;

  constructor(private readonly o: FakeHelperOptions) {
    this.paths = helperPaths(o.dir);
    Object.assign(this.perms, o.permissions ?? {});
  }

  async start(): Promise<void> {
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.o.dir, 0o700);
    if (this.o.writeKey !== false)
      writeFileSync(this.paths.key, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.key = parseKey(readFileSync(this.paths.key, 'utf8'));
    this.guard = new HelperGuard(
      this.key,
      {
        secureInput: () => this.secureInput,
        protectedTarget: () => this.protectedTarget,
        screenRecording: () => this.perms.screenRecording,
        accessibility: () => this.perms.accessibility,
      },
      this.o.guard,
    );
    await this.screen.start();
    if (existsSync(this.paths.socket)) rmSync(this.paths.socket);
    const server = createServer((c) => this.serve(c));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.paths.socket, () => resolve());
    });
    chmodSync(this.paths.socket, 0o600);
  }

  /** what Esc held for a second or the menu's "Stop" does */
  stopFromKey(by = 'key') {
    this.guard.stop();
    for (const c of this.conns) c.write(`${JSON.stringify({ event: 'stopped', by })}\n`);
  }
  get stopped() {
    return this.guard.stopped;
  }

  private serve(c: Socket) {
    this.conns.add(c);
    c.setEncoding('utf8');
    const nonce = randomBytes(16).toString('hex');
    let authed = false;
    let buf = '';
    c.write(`${JSON.stringify({ hello: nonce, v: PROTOCOL_VERSION })}\n`);
    c.on('error', () => {});
    c.on('close', () => this.conns.delete(c));
    c.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 1024 * 1024) return void c.destroy();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        let msg: { auth?: string; id?: number; verb?: string; args?: Record<string, unknown>; grant?: Grant };
        try {
          msg = JSON.parse(line);
        } catch {
          return void c.destroy();
        }
        if (!authed) {
          if (typeof msg.auth !== 'string' || !sameHex(msg.auth, hmacHex(this.key, helloMessage(nonce))))
            return void c.destroy();
          authed = true;
          c.write(`${JSON.stringify({ welcome: true })}\n`);
          continue;
        }
        void this.answer(msg).then((r) => c.write(`${JSON.stringify({ id: msg.id, ...r })}\n`));
      }
    });
  }

  private async answer(msg: {
    verb?: string;
    args?: Record<string, unknown>;
    grant?: Grant;
  }): Promise<Record<string, unknown>> {
    const verb = String(msg.verb ?? '');
    const args = msg.args ?? {};
    const done = (r: Record<string, unknown>) => {
      this.log.push({ verb, ok: r.ok === true, ...(typeof r.code === 'string' ? { code: r.code } : {}) });
      return r;
    };
    if (verb === 'status')
      return done({
        ok: true,
        ...this.perms,
        stopped: this.guard.stopped,
        controlling: false,
        version: 'fake',
      });
    if (verb === 'stop') {
      this.stopFromKey('server');
      return done({ ok: true });
    }
    if (verb === 'open_settings') {
      const pane = args.pane;
      if (pane !== 'screen' && pane !== 'accessibility') return done({ ok: false, code: 'bad_request' });
      this.opened.push(SETTINGS_PANES[pane]);
      const ms = this.o.autoGrantMs === undefined ? 300 : this.o.autoGrantMs;
      if (ms !== null)
        setTimeout(() => {
          if (pane === 'screen') this.perms.screenRecording = true;
          else this.perms.accessibility = true;
        }, ms).unref();
      return done({ ok: true });
    }
    const r = { verb, args } as WireRequest;
    try {
      this.guard.check(r, msg.grant);
    } catch (e) {
      if (e instanceof Refusal) return done({ ok: false, code: e.code, message: e.message });
      return done({ ok: false, code: 'bad_request', message: (e as Error).message });
    }
    try {
      const d = this.screen.display();
      if (r.verb === 'resume') return done({ ok: true });
      if (r.verb === 'displays' || r.verb === 'screenshot') {
        const base = {
          ok: true,
          width: d.width,
          height: d.height,
          pointsWidth: d.width,
          pointsHeight: d.height,
        };
        if (r.verb === 'displays') return done(base);
        const png = await this.screen.screenshot();
        return done({ ...base, png: Buffer.from(png).toString('base64') });
      }
      const a: PointerOrKeyAction =
        r.verb === 'click'
          ? { kind: 'click', x: r.args.x, y: r.args.y, button: r.args.button }
          : r.verb === 'move'
            ? { kind: 'move', x: r.args.x, y: r.args.y }
            : r.verb === 'type'
              ? { kind: 'type', text: r.args.text }
              : { kind: 'key', keys: (r.args as { keys: string }).keys };
      await this.screen.act(a);
      return done({ ok: true });
    } catch (e) {
      return done({ ok: false, code: 'bad_request', message: (e as Error).message });
    }
  }

  async close() {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    await this.screen.stop();
  }
}
