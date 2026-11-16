/**
 * The link protocol over one LinkStream (ARCHITECTURE 11.2): newline-delimited JSON frames. A connection is
 * `hello` both ways (protocol version, features, long-term key, a fresh nonce) → `auth` both ways (a signature over
 * a transcript of both nonces, both keys, the agreed version and the link-code hash) → one request and its answer.
 * The code hash itself never goes on the wire: the dialer's signature over a transcript that includes it is the
 * proof that it holds the code, and the listener finds the code by checking that signature against its open codes.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { LinkKeys, LinkStream } from '@pasabot/link-transport';
import { isLinkAddress, isLinkPublicKey, signLink, verifyLink } from '@pasabot/link-transport';

export const PROTOCOL_VERSION = 1;
export const FEATURES = ['chat', 'collab', 'intro'] as const;
const MAX_FRAME = 1024 * 1024;

export class LinkRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LinkRefused';
  }
}

/** NDJSON frames over a stream, read one at a time with a deadline. */
export class FrameConn {
  private buf = Buffer.alloc(0);
  private frames: Record<string, unknown>[] = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  constructor(readonly stream: LinkStream) {
    stream.on('data', (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (let i = this.buf.indexOf(10); i >= 0; i = this.buf.indexOf(10)) {
        const line = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 1);
        try {
          const v = JSON.parse(line) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) this.frames.push(v as Record<string, unknown>);
          else this.fail(new LinkRefused('protocol', 'malformed frame'));
        } catch {
          this.fail(new LinkRefused('protocol', 'malformed frame'));
        }
      }
      if (this.buf.length > MAX_FRAME) this.fail(new LinkRefused('protocol', 'frame too large'));
      this.wake?.();
    });
    const closed = () => this.fail(new LinkRefused('closed', 'the link connection closed'));
    stream.on('end', closed);
    stream.on('close', closed);
    stream.on('error', closed);
  }
  private fail(e: Error) {
    if (!this.failure) this.failure = e;
    this.wake?.();
  }
  send(frame: Record<string, unknown>) {
    if (!this.stream.destroyed) this.stream.write(`${JSON.stringify(frame)}\n`);
  }
  next(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new LinkRefused('timeout', 'the linked machine did not answer in time'));
      }, timeoutMs);
      const check = () => {
        const f = this.frames.shift();
        if (f) {
          clearTimeout(timer);
          this.wake = null;
          return resolve(f);
        }
        if (this.failure) {
          clearTimeout(timer);
          this.wake = null;
          return reject(this.failure);
        }
        this.wake = check;
      };
      check();
    });
  }
  close() {
    this.stream.end();
    setTimeout(() => this.stream.destroy(), 1000).unref();
  }
}

export interface Hello {
  t: 'hello';
  v: number;
  min: number;
  features: string[];
  pub: string;
  nonce: string;
  name: string;
  purpose?: 'call' | 'link';
}
export const newNonce = () => randomBytes(16).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('base64url');

export function parseHello(f: Record<string, unknown>): Hello {
  if (f.t === 'refuse')
    throw new LinkRefused(String(f.code ?? 'refused'), String(f.message ?? 'refused').slice(0, 300));
  const ok =
    f.t === 'hello' &&
    Number.isInteger(f.v) &&
    Number.isInteger(f.min) &&
    Array.isArray(f.features) &&
    isLinkPublicKey(f.pub) &&
    typeof f.nonce === 'string' &&
    f.nonce.length >= 16 &&
    f.nonce.length <= 64 &&
    typeof f.name === 'string' &&
    f.name.length <= 80 &&
    (f.purpose === undefined || f.purpose === 'call' || f.purpose === 'link');
  if (!ok) throw new LinkRefused('protocol', 'malformed hello');
  return {
    t: 'hello',
    v: f.v as number,
    min: f.min as number,
    features: (f.features as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 32),
    pub: f.pub as string,
    nonce: f.nonce as string,
    name: f.name as string,
    ...(f.purpose ? { purpose: f.purpose as 'call' | 'link' } : {}),
  };
}

/** The version both sides speak, or a refusal that tells the owner which machine to update. */
export function agreeVersion(mine: { v: number; min: number }, theirs: { v: number; min: number }): number {
  if (theirs.v < mine.min)
    throw new LinkRefused(
      'version_unsupported',
      `The other machine runs an older PasaBot (link protocol ${theirs.v}; this one needs ${mine.min} or newer). Update that machine, then try again.`,
    );
  if (mine.v < theirs.min)
    throw new LinkRefused(
      'version_unsupported',
      `This machine runs an older PasaBot (link protocol ${mine.v}; the other one needs ${theirs.min} or newer). Update this machine, then try again.`,
    );
  return Math.min(mine.v, theirs.v);
}

export const transcript = (v: number, dialer: Hello, listener: Hello, codeHash: string) =>
  sha256(
    JSON.stringify(['pasabot-link', v, dialer.pub, listener.pub, dialer.nonce, listener.nonce, codeHash]),
  );
export const signTranscript = (keys: LinkKeys, role: 'dialer' | 'listener', t: string) =>
  signLink(keys, `${role}|${t}`);
export const verifyTranscript = (pub: string, role: 'dialer' | 'listener', t: string, sig: unknown) =>
  verifyLink(pub, `${role}|${t}`, sig);

/** Link code: `bkl1.` + base64url JSON { a: address, f: key fingerprint, s: 128-bit secret, t: transport }. */
export interface LinkCode {
  address: string;
  fingerprint: string;
  secret: string;
  transport: string;
}
export const encodeCode = (c: LinkCode) =>
  `bkl1.${Buffer.from(JSON.stringify({ a: c.address, f: c.fingerprint, s: c.secret, t: c.transport })).toString('base64url')}`;
export function decodeCode(code: string): LinkCode | null {
  const s = code.trim();
  if (!s.startsWith('bkl1.') || s.length > 2048) return null;
  try {
    const j = JSON.parse(Buffer.from(s.slice(5), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof j.a !== 'string' ||
      typeof j.f !== 'string' ||
      typeof j.s !== 'string' ||
      typeof j.t !== 'string'
    )
      return null;
    if (Buffer.from(j.s, 'base64url').length !== 16) return null;
    // the address may end up as a CLI argument (tailcat): only the plain address grammar, never an option
    if (!isLinkAddress(j.a)) return null;
    return { address: j.a, fingerprint: j.f, secret: j.s, transport: j.t };
  } catch {
    return null;
  }
}
