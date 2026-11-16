/**
 * Web push on node:crypto alone (no push library, so every request goes through the caller's fetch, i.e. safe-net):
 * - RFC 8291 message encryption (`aes128gcm`, one record) for a subscription's `p256dh` + `auth` keys;
 * - RFC 8292 VAPID: an ES256 JWT for the push service's origin plus our public key (`Authorization: vapid t=, k=`).
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign as signData,
} from 'node:crypto';

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

export interface VapidKeys {
  /** uncompressed P-256 point, base64url (65 bytes): what browsers pass as `applicationServerKey` */
  publicKey: string;
  /** the private scalar, base64url (32 bytes); kept only in the vault */
  privateKey: string;
}
export function generateVapidKeys(): VapidKeys {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

/** RFC 8292 `Authorization` header value for one push service origin (12 h expiry). */
export function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now = Date.now(),
): string {
  const pub = fromB64u(keys.publicKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: b64u(pub.subarray(1, 33)),
    y: b64u(pub.subarray(33, 65)),
  };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const sig = signData('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** RFC 8291: encrypt `plaintext` for a subscription (p256dh = the browser's public key, auth = its secret). */
export function encryptPayload(plaintext: Buffer, sub: { p256dh: string; auth: string }, rs = 4096): Buffer {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh key');
  if (authSecret.length < 16) throw new Error('bad auth secret');
  const as = createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  // one record: the data, then the 0x02 delimiter of the last record (no padding)
  if (plaintext.length + 1 + 16 > rs) throw new Error('payload too large for one record');
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([
    c.update(Buffer.concat([plaintext, Buffer.from([2])])),
    c.final(),
    c.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ct]);
}
