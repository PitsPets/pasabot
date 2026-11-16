/**
 * The network guard of a browser profile: a forward proxy on 127.0.0.1 that Chromium sends every request through
 * (pages, subresources, redirects, WebSockets; `chromiumProxy` in server.ts sets `<-loopback>` itself, whatever the
 * environment says, so loopback goes through it too).
 *
 * Each plain-HTTP request and each CONNECT tunnel is vetted by @pasabot/safe-net's `vetUrl` on its own (no cache),
 * and the proxy connects to the exact IP that was vetted, so a redirect hop cannot skip the check and DNS
 * rebinding cannot swap the address after it. Redirects are passed back to Chromium untouched: the browser asks
 * again for the next hop and that request is vetted like the first. The owner's own proxy for the profile, when
 * set, is chained behind this one and is always asked for the vetted IP (CONNECT ip:port or SOCKS5 to the IP).
 * Only Chromium knows the per-start credentials, so no other local process can use this as a way out.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { type Resolver, vetUrl } from '@pasabot/safe-net';

export interface UpstreamProxy {
  /** `http://host:port`, `https://host:port` or `socks5://host:port` */
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}
export interface GuardProxyOptions {
  /** hosts the owner lets reach private addresses (read on every request, so a settings change applies at once) */
  allowHosts: () => string[];
  /** the owner's proxy for this profile, chained behind the guard */
  upstream?: UpstreamProxy | null;
  /** tests: DNS answers (rebinding cases) */
  resolver?: Resolver;
  /** tests: how a vetted IP is reached (map a public test IP onto a local fixture) */
  dial?: (ip: string, port: number) => Socket;
  /** called with every refused address (for the log); the address is the host only */
  onBlocked?: (host: string, why: string) => void;
}
export interface GuardProxy {
  /** what to hand Chromium as its proxy */
  proxy: { server: string; username: string; password: string };
  close(): Promise<void>;
}

const CONNECT_TIMEOUT = 30_000;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const authority = (ip: string, port: number) => (isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`);

/** the owner's bypass list (`a.com, .b.com, *.c.com`): those hosts skip the upstream proxy (never the guard) */
export function bypassed(host: string, bypass: string | undefined): boolean {
  if (!bypass) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of bypass.split(/[,;]/)) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e.startsWith('*.') || e.startsWith('.')) {
      const suffix = e.startsWith('*') ? e.slice(1) : e;
      if (h.endsWith(suffix) || h === suffix.slice(1)) return true;
    } else if (h === e.replace(/^\[|\]$/g, '')) return true;
  }
  return false;
}

function once<T>(fn: (ok: (v: T) => void, fail: (e: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    fn(
      (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      },
      (e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      },
    );
  });
}

/** reads exactly n bytes from a socket that is not flowing yet */
function readBytes(sock: Socket, n: number): Promise<Buffer> {
  return once((ok, fail) => {
    const tryRead = () => {
      const b = sock.read(n) as Buffer | null;
      if (b) {
        cleanup();
        ok(b);
      }
    };
    const onEnd = () => {
      cleanup();
      fail(new Error('upstream proxy closed the connection'));
    };
    const onErr = (e: Error) => {
      cleanup();
      fail(e);
    };
    const cleanup = () => {
      sock.off('readable', tryRead);
      sock.off('end', onEnd);
      sock.off('error', onErr);
    };
    sock.on('readable', tryRead);
    sock.once('end', onEnd);
    sock.once('error', onErr);
    tryRead();
  });
}

async function socks5(up: URL, user: string | undefined, pass: string | undefined, ip: string, port: number) {
  const sock = netConnect({ host: up.hostname.replace(/^\[|\]$/g, ''), port: Number(up.port || 1080) });
  sock.setTimeout(CONNECT_TIMEOUT, () => sock.destroy(new Error('upstream proxy timed out')));
  try {
    await once<void>((ok, fail) => {
      sock.once('connect', () => ok());
      sock.once('error', fail);
    });
    sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
    const [, method] = await readBytes(sock, 2);
    if (method === 2) {
      const u = Buffer.from(user ?? '');
      const p = Buffer.from(pass ?? '');
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await readBytes(sock, 2);
      if (status !== 0) throw new Error('upstream proxy refused the sign-in');
    } else if (method !== 0) throw new Error('upstream proxy wants an unsupported sign-in method');
    const fam = isIP(ip);
    const addr =
      fam === 4
        ? Buffer.from([1, ...ip.split('.').map(Number)])
        : Buffer.concat([Buffer.from([4]), ipv6Bytes(ip)]);
    const portBuf = Buffer.from([port >> 8, port & 255]);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]));
    const head = await readBytes(sock, 4);
    if (head[1] !== 0) throw new Error(`upstream proxy could not connect (code ${head[1]})`);
    const rest = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readBytes(sock, 1))[0]!;
    await readBytes(sock, rest + 2);
    sock.setTimeout(0);
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

function ipv6Bytes(ip: string): Buffer {
  const [head = '', tail = ''] = ip.split('::');
  const parts = (s: string) => (s ? s.split(':') : []);
  const h = parts(head);
  const t = parts(tail);
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const b = Buffer.alloc(16);
  for (const [i, g] of groups.entries()) b.writeUInt16BE(Number.parseInt(g, 16), i * 2);
  return b;
}

/** CONNECT ip:port through an http(s) upstream proxy */
function httpTunnel(up: URL, user: string | undefined, pass: string | undefined, ip: string, port: number) {
  return once<Duplex>((ok, fail) => {
    const target = authority(ip, port);
    const req = (up.protocol === 'https:' ? httpsRequest : httpRequest)({
      host: up.hostname.replace(/^\[|\]$/g, ''),
      port: Number(up.port || (up.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: target,
      headers: {
        host: target,
        ...(user
          ? { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}` }
          : {}),
      },
      timeout: CONNECT_TIMEOUT,
    });
    req.once('connect', (res, sock, head) => {
      if (res.statusCode !== 200) {
        sock.destroy();
        fail(new Error(`upstream proxy answered ${res.statusCode}`));
        return;
      }
      if (head.length) sock.unshift(head);
      ok(sock);
    });
    req.once('timeout', () => req.destroy(new Error('upstream proxy timed out')));
    req.once('error', fail);
    req.end();
  });
}

