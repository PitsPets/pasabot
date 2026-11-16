/**
 * Fallback transport: direct TCP + TLS 1.3 over a LAN or tailnet address. Both sides present a self-signed
 * certificate of their long-term Ed25519 key (no CA); each reports the other's certificate key, which the caller
 * compares with the key it pinned.
 */
import { createServer, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { selfSignedCert } from './cert.js';
import { type LinkKeys, rawPublicKey } from './keys.js';
import { type LinkTransport, LinkTransportError } from './types.js';

export interface TcpTlsOptions {
  keys: LinkKeys;
  /** bind address; default 127.0.0.1 */
  host?: string;
  /** default 0 (any free port) */
  port?: number;
  /** host peers dial (a LAN or tailnet name/IP); default = `host` */
  advertiseHost?: string;
  connectTimeoutMs?: number;
}

const peerKeyOf = (s: TLSSocket): string | null => {
  const cert = s.getPeerX509Certificate();
  return cert ? rawPublicKey(cert.publicKey) : null;
};
const hostPart = (h: string) => (h.includes(':') ? `[${h}]` : h);

export function createTcpTlsTransport(o: TcpTlsOptions): LinkTransport {
  const { key, cert } = selfSignedCert(o.keys);
  const host = o.host ?? '127.0.0.1';
  let address = '';
  const tlsOpts = { key, cert, minVersion: 'TLSv1.3' as const };
  return {
    id: 'tcp-tls',
    async identity() {
      return { publicKey: o.keys.publicKey, address };
    },
    async available() {
      return { ok: true };
    },
    async listen(onPeer) {
      const open = new Set<TLSSocket>();
      const server = createServer({ ...tlsOpts, requestCert: true, rejectUnauthorized: false }, (s) => {
        const pub = peerKeyOf(s);
        if (!pub) {
          s.destroy();
          return;
        }
        open.add(s);
        s.once('close', () => open.delete(s));
        onPeer(s, { publicKey: pub });
      });
      server.on('tlsClientError', () => {}); // a bad handshake is the peer's problem, never a crash
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(o.port ?? 0, host, () => res());
      });
      const port = (server.address() as { port: number }).port;
      address = `tcp-tls://${hostPart(o.advertiseHost ?? host)}:${port}`;
      return {
        close: () =>
          new Promise<void>((res) => {
            for (const s of open) s.destroy();
            server.close(() => res());
          }),
      };
    },
    async dial(to) {
      let url: URL;
      try {
        url = new URL(to);
      } catch {
        throw new LinkTransportError('bad_address', 'not a tcp-tls link address');
      }
      if (url.protocol !== 'tcp-tls:' || !url.port)
        throw new LinkTransportError('bad_address', 'not a tcp-tls link address');
      const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      return new Promise((resolve, reject) => {
        const s = tlsConnect({
          ...tlsOpts,
          host: hostname,
          port: Number(url.port),
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
        });
        const timer = setTimeout(() => {
          s.destroy();
          reject(new LinkTransportError('unreachable', 'link peer unreachable'));
        }, o.connectTimeoutMs ?? 10_000);
        s.once('error', () => {
          clearTimeout(timer);
          reject(new LinkTransportError('unreachable', 'link peer unreachable'));
        });
        s.once('secureConnect', () => {
          clearTimeout(timer);
          const pub = peerKeyOf(s);
          if (!pub) {
            s.destroy();
            return reject(new LinkTransportError('peer_key', 'the peer presented no Ed25519 key'));
          }
          s.removeAllListeners('error');
          s.on('error', () => {}); // surfaces as 'close' to the stream's user
          resolve({ stream: s, peer: { publicKey: pub } });
        });
      });
    },
  };
}
