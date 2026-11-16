import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSafeNet,
  isBlockedAddress,
  type Resolver,
  SsrfError,
  safeFetch,
  signWebhook,
  verifyWebhook,
} from './index.js';

describe('test:ssrf address table', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1', // ULA
    'fe80::1', // link-local
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // IPv4-mapped loopback, hex form
    '::ffff:a9fe:a9fe', // mapped metadata
    '64:ff9b::a9fe:a9fe', // NAT64 of metadata
    'not-an-ip',
  ];
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '172.32.0.1',
    '100.128.0.1',
  ];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
});

describe('test:ssrf safeFetch', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      } else if (req.url === '/redirect-v6') {
        res.writeHead(302, { location: 'http://[::1]:1/' }).end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
      } else if (req.url === '/to-other') {
        res.writeHead(302, { location: `http://other.test:${port}/echo-auth` }).end();
      } else if (req.url === '/to-same') {
        res.writeHead(302, { location: '/echo-auth' }).end();
      } else if (req.url === '/echo-auth') {
        res.end(
          `auth=${req.headers.authorization ?? ''};cookie=${req.headers.cookie ?? ''};x=${req.headers['x-k'] ?? ''}`,
        );
      } else if (req.url === '/big') {
        res.end(Buffer.alloc(2048));
      } else if (req.url === '/huge') {
        res.end(Buffer.alloc(11 * 1024 * 1024));
      } else res.end(`ok ${req.headers.host}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof SsrfError ? e.code : `other:${String(e)}`;
    }
  };

  it('refuses a loopback literal without an allowlist entry', async () => {
    expect(await code(safeFetch(`http://127.0.0.1:${port}/`))).toBe('blocked_address');
  });
  it('refuses an IPv6 loopback literal', async () => {
    expect(await code(safeFetch(`http://[::1]:${port}/`))).toBe('blocked_address');
  });
  it('refuses a name that resolves to a private address', async () => {
    const resolver: Resolver = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await code(safeFetch('http://intranet.example/', { resolver }))).toBe('blocked_address');
  });
  it('refuses a mixed public/private answer (rebinding setup)', async () => {
    const resolver: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    expect(await code(safeFetch('http://rebind.example/', { resolver }))).toBe('blocked_address');
  });
  it('pins the vetted IP: a rebinding resolver cannot swap the address after the check', async () => {
    // first answer is the allowlisted local server; a second lookup would return metadata, but none happens
    let calls = 0;
    const resolver: Resolver = async () => {
      calls++;
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };
    const r = await safeFetch(`http://pinned.test:${port}/`, { resolver, allowHosts: ['pinned.test'] });
    expect(await r.text()).toBe(`ok pinned.test:${port}`);
    expect(calls).toBe(1);
  });
  it('allows an allowlisted host and returns a Response', async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { allowHosts: ['127.0.0.1'] });
    expect(r.status).toBe(200);
  });
  it('re-checks redirects: allowlisted host redirecting to metadata is refused', async () => {
    expect(
      await code(safeFetch(`http://127.0.0.1:${port}/redirect-metadata`, { allowHosts: ['127.0.0.1'] })),
    ).toBe('blocked_address');
  });
  it('re-checks redirects to an IPv6 loopback', async () => {
    expect(await code(safeFetch(`http://127.0.0.1:${port}/redirect-v6`, { allowHosts: ['127.0.0.1'] }))).toBe(
      'blocked_address',
    );
  });
  it('drops Authorization/Cookie when a redirect changes origin, keeps them on the same origin', async () => {
    const resolver: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const o = {
      resolver,
      allowHosts: ['a.test', 'other.test'],
      headers: { Authorization: 'Bearer tok', Cookie: 'sid=1', 'X-K': 'v' },
    };
    expect(await (await safeFetch(`http://a.test:${port}/to-other`, o)).text()).toBe('auth=;cookie=;x=v');
    expect(await (await safeFetch(`http://a.test:${port}/to-same`, o)).text()).toBe(
      'auth=Bearer tok;cookie=sid=1;x=v',
    );
  });
  it('caps redirects at 5', async () => {
    expect(await code(safeFetch(`http://127.0.0.1:${port}/loop`, { allowHosts: ['127.0.0.1'] }))).toBe(
      'too_many_redirects',
    );
  });
  it('caps the body size', async () => {
    expect(
      await code(safeFetch(`http://127.0.0.1:${port}/big`, { allowHosts: ['127.0.0.1'], maxBytes: 1024 })),
    ).toBe('too_large');
  });
  it('the SafeNet port passes a per-call body cap through (default 10 MB, raised for a download)', async () => {
    const net = createSafeNet({ allowHosts: ['127.0.0.1'] });
    expect(await code(net.fetch(`http://127.0.0.1:${port}/huge`))).toBe('too_large');
    const r = await net.fetch(`http://127.0.0.1:${port}/huge`, { maxBytes: 20 * 1024 * 1024 });
    expect((await r.arrayBuffer()).byteLength).toBe(11 * 1024 * 1024);
    expect(await code(net.fetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1024 }))).toBe('too_large');
  });
  it('refuses non-http schemes and credentials in URLs', async () => {
    expect(await code(safeFetch('file:///etc/passwd'))).toBe('bad_url');
    expect(await code(safeFetch('http://user:pw@example.com/'))).toBe('bad_url');
  });
});

describe('webhook HMAC', () => {
  it('verifies within the window and rejects tampering or stale timestamps', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook('s3cret', ts, 'd1', '{"a":1}');
    expect(verifyWebhook('s3cret', { ts, deliveryId: 'd1', signature: sig }, '{"a":1}')).toBe(true);
    expect(verifyWebhook('s3cret', { ts, deliveryId: 'd1', signature: sig }, '{"a":2}')).toBe(false);
    expect(verifyWebhook('s3cret', { ts, deliveryId: 'd2', signature: sig }, '{"a":1}')).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const oldSig = signWebhook('s3cret', old, 'd1', 'x');
    expect(verifyWebhook('s3cret', { ts: old, deliveryId: 'd1', signature: oldSig }, 'x')).toBe(false);
  });
});
