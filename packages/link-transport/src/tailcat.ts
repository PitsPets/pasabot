/**
 * Default transport: the `tailcat` CLI (userspace WireGuard + NAT traversal + DERP relays, no account), driven as
 * child processes. PasaBot never bundles or links it. Written against the real tailcat v0.7.0 CLI:
 *
 * - Keys: two saved keys in our own state dir (0700 dir, 0600 files), always passed as `--key=<path>` so a user's
 *   saved `default` / `client-default` keys are never picked up: a server key (`genkey --fixed-region`, so the address
 *   stays the same across restarts) and a client key (`genkey --client`), whose `nodekey:<hex>` is what linked
 *   machines list in their `--allow`.
 * - Listener: ONE long-lived `tailcat --key=<server> serve --allow=<linked node keys|none> exec -- node -e <bridge>`.
 *   For each tunnel connection tailcat runs the bridge, which connects to our loopback-only TCP listener and first
 *   sends a line with a per-run token (from its environment, never argv) and `$TAILCAT_PEER_KEY`. `serve <port>` is
 *   not used: tailcat proxies to the SAME port number on localhost, so the dialer would have to know our loopback port,
 *   which changes at every start. The loopback port is not a trust boundary: the peer proof (`provePeer`) and the
 *   link handshake authenticate every connection exactly as over TCP+TLS; the token and `--allow` are extra layers.
 * - Linking window: a second, short-lived `tailcat --key=new serve exec -- …` (fresh ephemeral address, no `--allow`)
 *   while a link code is active; its connections are marked `viaLinkWindow` and only a code-proven link may pass.
 * - Dialer: ONE long-lived `tailcat --key=<client> socks` child (loopback SOCKS5, OS-chosen port); a dial is a SOCKS5
 *   CONNECT to `<address>:1`. Several `tailcat <addr>` client processes with the same key at once break each other
 *   (measured with v0.7.0: one of three concurrent clients was reset after 16 s), and the address never goes into an
 *   argv this way (`tailcat --key=x -- <arg>` would RUN `<arg>` in server exec mode).
 * - A refused client (not in `--allow`) is dropped silently by tailcat: the SOCKS CONNECT fails after ~10 s exactly like
 *   an unreachable one, so both map to one "unreachable or not allowed" error. Dials are capped at 15 s.
 * - The address is a bearer secret (it holds the WireGuard pre-shared key): never logged, never in an error, never in
 *   any argv (another local user can read a process's command line with `ps`). So `tailcat ping`, which only takes the
 *   address as a positional argument, is not used: the transport has no `probe` and Machines shows no direct/relay
 *   path. tailcat's stderr (which prints the address) is never forwarded. `TAILCAT_ADDR_FILE` (in our state dir)
 *   hands it over, not `--json`.
 * - Children get a minimal environment (no PasaBot secrets) with HOME / XDG / AppData pointed into our state dir, so
 *   tailcat's relay-map cache and config stay there. No helper process outlives `close()`, the PasaBot process, or
 *   (after a crash) the next start (pids are recorded and stale ones stopped).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import type { LinkKeys } from './keys.js';
import { provePeer } from './prove.js';
import {
  type LinkPeer,
  type LinkStream,
  type LinkTransport,
  LinkTransportError,
  type LinkTransportStatus,
} from './types.js';

/** the minor line PasaBot was built and tested against; another version works but logs a warning once */
export const TAILCAT_TESTED_VERSION = 'v0.7.0';
const TESTED_LINE = /^v?0\.7\.\d+$/;
/** the port a dial asks for; the exec service answers any port */
export const TAILCAT_LINK_PORT = 1;

/** A tailcat address: `tc` + base64url (~154 chars in v0.7.0). ≤ 255 so it fits a SOCKS5 host name. */
export const isTailcatAddress = (s: unknown): s is string =>
  typeof s === 'string' && /^tc[A-Za-z0-9_-]{20,253}$/.test(s);
/** A tailcat node key in `--allow`'s format. */
export const isTailcatNodeKey = (s: unknown): s is string =>
  typeof s === 'string' && /^nodekey:[0-9a-f]{64}$/.test(s);