export async function startGuardProxy(o: GuardProxyOptions): Promise<GuardProxy> {
  const user = 'pasabot';
  const pass = randomBytes(24).toString('base64url');
  const want = Buffer.from(`Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(s: T): T => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    return s;
  };
  const up = o.upstream ? new URL(o.upstream.server) : null;

  const authed = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers['proxy-authorization'] ?? ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const vet = async (url: URL) => {
    try {
      return await vetUrl(url, {
        allowHosts: o.allowHosts(),
        ...(o.resolver ? { resolver: o.resolver } : {}),
      });
    } catch (e) {
      o.onBlocked?.(url.hostname, e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  /** a raw connection to the vetted IP: direct, or through the owner's proxy (asked for the IP, never the name) */
  const open = async (host: string, ip: string, port: number): Promise<Duplex> => {
    if (up && !bypassed(host, o.upstream?.bypass)) {
      const u = o.upstream?.username;
      const p = o.upstream?.password;
      return track(
        up.protocol === 'socks5:' ? await socks5(up, u, p, ip, port) : await httpTunnel(up, u, p, ip, port),
      );
    }
    const sock = track(o.dial ? o.dial(ip, port) : netConnect({ host: ip, port }));
    sock.setTimeout(CONNECT_TIMEOUT, () => sock.destroy(new Error('connect timed out')));
    await once<void>((ok, fail) => {
      if (!sock.connecting) ok();
      sock.once('connect', () => ok());
      sock.once('error', fail);
    });
    sock.setTimeout(0);
    return sock;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!authed(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pasabot"', connection: 'close' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error('not absolute http');
    } catch {
      res.writeHead(400, { connection: 'close' }).end();
      return;
    }
    const v = await vet(url);
    if (!v) {
      res
        .writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        .end('Blocked by the PasaBot network guard.');
      return;
    }
    let conn: Duplex;
    try {
      conn = await open(url.hostname, v.ip, Number(url.port || 80));
    } catch {
      res.writeHead(502, { connection: 'close' }).end();
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, val] of Object.entries(req.headers))
      if (val !== undefined && !HOP_BY_HOP.has(k)) headers[k] = val;
    headers.host = url.host;
    const out = httpRequest({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      // no agent: the request rides the connection to the vetted IP, never a socket Node would open by name
      createConnection: () => conn as Socket,
    });
    out.once('response', (r) => {
      const h: Record<string, string | string[]> = {};
      for (const [k, val] of Object.entries(r.headers))
        if (val !== undefined && !HOP_BY_HOP.has(k)) h[k] = val;
      // redirects are not followed here: Chromium asks for the next hop and that request is vetted again
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    });
    out.once('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close' });
      res.end();
      conn.destroy();
    });
    res.once('close', () => conn.destroy());
    req.pipe(out);
  });
  server.on('connection', (s) => track(s));
  server.on('connect', async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    if (!authed(req)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="pasabot"\r\n\r\n',
      );
      return;
    }
    let url: URL;
    try {
      url = new URL(`https://${req.url ?? ''}`);
      if (!url.port && !/:443$/.test(req.url ?? '')) throw new Error('no port');
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const v = await vet(url);
    if (!v) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    let conn: Duplex;
    try {
      conn = await open(url.hostname, v.ip, Number(url.port || 443));
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    if (client.destroyed) {
      conn.destroy();
      return;
    }
    conn.on('error', () => client.destroy());
    client.on('close', () => conn.destroy());
    conn.on('close', () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) conn.write(head);
    conn.pipe(client);
    client.pipe(conn);
  });
  // a WebSocket without CONNECT is not something Chromium sends through a proxy: refuse it
  server.on('upgrade', (_req, s: Duplex) => s.destroy());
  server.on('clientError', (_e, s) => s.destroy());

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    proxy: { server: `http://127.0.0.1:${port}`, username: user, password: pass },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
