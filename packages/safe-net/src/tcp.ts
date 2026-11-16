/**
 * Outbound TCP with the same guard as safeFetch (W35, ARCHITECTURE 13 "Inbox credentials and network"): for mail
 * protocols (IMAP, SMTP) that are not HTTP.
 *
 * `safeConnect` only reaches a host named in `onlyHosts` (the owner-entered hosts of one mailbox; anything else is
 * refused before any lookup), resolves it itself, refuses a blocked address (loopback, private, link-local, metadata,
 * ...) unless the host is also in `privateHosts`, connects to the exact address it checked (no second lookup, so DNS
 * cannot rebind it), and always ends on TLS with certificate and host name checks: `implicit` starts TLS at once,
 * `starttls` hands back a plain socket that must be upgraded with `startTls()` before anything secret is sent.
 * `requireTls()` throws while the connection is still plain, so a client calls it before it authenticates: plaintext
 * authentication is never possible.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, Socket } from 'node:net';
import { checkServerIdentity, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { isBlockedAddress, type Resolver } from './blocked.js';

export type TlsMode = 'implicit' | 'starttls';

export class TcpRefused extends Error {
  constructor(
    readonly code:
      | 'host_not_allowed'
      | 'blocked_address'
      | 'bad_host'
      | 'bad_port'
      | 'plaintext'
      | 'timeout'
      | 'tls_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface SafeConnectOptions {
  host: string;
  port: number;
  tls: TlsMode;
  /** the only host names this connection may reach (exact, case-insensitive); empty or missing = refuse */
  onlyHosts: string[];
  /** host names that may resolve to private/loopback addresses (operator config, never an agent) */
  privateHosts?: string[];
  /** extra trusted CA certificates (tests trust their own self-signed server this way); system CAs otherwise */
  ca?: string | string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** injectable for tests */
  resolver?: Resolver;
}

export interface SafeTcpConnection {
  readonly host: string;
  /** the address that was checked and connected to */
  readonly address: string;
  /** the current socket: plain until `startTls()` for `starttls`, TLS from the start for `implicit` */
  socket: Socket | TLSSocket;
  readonly secure: boolean;
  /** upgrade a `starttls` connection (after the protocol's STARTTLS exchange); verifies the certificate */
  startTls(): Promise<TLSSocket>;
  /** throws unless the connection is on verified TLS; call before sending any credential */
  requireTls(): void;
  close(): void;
}

const norm = (h: string) =>
  h
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
const defaultResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })) as { address: string; family: 4 | 6 }[];

/** Resolve and vet a mail host: in the list, a sane name, and (unless private is allowed) a public address. */
export async function vetTcpHost(
  o: Pick<SafeConnectOptions, 'host' | 'port' | 'onlyHosts' | 'privateHosts' | 'resolver'>,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = norm(o.host);
  if (!host || host.length > 253) throw new TcpRefused('bad_host', 'no host');
  for (const ch of host) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '-' || ch === ':';
    if (!ok) throw new TcpRefused('bad_host', 'host has characters a host name cannot have');
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new TcpRefused('bad_port', 'bad port');
  if (!(o.onlyHosts ?? []).map(norm).includes(host))
    throw new TcpRefused('host_not_allowed', `${host} is not one of the hosts the owner entered`);
  const literal = isIP(host);
  const addrs = literal
    ? [{ address: host, family: literal as 4 | 6 }]
    : await (o.resolver ?? defaultResolver)(host).catch(() => []);
  if (addrs.length === 0) throw new TcpRefused('bad_host', `no address for ${host}`);
  const privateOk = (o.privateHosts ?? []).map(norm).includes(host);
  if (!privateOk)
    for (const a of addrs)
      if (isBlockedAddress(a.address))
        throw new TcpRefused('blocked_address', `${host} resolves to a blocked address (${a.address})`);
  return addrs[0]!;
}

function upgrade(
  plain: Socket | null,
  o: { ip: string; port: number; host: string; ca?: string | string[]; timeoutMs: number },
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const sni = isIP(o.host) ? undefined : o.host;
    const s = tlsConnect({
      ...(plain ? { socket: plain } : { host: o.ip, port: o.port }),
      servername: sni,
      // the identity is checked against the name the owner entered, never the pinned address
      checkServerIdentity: (_h, cert) => checkServerIdentity(o.host, cert),
      ...(o.ca ? { ca: o.ca } : {}),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    const timer = setTimeout(
      () => s.destroy(new TcpRefused('timeout', 'TLS handshake timed out')),
      o.timeoutMs,
    );
    s.once('secureConnect', () => {
      clearTimeout(timer);
      if (!s.authorized) {
        s.destroy();
        reject(new TcpRefused('tls_failed', String(s.authorizationError ?? 'certificate not trusted')));
        return;
      }
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof TcpRefused ? e : new TcpRefused('tls_failed', (e as Error).message));
    });
  });
}

/** Connect to an owner-entered mail host through the guard. */
export async function safeConnect(o: SafeConnectOptions): Promise<SafeTcpConnection> {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const host = norm(o.host);
  const { address, family } = await vetTcpHost(o);
  const opts = { ip: address, port: o.port, host, ca: o.ca, timeoutMs };
  let socket: Socket | TLSSocket;
  let secure = false;
  if (o.tls === 'implicit') {
    socket = await upgrade(null, opts);
    secure = true;
  } else {
    socket = await new Promise<Socket>((resolve, reject) => {
      const s = new Socket();
      const timer = setTimeout(() => s.destroy(new TcpRefused('timeout', 'connect timed out')), timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      s.connect({ host: address, port: o.port, family });
    });
  }
  o.signal?.addEventListener('abort', () => conn.close(), { once: true });
  const conn: SafeTcpConnection = {
    host,
    address,
    get socket() {
      return socket;
    },
    set socket(v) {
      socket = v;
    },
    get secure() {
      return secure;
    },
    async startTls() {
      if (secure) return socket as TLSSocket;
      socket = await upgrade(socket as Socket, opts);
      secure = true;
      return socket as TLSSocket;
    },
    requireTls() {
      if (!secure) throw new TcpRefused('plaintext', 'refusing to authenticate without TLS');
    },
    close() {
      socket.destroy();
    },
  };
  return conn;
}