/**
 * Every argv PasaBot passes to tailcat. Global flags (`--key`) come before the subcommand; `--key` is always explicit;
 * `--allow` is never empty (an empty `--allow=` swallows the next argument; `none` admits nobody); an address NEVER
 * appears (it is a bearer secret and argv is readable by other local users), so there is no `ping` here.
 */
export const TAILCAT_ARGV = {
  version: (): string[] => ['--version'],
  genServerKey: (key: string): string[] => ['genkey', '--fixed-region', `--key=${key}`],
  genClientKey: (key: string): string[] => ['genkey', '--client', `--key=${key}`],
  printpub: (key: string): string[] => [`--key=${key}`, 'printpub'],
  serve: (key: string, allow: readonly string[], helper: readonly string[]): string[] => [
    `--key=${key}`,
    'serve',
    `--allow=${allow.length ? allow.join(',') : 'none'}`,
    'exec',
    '--',
    ...helper,
  ],
  /** the linking window: an ephemeral address with no tunnel allow-list (the link code proof gates it) */
  serveLinkWindow: (helper: readonly string[]): string[] => ['--key=new', 'serve', 'exec', '--', ...helper],
  socks: (key: string): string[] => [`--key=${key}`, 'socks', '--listen=127.0.0.1:0'],
};
/** constant-time compare of the per-run bridge token */
const sameToken = (got: unknown, want: string) => {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const TAILCAT_INSTALL_HELP =
  'Machine linking uses the tailcat command-line tool (v0.7), which PasaBot does not ship. Install it, make sure the ' +
  '`tailcat` command is on the PATH of the user that runs PasaBot (or set PASABOT_TAILCAT_BIN to its full path), then ' +
  'restart PasaBot. macOS: `brew install tailcat`, or with Go: `go install github.com/tailscale/tailcat/cmd/tailcat@v0.7.0`. ' +
  'Linux and Windows: download the v0.7.0 release binary from github.com/tailscale/tailcat/releases and check it ' +
  'against the published checksums (or use the same `go install`). Until then you can link over a LAN or tailnet ' +
  'address instead (TCP+TLS).';

/**
 * Runs per tunnel connection under `serve exec` (CommonJS for `node -e`): connects to our loopback listener, sends the
 * token and the tunnel peer key, then pipes stdin/stdout both ways. Exits when either side closes or tailcat is gone.
 */
export const TAILCAT_BRIDGE_SOURCE =
  "const e=process.env,s=require('node:net').connect(+e.PASABOT_TC_PORT,'127.0.0.1');" +
  "s.on('connect',()=>{s.write(JSON.stringify({tok:e.PASABOT_TC_TOKEN,peer:e.TAILCAT_PEER_KEY||''})+'\\n');" +
  'process.stdin.pipe(s);s.pipe(process.stdout)});' +
  "s.on('error',()=>process.exit(1));s.on('close',()=>process.stdout.write('',()=>process.exit(0)));" +
  "process.stdin.on('end',()=>s.end());" +
  'const p=process.ppid;setInterval(()=>{if(process.ppid!==p)process.exit(0)},1000).unref();';

export interface TailcatLog {
  warn(msg: string, data?: Record<string, unknown>): void;
}
export interface TailcatOptions {
  keys: LinkKeys;
  /** tailcat's keys, cache and pid file; under the module's data dir */
  stateDir: string;
  /** default: $PASABOT_TAILCAT_BIN, else `tailcat` on PATH */
  bin?: string;
  /** node binary that runs the per-connection bridge; default: this process's */
  nodePath?: string;
  log?: TailcatLog;
  /** cap for a dial (SOCKS connect + peer proof) and for a tailcat start; default 15 s */
  timeoutMs?: number;
  /** the dialer's SOCKS child stops after this long without an open link stream; default 60 s */
  dialerIdleMs?: number;
}

const UNREACHABLE =
  'the linked machine is unreachable or does not admit this one (tailcat cannot tell which)';
const MAX_PREAMBLE = 1024;

export function createTailcatTransport(o: TailcatOptions): LinkTransport {
  const bin = o.bin ?? process.env.PASABOT_TAILCAT_BIN ?? 'tailcat';
  const node = o.nodePath ?? process.execPath;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const idleMs = o.dialerIdleMs ?? 60_000;
  const dir = o.stateDir;
  const serverKey = join(dir, 'server.private.json');
  const clientKey = join(dir, 'client.private.json');
  const pidFile = join(dir, 'children.json');
  const addrFile = join(dir, 'server.addr');
  const home = join(dir, 'home');
  const helper = [node, '-e', TAILCAT_BRIDGE_SOURCE];

  let address = '';
  let clientNodeKey = '';
  let version = '';
  let warned = false;
  let allowed: string[] = [];
  let restarts = 0;
  const mainToken = randomBytes(24).toString('base64url');
  const windowToken = randomBytes(24).toString('base64url');

  /** a minimal environment: no PasaBot secrets; tailcat's own TAILCAT_* settings pass through */
  const childEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG'])
      if (process.env[k]) env[k] = process.env[k]!;
    for (const [k, v] of Object.entries(process.env))
      if (k.startsWith('TAILCAT_') && k !== 'TAILCAT_ADDR_FILE' && v !== undefined) env[k] = v;
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      APPDATA: join(home, 'AppData', 'Roaming'),
    });
    return { ...env, ...extra };
  };
  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {}
  };
  const run = (argv: string[], env: Record<string, string>, stdio: ('ignore' | 'pipe')[]) =>
    spawn(bin, argv, { stdio, env, shell: false, windowsHide: true });

  // ---------- child bookkeeping: every helper process is known, killed on close / exit, and stale ones on start ----------
  const children = new Map<string, ChildProcess>();
  const recordPids = () => {
    try {
      const pids: Record<string, number> = {};
      for (const [role, c] of children) if (c.pid) pids[role] = c.pid;
      writeFileSync(pidFile, JSON.stringify(pids), { mode: 0o600 });
    } catch {}
  };
  const track = (role: string, c: ChildProcess) => {
    children.set(role, c);
    recordPids();
    c.once('close', () => {
      if (children.get(role) === c) {
        children.delete(role);
        recordPids();
      }
    });
  };
  /** short one-shot commands (version, genkey, printpub): not long-lived, but stopped with everything else too */
  const oneShots = new Set<ChildProcess>();
  const killAll = () => {
    for (const c of children.values()) c.kill();
    for (const c of oneShots) c.kill();
  };
  let exitHooked = false;
  const hookExit = () => {
    if (exitHooked) return;
    exitHooked = true;
    process.once('exit', killAll);
  };
  /** a previous run that crashed may have left tailcat running with our server key: stop it before starting ours */
  const stopStale = () => {
    if (process.platform === 'win32' || !existsSync(pidFile)) return;
    try {
      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as Record<string, number>;
      for (const pid of Object.values(pids)) {
        if (!Number.isInteger(pid) || pid <= 1) continue;
        let cmd = '';
        try {
          cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
        } catch {
          continue; // not running
        }
        if (cmd.includes(basename(bin)) && (cmd.includes(dir) || cmd.includes('--key=new')))
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
      }
    } catch {}
  };

  /** runs a short tailcat command; resolves its stdout. A missing binary → install help. */
  const runOnce = (argv: string[], ms = timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      let out = '';
      let child: ChildProcess;
      try {
        child = run(argv, childEnv(), ['ignore', 'pipe', 'pipe']);
      } catch {
        return reject(new LinkTransportError('unavailable', TAILCAT_INSTALL_HELP));
      }
      oneShots.add(child);
      hookExit();
      const timer = setTimeout(() => child.kill(), ms);
      child.stdout!.on('data', (c: Buffer) => {
        if (out.length < 65_536) out += c.toString('utf8');
      });
      // stderr is never forwarded or logged (it may name an address)
      child.stderr!.resume();
      child.once('error', () => {
        clearTimeout(timer);
        oneShots.delete(child);
        reject(new LinkTransportError('unavailable', TAILCAT_INSTALL_HELP));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        oneShots.delete(child);
        if (code === 0) resolve(out);
        else
          reject(
            new LinkTransportError(
              'unavailable',
              `tailcat ${argv.find((a) => !a.startsWith('-')) ?? ''} failed`,
            ),
          );
      });
    });

  // ---------- keys (ours, in our state dir) ----------
  let keysReady: Promise<void> | null = null;
  const ensureKeys = () => {
    keysReady ??= (async () => {
      ensureDir();
      if (!existsSync(serverKey)) {
        // genkey prints the key's address (with --fixed-region the same one every serve prints): kept 0600 next to
        // the key, which holds the same secret, so the address is known without running a serve
        const a = (await runOnce(TAILCAT_ARGV.genServerKey(serverKey), Math.max(timeoutMs, 30_000))).trim();
        if (isTailcatAddress(a)) writeFileSync(addrFile, a, { mode: 0o600 });
      }
      if (!existsSync(clientKey)) await runOnce(TAILCAT_ARGV.genClientKey(clientKey));
      for (const f of [serverKey, clientKey]) chmodSync(f, 0o600);
      const pub = (await runOnce(TAILCAT_ARGV.printpub(clientKey))).trim();
      if (!isTailcatNodeKey(pub))
        throw new LinkTransportError('unavailable', 'tailcat printed no client key');
      clientNodeKey = pub;
      if (!address)
        try {
          const a = readFileSync(addrFile, 'utf8').trim();
          if (isTailcatAddress(a)) address = a;
        } catch {}
    })().catch((e) => {
      keysReady = null;
      throw e;
    });
    return keysReady;
  };

  // ---------- the loopback listener every tunnel connection arrives at (through the bridge) ----------
  let onPeerCb: ((s: LinkStream, peer: LinkPeer) => void) | null = null;
  let loop: Server | null = null;
  let loopPort = 0;
  const inbound = new Set<Socket>();
  const inboundKey = new Map<Socket, string>();
  const onLoopback = (sock: Socket) => {
    inbound.add(sock);
    sock.once('close', () => {
      inbound.delete(sock);
      inboundKey.delete(sock);
    });
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), 5000);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > MAX_PREAMBLE) sock.destroy();
        return;
      }
      clearTimeout(timer);
      sock.off('data', onData);
      sock.pause();
      let pre: { tok?: unknown; peer?: unknown } = {};
      try {
        pre = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof pre;
      } catch {}
      const viaLinkWindow = sameToken(pre.tok, windowToken) && windowChild !== null;
      const peerKey = isTailcatNodeKey(pre.peer) ? pre.peer : undefined;
      // the token proves the connection came through one of our own tailcat children; the allow-list is enforced
      // here too, so a key removed a moment ago is refused even while tailcat restarts
      if (!viaLinkWindow && (!sameToken(pre.tok, mainToken) || !peerKey || !allowed.includes(peerKey)))
        return sock.destroy();
      // remembered so `setAllowed` can cut an open connection of a machine that was just unlinked
      if (!viaLinkWindow && peerKey) inboundKey.set(sock, peerKey);
      const rest = buf.subarray(nl + 1);
      if (rest.length) sock.unshift(rest);
      provePeer(sock, o.keys, { timeoutMs }).then(
        ({ stream, peer }) => {
          if (!onPeerCb) return stream.destroy();
          onPeerCb(stream, { publicKey: peer.publicKey, transportKey: peerKey, viaLinkWindow });
        },
        () => sock.destroy(),
      );
      sock.resume(); // explicitly paused above: a new 'data' listener alone would not start the flow again
    };
    sock.on('data', onData);
  };

  // ---------- serve children ----------
  /** starts a `serve` child and resolves the address it writes to TAILCAT_ADDR_FILE (the address never touches a log) */
  const startServe = (role: 'serve' | 'window', argv: string[], token: string) =>
    new Promise<{ child: ChildProcess; address: string }>((resolve, reject) => {
      const addrFile = join(dir, `${role}.addr`);
      rmSync(addrFile, { force: true });
      let child: ChildProcess;
      try {
        child = run(
          argv,
          childEnv({
            TAILCAT_ADDR_FILE: addrFile,
            PASABOT_TC_PORT: String(loopPort),
            PASABOT_TC_TOKEN: token,
          }),
          ['ignore', 'ignore', 'pipe'],
        );
      } catch {
        return reject(new LinkTransportError('unavailable', TAILCAT_INSTALL_HELP));
      }
      track(role, child);
      child.stderr!.resume();
      let done = false;
      const finish = (err: LinkTransportError | null, addr = '') => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        rmSync(addrFile, { force: true });
        if (err) {
          child.kill();
          reject(err);
        } else resolve({ child, address: addr });
      };
      const poll = setInterval(() => {
        let a = '';
        try {
          a = readFileSync(addrFile, 'utf8').trim();
        } catch {
          return;
        }
        if (isTailcatAddress(a)) finish(null, a);
        else if (a)
          finish(new LinkTransportError('unavailable', 'tailcat printed an address PasaBot cannot read'));
      }, 50);
      const timer = setTimeout(
        () => finish(new LinkTransportError('unavailable', 'tailcat did not start listening')),
        timeoutMs,
      );
      child.once('error', () => finish(new LinkTransportError('unavailable', TAILCAT_INSTALL_HELP)));
      child.once('close', () =>
        finish(new LinkTransportError('unavailable', 'tailcat exited while starting')),
      );
    });

  let listening = false;
  let serveChild: ChildProcess | null = null;
  let serveUpSince = 0;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  /** starts and stops of the main serve run one at a time: two serves with one key would fight over the relay */
  let mainOp: Promise<void> = Promise.resolve();
  const queueMain = (fn: () => Promise<void>) => {
    const op = mainOp.then(fn, fn);
    mainOp = op.catch(() => {});
    return op;
  };
  const stopMain = async () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const c = serveChild;
    serveChild = null;
    if (c) await stopChild(c);
  };
  /**
   * (Re)starts the main serve with the current allow-list, or stops it when nobody is linked: with an empty list it
   * would admit nobody, so no tunnel process runs at all (and nothing touches the relays) until a machine is linked.
   */
  const startMain = async () => {
    await stopMain();
    if (!listening || !allowed.length) return;
    await ensureKeys();
    const { child, address: a } = await startServe(
      'serve',
      TAILCAT_ARGV.serve(serverKey, allowed, helper),
      mainToken,
    );
    if (!listening || !allowed.length) {
      child.kill();
      return;
    }
    if (address && a !== address)
      o.log?.warn(
        'tailcat started with a different address than before; linked machines may need to link again',
      );
    address = a;
    serveChild = child;
    serveUpSince = Date.now();
    child.once('close', () => {
      if (serveChild !== child || !listening) return;
      // died on its own: start again with backoff (a restart for an allow-list change never gets here)
      serveChild = null;
      restarts++;
      if (Date.now() - serveUpSince > 60_000) failures = 0;
      const wait = Math.min(30_000, 500 * 2 ** failures++);
      o.log?.warn('tailcat stopped; starting it again', { inMs: wait });
      const again = () => {
        restartTimer = null;
        if (!listening || serveChild || !allowed.length) return;
        restartMain().catch(() => {
          const next = Math.min(30_000, 500 * 2 ** failures++);
          restartTimer = setTimeout(again, next);
        });
      };
      restartTimer = setTimeout(again, wait);
    });
  };
  const restartMain = () => queueMain(startMain);
  const stopChild = (c: ChildProcess) =>
    new Promise<void>((res) => {
      if (c.exitCode !== null || c.signalCode !== null) return res();
      const t = setTimeout(() => c.kill('SIGKILL'), 3000);
      c.once('close', () => {
        clearTimeout(t);
        res();
      });
      c.kill();
    });

  // ---------- the linking window ----------
  let windowChild: ChildProcess | null = null;
  let windowAddress = '';
  let windowUntil = 0;
  let windowTimer: NodeJS.Timeout | null = null;
  const closeWindow = async () => {
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = null;
    const c = windowChild;
    windowChild = null;
    windowAddress = '';
    windowUntil = 0;
    if (c) await stopChild(c);
  };
  const armWindowTimer = () => {
    if (windowTimer) clearTimeout(windowTimer);
    windowTimer = setTimeout(() => void closeWindow(), Math.max(0, windowUntil - Date.now()));
    windowTimer.unref?.();
  };

  // ---------- the dialer: one SOCKS5 child ----------
  let socksChild: ChildProcess | null = null;
  let socksPort: Promise<number> | null = null;
  const outbound = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | null = null;
  /** stops the dialer child; true if one was running */
  const stopSocks = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const c = socksChild;
    socksChild = null;
    socksPort = null;
    if (c) await stopChild(c);
    return !!c;
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (outbound.size || !socksChild) return;
    idleTimer = setTimeout(() => void stopSocks(), idleMs);
    idleTimer.unref?.();
  };
  const ensureSocks = () => {
    socksPort ??= new Promise<number>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = run(TAILCAT_ARGV.socks(clientKey), childEnv(), ['ignore', 'pipe', 'pipe']);
      } catch {
        return reject(new LinkTransportError('unavailable', TAILCAT_INSTALL_HELP));
      }
      track('socks', child);
      socksChild = child;
      hookExit();
      let buf = '';
      let done = false;
      const finish = (err: LinkTransportError | null, port = 0) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          child.kill();
          reject(err);
        } else resolve(port);
      };
      const onOut = (c: Buffer) => {
        if (done || buf.length > 8192) return;
        buf += c.toString('utf8');
        const m = /socks5h?:\/\/127\.0\.0\.1:(\d{1,5})\b/.exec(buf);
        if (m) finish(null, Number(m[1]));
      };
      child.stdout!.on('data', onOut);
      child.stderr!.on('data', onOut);
      const timer = setTimeout(
        () => finish(new LinkTransportError('unavailable', 'tailcat did not start its dialer')),
        timeoutMs,
      );
      child.once('error', () => finish(new LinkTransportError('unavailable', TAILCAT_INSTALL_HELP)));
      child.once('close', () => {
        finish(new LinkTransportError('unavailable', 'tailcat dialer exited'));
        if (socksChild === child) {
          socksChild = null;
          socksPort = null; // the next dial starts a new one
        }
      });
    });
    const p = socksPort;
    p.catch(() => {
      if (socksPort === p) socksPort = null;
    });
    return p;
  };
  /** SOCKS5 CONNECT to `<address>:<port>` (domain name form; no auth). Any failure = unreachable or not admitted. */
  const socksConnect = (port: number, host: string, ms: number) =>
    new Promise<Socket>((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1');
      let buf = Buffer.alloc(0);
      let stage = 0;
      const fail = () => {
        clearTimeout(timer);
        s.destroy();
        reject(new LinkTransportError('unreachable', UNREACHABLE));
      };
      const timer = setTimeout(fail, ms);
      s.on('error', fail);
      s.once('close', fail);
      s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
      const onData = (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (stage === 0) {
          if (buf.length < 2) return;
          if (buf[0] !== 5 || buf[1] !== 0) return fail();
          buf = buf.subarray(2);
          stage = 1;
          const h = Buffer.from(host, 'ascii');
          const p = Buffer.alloc(2);
          p.writeUInt16BE(TAILCAT_LINK_PORT);
          s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p]));
        }
        if (buf.length < 5) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail();
        const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : buf[3] === 3 ? 7 + buf[4]! : -1;
        if (need < 0) return fail();
        if (buf.length < need) return;
        clearTimeout(timer);
        s.off('data', onData);
        s.off('error', fail);
        s.off('close', fail);
        s.on('error', () => {}); // surfaces as 'close' to the stream's user
        s.pause();
        const rest = buf.subarray(need);
        if (rest.length) s.unshift(rest);
        resolve(s);
      };
      s.on('data', onData);
    });

  const versionCheck = (out: string) => {
    version = (out.trim().split(/\s+/).at(-1) ?? '').slice(0, 32);
    if (!TESTED_LINE.test(version) && !warned) {
      warned = true;
      o.log?.warn('tailcat version differs from the one PasaBot was tested with', {
        version,
        tested: TAILCAT_TESTED_VERSION,
      });
    }
  };

  return {
    id: 'tailcat',
    async identity() {
      await ensureKeys().catch(() => {});
      // keys made before the address was kept: learn it once from a short serve that admits nobody
      if (!address && listening && !serveChild)
        await queueMain(async () => {
          if (address || serveChild) return;
          const { child, address: a } = await startServe(
            'serve',
            TAILCAT_ARGV.serve(serverKey, [], helper),
            mainToken,
          );
          await stopChild(child);
          address = a;
          writeFileSync(addrFile, a, { mode: 0o600 });
        }).catch(() => {});
      return {
        publicKey: o.keys.publicKey,
        address,
        ...(clientNodeKey ? { transportKey: clientNodeKey } : {}),
      };
    },
    available: () =>
      runOnce(TAILCAT_ARGV.version(), 5000).then(
        (out) => {
          versionCheck(out);
          return { ok: true as const };
        },
        () => ({ ok: false as const, installHelp: TAILCAT_INSTALL_HELP }),
      ),

    async setAllowed(keys) {
      const next = [...new Set(keys.filter(isTailcatNodeKey))].sort();
      if (next.join(',') === allowed.join(',')) return;
      allowed = next;
      // takes effect at once: the loopback check above already refuses a removed key, an open connection of a removed
      // key is cut now, and tailcat restarts with the list (or stops, when nobody is left)
      for (const [s, k] of inboundKey) if (!allowed.includes(k)) s.destroy();
      if (listening) await restartMain();
    },

    async listen(onPeer) {
      ensureDir();
      stopStale();
      await runOnce(TAILCAT_ARGV.version(), 5000).then(versionCheck); // a missing CLI fails here, clearly
      onPeerCb = onPeer;
      loop = createServer(onLoopback);
      await new Promise<void>((res, rej) => {
        loop!.once('error', rej);
        loop!.listen(0, '127.0.0.1', () => res());
      });
      loopPort = (loop.address() as { port: number }).port;
      listening = true;
      hookExit();
      try {
        await restartMain();
      } catch (e) {
        listening = false;
        loop.close();
        loop = null;
        throw e;
      }
      return {
        async close() {
          listening = false;
          onPeerCb = null;
          await Promise.all([queueMain(stopMain), closeWindow()]);
          for (const s of inbound) s.destroy();
          await new Promise<void>((res) => (loop ? loop.close(() => res()) : res()));
          loop = null;
        },
      };
    },

    async openLinkWindow(until) {
      if (!listening) throw new LinkTransportError('unavailable', 'tailcat is not listening');
      windowUntil = Math.max(windowUntil, until);
      if (!windowChild) {
        const { child, address: a } = await startServe(
          'window',
          TAILCAT_ARGV.serveLinkWindow(helper),
          windowToken,
        );
        windowChild = child;
        windowAddress = a;
        child.once('close', () => {
          if (windowChild !== child) return;
          windowChild = null; // a dead window is not restarted: its address is gone; a new code opens a new one
          windowAddress = '';
        });
      }
      armWindowTimer();
      return windowAddress;
    },
    closeLinkWindow: closeWindow,

    async dial(to) {
      if (!isTailcatAddress(to)) throw new LinkTransportError('bad_address', 'not a tailcat address');
      const deadline = Date.now() + timeoutMs;
      await ensureKeys();
      const port = await ensureSocks();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const sock = await socksConnect(port, to, Math.max(1, deadline - Date.now())).catch((e) => {
        armIdle();
        throw e;
      });
      outbound.add(sock);
      sock.once('close', () => {
        outbound.delete(sock);
        armIdle();
      });
      try {
        const proving = provePeer(sock, o.keys, { timeoutMs: Math.max(1000, deadline - Date.now()) });
        sock.resume();
        return await proving;
      } catch (e) {
        sock.destroy();
        if (e instanceof LinkTransportError && e.code === 'closed')
          throw new LinkTransportError('unreachable', UNREACHABLE);
        throw e;
      }
    },

    async status(): Promise<LinkTransportStatus> {
      return {
        serving: !!serveChild,
        restarting: !!restartTimer,
        linked: allowed.length,
        restarts,
        linkWindow: !!windowChild,
        ...(version ? { version } : {}),
      };
    },

    // no `probe`: `tailcat ping` only takes the address on its command line, where other local users can read it

    async close() {
      listening = false;
      onPeerCb = null;
      await Promise.all([queueMain(stopMain), closeWindow(), stopSocks()]);
      for (const s of [...inbound, ...outbound]) s.destroy();
      await new Promise<void>((res) => (loop ? loop.close(() => res()) : res()));
      loop = null;
      killAll();
      if (exitHooked) process.off('exit', killAll);
      exitHooked = false;
    },
  };
}
