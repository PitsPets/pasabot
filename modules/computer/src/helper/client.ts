/**
 * The server's end of the private channel to PasaBot Screen Helper (see protocol.ts). It refuses to talk over a
 * socket or key file that someone else could have planted or read: both must belong to this user, the folder must
 * be 0700 and the files 0600 (no group or other bits). One connection, reopened on the next request after it drops.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  type FreeVerb,
  type Grant,
  type HelperStatus,
  helloMessage,
  hmacHex,
  PROTOCOL_VERSION,
  parseKey,
  type RefusalCode,
  type WireRequest,
} from './protocol.js';

export const SOCKET_NAME = 'screen.sock';
export const KEY_NAME = 'screen.key';

/** `$PASABOT_HOME/run` (or `PASABOT_SCREEN_HELPER_DIR`, used by the e2e run's fake helper) */
export function helperPaths(runDir: string) {
  return { dir: runDir, socket: join(runDir, SOCKET_NAME), key: join(runDir, KEY_NAME) };
}

export class HelperError extends Error {
  constructor(
    readonly code: RefusalCode | 'not_running' | 'unsafe_files' | 'auth_failed' | 'timeout' | 'closed',
    message: string,
  ) {
    super(message);
  }
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** throws `unsafe_files` unless path is this user's, of the right type, with no group/other permission bits */
export function checkPrivate(path: string, want: 'socket' | 'file' | 'dir'): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new HelperError('not_running', 'PasaBot Screen Helper is not running');
  }
  const typeOk = want === 'socket' ? st.isSocket() : want === 'dir' ? st.isDirectory() : st.isFile();
  if (!typeOk) throw new HelperError('unsafe_files', `${path} is not a ${want}`);
  if (uid() >= 0 && st.uid !== uid())
    throw new HelperError('unsafe_files', `${path} belongs to another user`);
  if ((st.mode & 0o077) !== 0)
    throw new HelperError(
      'unsafe_files',
      `${path} can be opened by other users (mode ${(st.mode & 0o777).toString(8)})`,
    );
}

type Pending = { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: NodeJS.Timeout };

export interface HelperClientOptions {
  socketPath: string;
  keyPath: string;
  /** per request (default 20 s; a screenshot of a big screen can take a moment) */
  timeoutMs?: number;
  /** pushed by the helper: control was cut (Esc held 1 s, its menu, or our own stop) */
  onStopped?(by: string): void;
}

export class HelperClient {
  private sock: Socket | null = null;
  private ready: Promise<Socket> | null = null;
  private next = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly o: HelperClientOptions) {}

  private open(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed && this.ready) return this.ready;
    checkPrivate(dirname(this.o.socketPath), 'dir');
    checkPrivate(this.o.socketPath, 'socket');
    checkPrivate(this.o.keyPath, 'file');
    const key = parseKey(readFileSync(this.o.keyPath, 'utf8'));
    const sock = connect(this.o.socketPath);
    this.sock = sock;
    sock.setEncoding('utf8');
    let buf = '';
    let greeted = false;
    let welcomed = false;
    this.ready = new Promise<Socket>((resolve, reject) => {
      const fail = (e: Error) => {
        reject(e);
        sock.destroy();
      };
      const timer = setTimeout(
        () => fail(new HelperError('timeout', 'the screen helper did not answer')),
        5000,
      );
      sock.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(
          e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
            ? new HelperError('not_running', 'PasaBot Screen Helper is not running')
            : e,
        );
      });
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > 64 * 1024 * 1024) {
          sock.destroy();
          return;
        }
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!greeted) {
            if (typeof msg.hello !== 'string' || msg.v !== PROTOCOL_VERSION) {
              clearTimeout(timer);
              fail(new HelperError('auth_failed', 'the screen helper spoke an unknown protocol'));
              return;
            }
            greeted = true;
            sock.write(`${JSON.stringify({ auth: hmacHex(key, helloMessage(msg.hello)) })}\n`);
            continue;
          }
          if (msg.welcome === true) {
            welcomed = true;
            clearTimeout(timer);
            resolve(sock);
            continue;
          }
          if (msg.event === 'stopped') {
            this.o.onStopped?.(typeof msg.by === 'string' ? msg.by : 'helper');
            continue;
          }
          const id = typeof msg.id === 'number' ? msg.id : -1;
          const p = this.pending.get(id);
          if (!p) continue;
          this.pending.delete(id);
          clearTimeout(p.timer);
          if (msg.ok === true) p.resolve(msg);
          else
            p.reject(
              new HelperError(
                (typeof msg.code === 'string' ? msg.code : 'bad_request') as RefusalCode,
                typeof msg.message === 'string' ? msg.message : 'the screen helper refused',
              ),
            );
        }
      });
      sock.once('close', () => {
        clearTimeout(timer);
        if (!welcomed) reject(new HelperError('auth_failed', 'the screen helper closed the connection'));
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new HelperError('closed', 'the screen helper went away'));
          this.pending.delete(id);
        }
        if (this.sock === sock) {
          this.sock = null;
          this.ready = null;
        }
      });
    });
    return this.ready;
  }

  private async send(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sock = await this.open();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError('timeout', 'the screen helper did not answer in time'));
      }, this.o.timeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  /** a verb that sees or touches the screen; `grant` comes from the server's GrantIssuer after an approval */
  request(r: WireRequest, grant: Grant): Promise<Record<string, unknown>> {
    return this.send({ verb: r.verb, args: r.args, grant });
  }
  /** report or reduce only: status, stop, open_settings */
  free(verb: FreeVerb, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.send({ verb, args });
  }
  async status(): Promise<HelperStatus> {
    const r = await this.free('status');
    return {
      screenRecording: r.screenRecording === true,
      accessibility: r.accessibility === true,
      stopped: r.stopped === true,
      controlling: r.controlling === true,
      version: typeof r.version === 'string' ? r.version : '',
    };
  }
  close() {
    this.sock?.destroy();
    this.sock = null;
    this.ready = null;
  }
}
