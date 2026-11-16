/** Long-term Ed25519 identity of one PasaBot server (ARCHITECTURE 11.2, step 4: peers pin this key). */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';

export interface LinkKeys {
  /** raw 32-byte Ed25519 public key, base64url */
  publicKey: string;
  privateKey: KeyObject;
}

/** The raw public key of a key object (X.509 / SPKI / private), or null when it is not Ed25519. */
export function rawPublicKey(key: KeyObject): string | null {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') return null;
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  return typeof jwk.x === 'string' ? jwk.x : null;
}

export function generateLinkKeys(): LinkKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: rawPublicKey(publicKey)!, privateKey };
}
/** PKCS#8 PEM of the private key (kept in the vault, never on disk in clear). */
export const linkKeysToPem = (k: LinkKeys): string =>
  k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export function linkKeysFromPem(pem: string): LinkKeys {
  const privateKey = createPrivateKey(pem);
  const pub = rawPublicKey(privateKey);
  if (!pub) throw new Error('not an Ed25519 key');
  return { publicKey: pub, privateKey };
}

/** True for a base64url string that decodes to exactly 32 bytes (no regex: a decode round trip). */
export function isLinkPublicKey(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== 43) return false;
  const b = Buffer.from(s, 'base64url');
  return b.length === 32 && b.toString('base64url') === s;
}
export const publicKeyObject = (pub: string): KeyObject =>
  createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });

export const signLink = (keys: LinkKeys, data: Buffer | string): string =>
  sign(null, Buffer.from(data), keys.privateKey).toString('base64url');
export function verifyLink(pub: string, data: Buffer | string, sig: unknown): boolean {
  if (!isLinkPublicKey(pub) || typeof sig !== 'string' || sig.length > 200) return false;
  try {
    return verify(null, Buffer.from(data), publicKeyObject(pub), Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}
/** Short, human-comparable fingerprint of a public key (shown in the UI, carried in link codes). */
export const fingerprint = (pub: string): string =>
  createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('base64url').slice(0, 22);
