/**
 * The encrypted whole-agent bundle (W32): one file, `pasabot.agent-bundle.enc` v2.
 *
 * Layout: MAGIC | u32 big-endian header length | header JSON (utf-8) | ciphertext | 16-byte GCM tag.
 * The header names the format, its version, the KDF and its parameters + salt, and the cipher + nonce; it is the
 * additional authenticated data, so changing any header byte fails authentication like changing the ciphertext.
 * Crypto is Node's built-in OpenSSL only: AES-256-GCM (authenticated) and scrypt (memory-hard KDF), no home-made
 * primitives. The plaintext is gzip'd JSON (`BundlePayload`), size-capped when it is inflated.
 *
 * Opening fails closed: a wrong passphrase and any flipped byte are the same `bad_passphrase_or_tampered` error, and
 * nothing in the payload is trusted until the whole file authenticated and every path passed `checkEntryPath`.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { agentBundleSchema, trustLevelSchema } from '@pasabot/protocol';
import { z } from 'zod';

export const BUNDLE_FORMAT = 'pasabot.agent-bundle.enc';
export const BUNDLE_VERSION = 2;
const MAGIC = Buffer.from('PASABOT-AGENT-BUNDLE\n', 'utf8');
const TAG_LEN = 16;
const MAX_HEADER = 4096;
/** inflated payload cap (a gzip bomb stops here) */
export const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

/** workspace files and bytes one bundle carries */
export const MAX_WORKSPACE_FILES = 5000;
export const MAX_WORKSPACE_BYTES = 50 * 1024 * 1024;

/** scrypt cost: N = 2^17, r = 8, p = 1 (128 MiB, OWASP's scrypt floor). Readers take the header's values. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
// bounds a reader accepts, so a hostile header cannot ask for gigabytes of memory or minutes of CPU
const kdfSchema = z.object({
  name: z.literal('scrypt'),
  N: z
    .number()
    .int()
    .min(2 ** 14)
    .max(2 ** 18)
    .refine((n) => (n & (n - 1)) === 0, 'N must be a power of two'),
  r: z.literal(8),
  p: z.number().int().min(1).max(2),
  salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
});
const headerSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  v: z.number().int(),
  kdf: kdfSchema,
  cipher: z.object({ name: z.literal('aes-256-gcm'), nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/) }),
  createdAt: z.number().int(),
});
export type BundleHeader = z.infer<typeof headerSchema>;

/** The decrypted content: the W19 agent bundle plus what W32 adds. */
export const bundlePayloadSchema = z.object({
  format: z.literal('pasabot.agent-bundle.payload'),
  v: z.literal(2),
  agent: agentBundleSchema,
  memory: z
    .array(
      z.object({
        backend: z.string().max(80),
        text: z.string().max(100_000),
        tags: z.array(z.string().max(100)).max(50).default([]),
        source: z.string().max(500).optional(),
        createdAt: z.number().int().optional(),
      }),
    )
    .max(20_000),
  /**
   * W33: the agent's private memory scope through the memory module's export port, with its provenance (key,
   * confidence, writer, trust). When present, `memory` above is empty for the same items; older files lack it.
   */
  pool: z
    .array(
      z.object({
        text: z.string().max(100_000),
        tags: z.array(z.string().max(100)).max(50).default([]),
        key: z.string().max(80).optional(),
        confidence: z.enum(['low', 'high']).optional(),
        source: z.string().max(500).optional(),
        writer: z.object({ kind: z.enum(['owner', 'agent', 'import']) }),
        trust: trustLevelSchema,
        createdAt: z.number().int(),
      }),
    )
    .max(20_000)
    .optional(),
  workspace: z.array(z.object({ path: z.string().max(500), data: z.string() })).max(MAX_WORKSPACE_FILES),
  /**
   * W31: the owner-approved permission manifests of the agent's synced skills (through the safety module's
   * SkillManifestPort). On import each is only a proposal the owner approves; the safety module validates it.
   */
  skillManifests: z
    .array(
      z.object({
        skillId: z.string().min(1).max(81),
        manifest: z.record(z.string(), z.unknown()),
      }),
    )
    .max(200)
    .optional(),
  vault: z
    .array(z.object({ name: z.string().min(1).max(100), value: z.string().max(100_000) }))
    .max(500)
    .optional(),
});
export type BundlePayload = z.infer<typeof bundlePayloadSchema>;

export class BundleError extends Error {
  constructor(
    readonly code:
      | 'not_a_bundle'
      | 'unsupported_version'
      | 'bad_passphrase_or_tampered'
      | 'bad_payload'
      | 'unsafe_path',
    message: string,
  ) {
    super(message);
  }
}

