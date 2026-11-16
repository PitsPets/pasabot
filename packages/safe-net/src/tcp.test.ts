/**
 * W35 iface: the TCP connect helper. A TLS echo server on 127.0.0.1 port 0 with a throwaway self-signed certificate
 * (made with the openssl CLI in a temp dir, trusted only through `ca` here). No network.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeConnect, TcpRefused } from './index.js';

let dir: string;
let key: string;
let cert: string;
let implicit: Server;
let starttls: Server;
let implicitPort = 0;
let starttlsPort = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'safenet-tcp-'));
  // a minimal config of its own, so no system openssl.cnf is needed
  writeFileSync(join(dir, 'req.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
  execFileSync(
    'openssl',
    [
      'req',
      '-config',
      join(dir, 'req.cnf'),
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      join(dir, 'k.pem'),
      '-out',
      join(dir, 'c.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=mail.test',
      '-addext',
      'subjectAltName=DNS:mail.test,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(dir, 'k.pem'), 'utf8');
  cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  implicit = createTlsServer({ key, cert }, (s) => s.end('hello\n'));
  await new Promise<void>((r) => implicit.listen(0, '127.0.0.1', r));
  implicitPort = (implicit.address() as { port: number }).port;
  // plain until the client says STARTTLS, then TLS on the same socket
  starttls = createNetServer((s) => {
    s.write('ready\n');
    s.once('data', () => {
      s.write('go\n');
      const t = new TLSSocket(s, { isServer: true, key, cert });
      t.on('error', () => {});
      t.write('secret ok\n');
    });
  });
  await new Promise<void>((r) => starttls.listen(0, '127.0.0.1', r));
  starttlsPort = (starttls.address() as { port: number }).port;
});
afterAll(() => {
  implicit.close();
  starttls.close();
  rmSync(dir, { recursive: true, force: true });
});

const firstLine = (s: NodeJS.ReadableStream) =>
  new Promise<string>((r) => s.once('data', (d: Buffer) => r(d.toString().trim())));

describe('safeConnect (W35)', () => {
  it('implicit TLS to an owner-entered host allowed to be private', async () => {
    const c = await safeConnect({
      host: '127.0.0.1',
      port: implicitPort,
      tls: 'implicit',
      onlyHosts: ['127.0.0.1'],
      privateHosts: ['127.0.0.1'],
      ca: cert,
    });
    expect(c.secure).toBe(true);
    expect(() => c.requireTls()).not.toThrow();
    expect(await firstLine(c.socket)).toBe('hello');
    c.close();
  });

  it('a host that is not one of the owner-entered hosts is refused before any lookup', async () => {
    let looked = false;
    const err = await safeConnect({
      host: 'evil.test',
      port: 993,
      tls: 'implicit',
      onlyHosts: ['mail.test'],
      resolver: async () => {
        looked = true;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TcpRefused);
    expect(err.code).toBe('host_not_allowed');
    expect(looked).toBe(false);
  });

  it('an owner-entered host resolving to a blocked address is refused unless the operator allows it', async () => {
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '::1']) {
      const err = await safeConnect({
        host: 'mail.test',
        port: 993,
        tls: 'implicit',
        onlyHosts: ['mail.test'],
        resolver: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      }).catch((e) => e);
      expect(err.code, address).toBe('blocked_address');
    }
    // a mixed public/private answer is refused too
    const mixed = await safeConnect({
      host: 'mail.test',
      port: 993,
      tls: 'implicit',
      onlyHosts: ['mail.test'],
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    }).catch((e) => e);
    expect(mixed.code).toBe('blocked_address');
  });

  it('connects to the address it checked (pinned) and checks the certificate against the entered name', async () => {
    let lookups = 0;
    const c = await safeConnect({
      host: 'mail.test',
      port: implicitPort,
      tls: 'implicit',
      onlyHosts: ['mail.test'],
      privateHosts: ['mail.test'],
      ca: cert,
      resolver: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    expect(c.address).toBe('127.0.0.1');
    expect(lookups).toBe(1);
    c.close();
    // a certificate that does not name the host fails
    const wrong = await safeConnect({
      host: 'other.test',
      port: implicitPort,
      tls: 'implicit',
      onlyHosts: ['other.test'],
      privateHosts: ['other.test'],
      ca: cert,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    }).catch((e) => e);
    expect(wrong.code).toBe('tls_failed');
    // an untrusted (self-signed, no ca) certificate fails
    const untrusted = await safeConnect({
      host: '127.0.0.1',
      port: implicitPort,
      tls: 'implicit',
      onlyHosts: ['127.0.0.1'],
      privateHosts: ['127.0.0.1'],
    }).catch((e) => e);
    expect(untrusted.code).toBe('tls_failed');
  });

  it('STARTTLS: plain until upgraded, credentials refused while plain', async () => {
    const c = await safeConnect({
      host: '127.0.0.1',
      port: starttlsPort,
      tls: 'starttls',
      onlyHosts: ['127.0.0.1'],
      privateHosts: ['127.0.0.1'],
      ca: cert,
    });
    expect(c.secure).toBe(false);
    expect(await firstLine(c.socket)).toBe('ready');
    expect(() => c.requireTls()).toThrow(TcpRefused);
    const got = firstLine(c.socket);
    c.socket.write('STARTTLS\n');
    expect(await got).toBe('go');
    const t = await c.startTls();
    expect(c.secure).toBe(true);
    expect(() => c.requireTls()).not.toThrow();
    expect(await firstLine(t)).toBe('secret ok');
    c.close();
  });

  it('bad hosts and ports are refused', async () => {
    for (const [host, port] of [
      ['mail.test\r\nRCPT', 993],
      ['', 993],
      ['mail.test', 0],
      ['mail.test', 70000],
    ] as const) {
      const err = await safeConnect({ host, port, tls: 'implicit', onlyHosts: [host] }).catch((e) => e);
      expect(err).toBeInstanceOf(TcpRefused);
    }
  });
});
