/**
 * Peer-key proof for byte pipes that carry no identity of their own (the tailcat child process): each side sends its
 * long-term public key and a fresh nonce, then signs the other side's nonce together with both keys. What follows
 * the two preamble lines is handed on untouched as the link stream.
 */
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { isLinkPublicKey, type LinkKeys, signLink, verifyLink } from './keys.js';
import { type LinkPeer, LinkTransportError } from './types.js';

const MAX_LINE = 4096;
const proofText = (nonce: string, signer: string, other: string) =>
  `pasabot-link-transport-proof|${nonce}|${signer}|${other}`;

export async function provePeer(
  inner: Duplex,
  keys: LinkKeys,
  o: { timeoutMs?: number; startTimerOnData?: boolean; onFirstData?: () => void } = {},
): Promise<{ stream: Duplex; peer: LinkPeer }> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const myNonce = randomBytes(16).toString('base64url');
  let buf = Buffer.alloc(0);
  let handedOver = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let sawData = false;

  const out = new Duplex({
    read() {
      inner.resume();
    },
    write(chunk, _enc, cb) {
      inner.write(chunk, cb);
    },
    final(cb) {
      inner.end();
      cb();
    },
    destroy(err, cb) {
      inner.destroy();
      cb(err);
    },
  });
  const fail = (e: Error) => {
    if (!failure) failure = e;
    wake?.();
  };
  const armTimer = () => {
    if (!timer)
      timer = setTimeout(() => fail(new LinkTransportError('peer_key', 'peer proof timed out')), timeoutMs);
  };
  inner.on('data', (c: Buffer) => {
    if (!sawData) {
      sawData = true;
      o.onFirstData?.();
      armTimer();
    }
    if (handedOver) {
      if (!out.push(c)) inner.pause();
      return;
    }
    buf = Buffer.concat([buf, c]);
    if (buf.length > MAX_LINE * 2) fail(new LinkTransportError('peer_key', 'peer proof too long'));
    wake?.();
  });
  inner.on('end', () => {
    if (handedOver) out.push(null);
    else fail(new LinkTransportError('closed', 'stream ended during the peer proof'));
  });
  inner.on('error', (e) =>
    handedOver ? out.destroy(e) : fail(new LinkTransportError('closed', 'stream failed')),
  );
  inner.on('close', () => {
    if (handedOver) out.destroy();
    else fail(new LinkTransportError('closed', 'stream closed during the peer proof'));
  });
  if (!o.startTimerOnData) armTimer();

  const nextLine = () =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        if (failure) return reject(failure);
        const i = buf.indexOf(10);
        if (i >= 0) {
          const line = buf.subarray(0, i).toString('utf8');
          buf = buf.subarray(i + 1);
          wake = null;
          return resolve(line);
        }
        wake = check;
      };
      check();
    });
  const parse = (line: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {}
    throw new LinkTransportError('peer_key', 'malformed peer proof');
  };

  try {
    inner.write(`${JSON.stringify({ v: 1, pub: keys.publicKey, nonce: myNonce })}\n`);
    const hello = parse(await nextLine());
    const theirPub = hello.pub;
    const theirNonce = hello.nonce;
    if (!isLinkPublicKey(theirPub) || typeof theirNonce !== 'string' || theirNonce.length > 64)
      throw new LinkTransportError('peer_key', 'malformed peer proof');
    inner.write(
      `${JSON.stringify({ sig: signLink(keys, proofText(theirNonce, keys.publicKey, theirPub)) })}\n`,
    );
    const proof = parse(await nextLine());
    if (!verifyLink(theirPub, proofText(myNonce, theirPub, keys.publicKey), proof.sig))
      throw new LinkTransportError('peer_key', 'the peer could not prove its key');
    if (timer) clearTimeout(timer);
    handedOver = true;
    if (buf.length) out.push(buf);
    buf = Buffer.alloc(0);
    return { stream: out, peer: { publicKey: theirPub } };
  } catch (e) {
    if (timer) clearTimeout(timer);
    inner.destroy();
    throw e instanceof LinkTransportError ? e : new LinkTransportError('peer_key', 'peer proof failed');
  }
}