const scrypt = (pass: string, salt: Buffer, k: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(
      pass.normalize('NFC'),
      salt,
      32,
      { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r + 32 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );

function frame(header: BundleHeader): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return Buffer.concat([MAGIC, len, h]);
}

/** Encrypt a payload. `kdf` overrides the cost (tests, and a future default bump: readers take the header's). */
export async function sealBundle(
  payload: BundlePayload,
  passphrase: string,
  o: { kdf?: { N: number; r: 8; p: number }; v?: number; now?: number } = {},
): Promise<Buffer> {
  const k = o.kdf ?? DEFAULT_KDF;
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header: BundleHeader = {
    format: BUNDLE_FORMAT,
    v: o.v ?? BUNDLE_VERSION,
    kdf: { name: 'scrypt', N: k.N, r: k.r, p: k.p, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', nonce: nonce.toString('base64') },
    createdAt: o.now ?? Date.now(),
  };
  const head = frame(header);
  const key = await scrypt(passphrase, salt, k);
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(head);
  const body = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))), c.final()]);
  return Buffer.concat([head, body, c.getAuthTag()]);
}

/** Read the header only (no passphrase needed; nothing in it is secret). */
export function readHeader(file: Buffer): { header: BundleHeader; headEnd: number } {
  if (file.length < MAGIC.length + 4 || !file.subarray(0, MAGIC.length).equals(MAGIC))
    throw new BundleError('not_a_bundle', 'not a PasaBot agent bundle');
  const len = file.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (len < 2 || len > MAX_HEADER || start + len + TAG_LEN > file.length)
    throw new BundleError('bad_passphrase_or_tampered', 'the bundle is damaged or was changed');
  let raw: unknown;
  try {
    raw = JSON.parse(file.subarray(start, start + len).toString('utf8'));
  } catch {
    throw new BundleError('bad_passphrase_or_tampered', 'the bundle is damaged or was changed');
  }
  const fmt = (raw as { format?: unknown; v?: unknown }) ?? {};
  if (fmt.format === BUNDLE_FORMAT && typeof fmt.v === 'number' && fmt.v !== BUNDLE_VERSION)
    throw new BundleError('unsupported_version', `bundle version ${fmt.v} is not supported here`);
  const h = headerSchema.safeParse(raw);
  if (!h.success) throw new BundleError('bad_passphrase_or_tampered', 'the bundle is damaged or was changed');
  return { header: h.data, headEnd: start + len };
}

/** Decrypt and validate. Throws `BundleError`; returns only a fully authenticated, schema-valid payload. */
export async function openBundle(file: Buffer, passphrase: string): Promise<BundlePayload> {
  const { header, headEnd } = readHeader(file);
  const key = await scrypt(passphrase, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(header.cipher.nonce, 'base64'), {
    authTagLength: TAG_LEN,
  });
  d.setAAD(file.subarray(0, headEnd));
  d.setAuthTag(file.subarray(file.length - TAG_LEN));
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(file.subarray(headEnd, file.length - TAG_LEN)), d.final()]);
  } catch {
    throw new BundleError('bad_passphrase_or_tampered', 'wrong passphrase, or the bundle was changed');
  }
  let json: unknown;
  try {
    json = JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8'));
  } catch {
    throw new BundleError('bad_payload', 'the bundle content is not readable');
  }
  const p = bundlePayloadSchema.safeParse(json);
  if (!p.success) throw new BundleError('bad_payload', 'the bundle content is not valid');
  checkEntrySet(p.data.workspace.map((f) => f.path));
  return p.data;
}

/** how a case-insensitive, normalization-insensitive file system (APFS, NTFS defaults) sees a path */
const fold = (path: string) => path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();

/**
 * Every entry path is safe (`checkEntryPath`), and the set can be written as given on any file system: no two paths
 * that differ only by case or Unicode normalization, and no path that is both a file and a directory of another
 * (`notes` and `notes/a.md`). Throws `unsafe_path` before anything is written.
 */
export function checkEntrySet(paths: string[]): void {
  const files = new Set<string>();
  for (const raw of paths) {
    const k = fold(checkEntryPath(raw));
    if (files.has(k))
      throw new BundleError('unsafe_path', `duplicate entry ${JSON.stringify(raw.slice(0, 120))}`);
    files.add(k);
  }
  for (const k of files) {
    const parts = k.split('/');
    for (let i = 1; i < parts.length; i++)
      if (files.has(parts.slice(0, i).join('/')))
        throw new BundleError('unsafe_path', 'an entry is both a file and a folder in the bundle');
  }
}

/**
 * A workspace entry path is safe when it is a plain relative POSIX path: no absolute or drive paths, no `..` or
 * `.` segments, no empty segments, no backslashes or control characters, nothing under `.pasabot/`. Returns it.
 */
export function checkEntryPath(path: string): string {
  const bad = () =>
    new BundleError('unsafe_path', `unsafe path in bundle: ${JSON.stringify(path.slice(0, 120))}`);
  if (typeof path !== 'string' || path.length === 0 || path.length > 500) throw bad();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw bad();
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('~')) throw bad();
  const parts = path.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw bad();
  // `.PASABOT/` is the same folder on a case-insensitive file system
  if (parts[0]!.normalize('NFC').toLowerCase() === '.pasabot') throw bad();
  return path;
}
