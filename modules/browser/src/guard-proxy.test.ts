/**
 * The browser's network guard without a browser: each request and each CONNECT is vetted on its own (a redirect
 * hop to loopback is refused, a rebound name is refused on the next request), the connection goes to the vetted
 * IP only, the owner's proxy is asked for that IP, and only the holder of the per-start credentials may use it.
 * Fixtures are local servers on 127.0.0.1 port 0; a public test IP is mapped onto them by the `dial` hook.
 */

import { createServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bypassed, type GuardProxy, startGuardProxy } from './guard-proxy.js';

const PUBLIC_IP = '93.184.216.34';
const listen = async <T extends Server | TcpServer>(srv: T) => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return (srv.address() as { port: number }).port;
};
const close = (srv: Server | TcpServer) =>
  new Promise<void>((r) => {
    (srv as Server).closeAllConnections?.();
    srv.close(() => r());
  });

/** one raw HTTP/1.1 exchange with the proxy; resolves with the status line and body */
function rawProxy(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => {
      out += d.toString();
    });
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
    s.write(text);
  });
}

describe('browser guard proxy (W15)', () => {
  let site: Server; // the "public" site: answers, or redirects to loopback
  let secret: Server; // a loopback service the guard must keep the browser off
  let echo: TcpServer; // a raw TCP service for CONNECT tunnels
  let sitePort: number;
  let secretPort: number;
  let echoPort: number;
  let secretHits = 0;
  const dialed: string[] = [];
  let rebound = false;
  let g: GuardProxy;
  let auth: string;

  beforeAll(async () => {
    site = createServer((q, r) => {
      if (q.url === '/r')
        r.writeHead(302, { location: `http://127.0.0.1:${secretPort}/latest/meta-data/` }).end();
      else r.writeHead(200, { 'content-type': 'text/plain' }).end(`public page, host ${q.headers.host}`);
    });
    secret = createServer((_q, r) => {
      secretHits++;
      r.end('iam-credentials');
    });
    echo = createTcpServer((s) => s.pipe(s));
    sitePort = await listen(site);
    secretPort = await listen(secret);
    echoPort = await listen(echo);
    g = await startGuardProxy({
      allowHosts: () => [],
      resolver: async (host) => {
        if (host === 'public.test') return [{ address: PUBLIC_IP, family: 4 }];
        if (host === 'rebind.test') return [{ address: rebound ? '127.0.0.1' : PUBLIC_IP, family: 4 }];
        throw new Error(`no fixture DNS for ${host}`);
      },
      dial: (ip, port) => {
        dialed.push(`${ip}:${port}`);
        // the public test IP lands on the local fixtures; any other address would be a pinning failure
        if (ip !== PUBLIC_IP) throw new Error(`dialled an unvetted address ${ip}`);
        return connect(port === 443 ? echoPort : sitePort, '127.0.0.1') as Socket;
      },
    });
    auth = `Proxy-Authorization: Basic ${Buffer.from(`${g.proxy.username}:${g.proxy.password}`).toString('base64')}\r\n`;
  });
  afterAll(async () => {
    await g.close();
    await Promise.all([close(site), close(secret), close(echo)]);
  });

  it('only the holder of the per-start credentials may use it', async () => {
    const r = await rawProxy(
      Number(new URL(g.proxy.server).port),
      'GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n',
    );
    expect(r).toMatch(/^HTTP\/1.1 407/);
    expect(dialed).toEqual([]);
  });

  it('passes a redirect back untouched and refuses the loopback hop on its own', async () => {
    const port = Number(new URL(g.proxy.server).port);
    const first = await rawProxy(
      port,
      `GET http://public.test/r HTTP/1.1\r\nHost: public.test\r\n${auth}Connection: close\r\n\r\n`,
    );
    expect(first).toMatch(/^HTTP\/1.1 302/);
    expect(first).toContain(`127.0.0.1:${secretPort}`);
    // the browser's next request: the hop is vetted like the first
    const hop = await rawProxy(
      port,
      `GET http://127.0.0.1:${secretPort}/latest/meta-data/ HTTP/1.1\r\nHost: 127.0.0.1:${secretPort}\r\n${auth}Connection: close\r\n\r\n`,
    );
    expect(hop).toMatch(/^HTTP\/1.1 403/);
    expect(hop).not.toContain('iam-credentials');
    expect(secretHits).toBe(0);
  });

  it('connects to the vetted IP and vets again on every request (DNS rebinding)', async () => {
    const port = Number(new URL(g.proxy.server).port);
    dialed.length = 0;
    rebound = false;
    const ok = await rawProxy(
      port,
      `GET http://rebind.test/ HTTP/1.1\r\nHost: rebind.test\r\n${auth}Connection: close\r\n\r\n`,
    );
    expect(ok).toMatch(/^HTTP\/1.1 200/);
    expect(ok).toContain('host rebind.test'); // the name still goes in Host, the socket goes to the IP
    expect(dialed).toEqual([`${PUBLIC_IP}:80`]);
    rebound = true; // the name now answers 127.0.0.1: no cached "allowed" may let the next request through
    const again = await rawProxy(
      port,
      `GET http://rebind.test/data HTTP/1.1\r\nHost: rebind.test\r\n${auth}Connection: close\r\n\r\n`,
    );
    expect(again).toMatch(/^HTTP\/1.1 403/);
    const tunnel = await rawProxy(
      port,
      `CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n${auth}\r\n`,
    );
    expect(tunnel).toMatch(/^HTTP\/1.1 403/);
    expect(dialed).toEqual([`${PUBLIC_IP}:80`]);
    expect(secretHits).toBe(0);
  });

  it('CONNECT (https, wss) is vetted and tunnels to the vetted IP', async () => {
    const port = Number(new URL(g.proxy.server).port);
    const blocked = await rawProxy(
      port,
      `CONNECT 127.0.0.1:${secretPort} HTTP/1.1\r\nHost: 127.0.0.1:${secretPort}\r\n${auth}\r\n`,
    );
    expect(blocked).toMatch(/^HTTP\/1.1 403/);
    const meta = await rawProxy(port, `CONNECT 169.254.169.254:443 HTTP/1.1\r\n${auth}\r\n`);
    expect(meta).toMatch(/^HTTP\/1.1 403/);
    const echoed = await new Promise<string>((resolve, reject) => {
      const s = connect(port, '127.0.0.1');
      let out = '';
      s.on('data', (d) => {
        out += d.toString();
        if (out.includes('\r\n\r\n') && !out.includes('ping')) s.write('ping');
        if (out.includes('ping')) s.end();
      });
      s.on('close', () => resolve(out));
      s.on('error', reject);
      s.write(`CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n${auth}\r\n`);
    });
    expect(echoed).toMatch(/^HTTP\/1.1 200/);
    expect(echoed).toContain('ping');
  });

  it("asks the owner's own proxy for the vetted IP, never the name", async () => {
    const asked: string[] = [];
    const upstream = createServer();
    upstream.on('connect', (req, sock: Socket) => {
      asked.push(`${req.url} ${req.headers['proxy-authorization'] ?? ''}`);
      const to = connect(sitePort, '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        to.pipe(sock);
        sock.pipe(to);
      });
      sock.on('error', () => to.destroy());
      to.on('error', () => sock.destroy());
    });
    const upPort = await listen(upstream);
    const chained = await startGuardProxy({
      allowHosts: () => [],
      upstream: { server: `http://127.0.0.1:${upPort}`, username: 'nena', password: 'pw' },
      resolver: async () => [{ address: PUBLIC_IP, family: 4 }],
    });
    try {
      const a = `Proxy-Authorization: Basic ${Buffer.from(`${chained.proxy.username}:${chained.proxy.password}`).toString('base64')}\r\n`;
      const r = await rawProxy(
        Number(new URL(chained.proxy.server).port),
        `GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n${a}Connection: close\r\n\r\n`,
      );
      expect(r).toMatch(/^HTTP\/1.1 200/);
      expect(asked).toEqual([`${PUBLIC_IP}:80 Basic ${Buffer.from('nena:pw').toString('base64')}`]);
    } finally {
      await chained.close();
      await close(upstream);
    }
  });

  it("the owner's bypass list", () => {
    expect(bypassed('intranet.example.com', '.example.com, foo.org')).toBe(true);
    expect(bypassed('example.com', '*.example.com')).toBe(true);
    expect(bypassed('foo.org', '.example.com, foo.org')).toBe(true);
    expect(bypassed('evil-example.com', '.example.com')).toBe(false);
    expect(bypassed('a.com', undefined)).toBe(false);
  });
});

describe('the proxy Chromium is given', () => {
  it('forces loopback through the guard and never passes the owner bypass list to Chromium', async () => {
    const { chromiumProxy } = await import('./server.js');
    const guard = { server: 'http://127.0.0.1:4567', username: 'pasabot', password: 'pw' };
    const prev = process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK;
    // even with the switch that makes Playwright stop adding the rule itself
    process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
    try {
      expect(chromiumProxy(guard)).toEqual({ ...guard, bypass: '<-loopback>' });
      // an owner bypass on the way in is dropped: it belongs to the upstream proxy behind the guard
      expect(chromiumProxy({ ...guard, bypass: 'localhost, .corp.example' } as typeof guard).bypass).toBe(
        '<-loopback>',
      );
    } finally {
      if (prev === undefined) delete process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK;
      else process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = prev;
    }
  });
});
