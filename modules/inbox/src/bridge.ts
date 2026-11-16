/**
 * Email bridge between two PasaBot bots (W35, ARCHITECTURE 13). Each side pins the other's sender address and
 * Ed25519 public key (exchanged in the app). A bridged mail carries the header
 * `X-PasaBot-Bridge: v1.<base64url(envelope JSON)>.<base64url(signature)>`; the signature (Node's Ed25519, no
 * home-made crypto) covers the exact envelope bytes, and the envelope names the sender bot, the recipient bot (key
 * fingerprints), a thread id, a nonce, a timestamp and the SHA-256 of the body text. A verified message is still
 * untrusted data, and every reply still raises an outbound-message card.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

export const BRIDGE_HEADER = 'x-pasabot-bridge';
/** a bridged message older or newer than this is refused */
export const BRIDGE_WINDOW_MS = 10 * 60_000;

export interface Envelope {
  v: 1;
  senderBot: string;
  recipientBot: string;
  threadId: string;
  nonce: string;
  ts: number;
  bodyHash: string;
}

export type BridgeRefusal =
  | 'unsigned'
  | 'malformed'
  | 'unknown_sender'
  | 'wrong_from'
  | 'wrong_key'
  | 'bad_signature'
  | 'wrong_recipient'
  | 'body_changed'
  | 'stale'
  | 'replayed';

export function newBotKeys(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: rawPublic(publicKey),
  };
}
/** the 32-byte raw public key, base64url: what the owners exchange */
export function rawPublic(k: KeyObject): string {
  const der = k.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}
export function publicFromPrivatePem(pem: string): string {
  return rawPublic(createPublicKey(createPrivateKey(pem)));
}
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function publicKeyObject(raw: string): KeyObject {
  const b = Buffer.from(raw, 'base64url');
  if (b.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, b]), format: 'der', type: 'spki' });
}
export function isPublicKey(raw: string): boolean {
  try {
    publicKeyObject(raw);
    return true;
  } catch {
    return false;
  }
}
/** short, stable id of a bot: the first 16 bytes of SHA-256 over its raw public key */
export function fingerprint(raw: string): string {
  return createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex').slice(0, 32);
}
export const bodyHash = (body: string) =>
  createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex');
/** line endings and trailing whitespace do not survive every mail hop the same way */
export function normalizeBody(body: string): string {
  return body
    .split('\r\n')
    .join('\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trimEnd();
}

export function sealEnvelope(
  o: { privatePem: string; recipientKey: string; threadId: string; body: string },
  now = Date.now(),
): string {
  const env: Envelope = {
    v: 1,
    senderBot: fingerprint(publicFromPrivatePem(o.privatePem)),
    recipientBot: fingerprint(o.recipientKey),
    threadId: o.threadId,
    nonce: randomBytes(16).toString('base64url'),
    ts: now,
    bodyHash: bodyHash(o.body),
  };
  const payload = Buffer.from(JSON.stringify(env), 'utf8');
  const sig = sign(null, payload, createPrivateKey(o.privatePem));
  return `v1.${payload.toString('base64url')}.${sig.toString('base64url')}`;
}

export interface PinnedPeer {
  id: string;
  address: string;
  publicKey: string;
}

/**
 * Checks a received mail against the pins. `seen(peerId, nonce)` answers whether the nonce was used already and
 * records it when not (the caller's store); it is called only after every other check passed.
 */
export function openEnvelope(
  m: { header: string | null | undefined; fromAddr: string; body: string },
  o: {
    peers: PinnedPeer[];
    ownPublicKey: string;
    seen: (peerId: string, nonce: string, ts: number) => boolean;
    now?: number;
  },
):
  | { ok: true; peer: PinnedPeer; envelope: Envelope }
  | { ok: false; reason: BridgeRefusal; peer?: PinnedPeer } {
  const now = o.now ?? Date.now();
  const from = m.fromAddr.trim().toLowerCase();
  const byAddr = o.peers.find((p) => p.address === from);
  if (!m.header) return { ok: false, reason: 'unsigned', ...(byAddr ? { peer: byAddr } : {}) };
  const parts = m.header.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  let env: Envelope;
  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(parts[1]!, 'base64url');
    sig = Buffer.from(parts[2]!, 'base64url');
    env = JSON.parse(payload.toString('utf8')) as Envelope;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    env?.v !== 1 ||
    typeof env.senderBot !== 'string' ||
    typeof env.recipientBot !== 'string' ||
    typeof env.threadId !== 'string' ||
    typeof env.nonce !== 'string' ||
    typeof env.ts !== 'number' ||
    typeof env.bodyHash !== 'string'
  )
    return { ok: false, reason: 'malformed' };
  const byKey = o.peers.find((p) => fingerprint(p.publicKey) === env.senderBot);
  if (!byAddr && !byKey) return { ok: false, reason: 'unknown_sender' };
  // the From address and the key must both match the same pin
  if (!byAddr) return { ok: false, reason: 'wrong_from', peer: byKey! };
  if (!byKey || byKey.id !== byAddr.id) return { ok: false, reason: 'wrong_key', peer: byAddr };
  const peer = byAddr;
  let good = false;
  try {
    good = verify(null, payload, publicKeyObject(peer.publicKey), sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad_signature', peer };
  if (env.recipientBot !== fingerprint(o.ownPublicKey)) return { ok: false, reason: 'wrong_recipient', peer };
  if (env.bodyHash !== bodyHash(m.body)) return { ok: false, reason: 'body_changed', peer };
  if (Math.abs(now - env.ts) > BRIDGE_WINDOW_MS) return { ok: false, reason: 'stale', peer };
  if (o.seen(peer.id, env.nonce, env.ts)) return { ok: false, reason: 'replayed', peer };
  return { ok: true, peer, envelope: env };
}
