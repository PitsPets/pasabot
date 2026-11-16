/**
 * A minimal self-signed X.509 v3 certificate for an Ed25519 key, built by hand in DER (no CA, no extensions): the
 * TCP+TLS transport proves the long-term link key itself, and the peer compares the certificate's key with the key
 * it pinned. Nothing else in the certificate is trusted.
 */
import { createPublicKey, randomBytes, sign } from 'node:crypto';
import type { LinkKeys } from './keys.js';

const len = (n: number) =>
  n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const pad = (n: number) => String(n).padStart(2, '0');
const utcTime = (d: Date) =>
  tlv(
    0x17,
    Buffer.from(
      `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    ),
  );
const ED25519 = seq(Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]));
const NAME = seq(
  tlv(0x31, seq(Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from('pasabot-link')))),
);

export function selfSignedCert(keys: LinkKeys): { key: string; cert: string } {
  const spki = createPublicKey(keys.privateKey).export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])), // positive serial
    ED25519,
    NAME,
    seq(utcTime(new Date(Date.now() - 86_400_000)), utcTime(new Date(Date.UTC(2049, 11, 31, 23, 59, 59)))),
    NAME,
    spki,
  );
  const sig = sign(null, tbs, keys.privateKey);
  const der = seq(tbs, ED25519, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return {
    key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
