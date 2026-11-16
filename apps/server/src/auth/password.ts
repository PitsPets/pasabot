/** argon2id password hashing (PHC string). node:crypto's argon2 when present (Node >= 24.7), else @noble/hashes. */
import * as crypto from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';

const PARAMS = { m: 19_456, t: 2, p: 1 } as const; // OWASP minimum for argon2id

type NodeArgon2 = (
  algo: 'argon2id',
  o: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  cb: (err: Error | null, out: Buffer) => void,
) => void;

async function derive(password: string, salt: Buffer, p: { m: number; t: number; p: number }, len = 32) {
  const native = (crypto as unknown as { argon2?: NodeArgon2 }).argon2;
  if (native) {
    return await new Promise<Buffer>((res, rej) =>
      native(
        'argon2id',
        {
          message: Buffer.from(password, 'utf8'),
          nonce: salt,
          parallelism: p.p,
          tagLength: len,
          memory: p.m,
          passes: p.t,
        },
        (e, out) => (e ? rej(e) : res(out)),
      ),
    );
  }
  return Buffer.from(await argon2idAsync(password, salt, { m: p.m, t: p.t, p: p.p, dkLen: len }));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const out = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.m},t=${PARAMS.t},p=${PARAMS.p}$${salt.toString('base64url')}$${out.toString('base64url')}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = phc.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/);
  if (!m) return false;
  const want = Buffer.from(m[5]!, 'base64url');
  const got = await derive(
    password,
    Buffer.from(m[4]!, 'base64url'),
    { m: Number(m[1]), t: Number(m[2]), p: Number(m[3]) },
    want.length,
  );
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Key derivation for a vault passphrase (raw 32 bytes). */
export const deriveKey = (passphrase: string, salt: Buffer) => derive(passphrase, salt, PARAMS, 32);
