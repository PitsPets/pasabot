/**
 * Signed releases for `pasabot update`. A release is `pasabot-<version>.tar.gz` plus `<tarball>.sig`: a base64 Ed25519
 * signature over the exact tarball bytes. Trusted keys are the `*.pub` files (PEM, SPKI) in the INSTALLED copy's
 * `deploy/release-keys/`, never in the tarball being checked. Nothing is unpacked before the signature passes,
 * and the unpacker is our own: regular files and folders only, no links, no absolute paths, no `..`.
 */
import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;

export class ReleaseError extends Error {}

export function loadTrustedKeys(installRoot: string): KeyObject[] {
  const dir = join(installRoot, 'deploy', 'release-keys');
  if (!existsSync(dir)) return [];
  const keys: KeyObject[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.pub')) continue;
    const k = createPublicKey(readFileSync(join(dir, f)));
    if (k.asymmetricKeyType !== 'ed25519') throw new ReleaseError(`release key ${f} is not an Ed25519 key`);
    keys.push(k);
  }
  return keys;
}

/** Throws unless `sig` is a valid signature of `data` by one of `keys`. */
export function verifyRelease(data: Buffer, sigText: string, keys: KeyObject[]) {
  if (!keys.length)
    throw new ReleaseError('no release signing key is pinned in this install; refusing to update');
  const sig = Buffer.from(sigText.trim(), 'base64');
  if (sig.length !== 64) throw new ReleaseError('signature file is not an Ed25519 signature');
  if (!keys.some((k) => verify(null, data, k, sig)))
    throw new ReleaseError('signature check failed: the tarball is not signed by a pinned release key');
}

interface Entry {
  path: string;
  type: 'file' | 'dir';
  mode: number;
  data: Buffer;
}

const cstr = (b: Buffer) => {
  const z = b.indexOf(0);
  return b.subarray(0, z === -1 ? b.length : z).toString('utf8');
};
const octal = (b: Buffer) => {
  const s = cstr(b).trim();
  if (!/^[0-7]*$/.test(s)) throw new ReleaseError('tarball header has a non-octal number');
  return s ? Number.parseInt(s, 8) : 0;
};

/** Safe relative path inside the release, or an error. */
function safePath(p: string): string {
  const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean.startsWith('/') || clean.includes('\\') || clean.includes('\0'))
    throw new ReleaseError(`tarball entry "${p}" has an unsafe path`);
  if (clean.split('/').some((s) => s === '..' || s === ''))
    throw new ReleaseError(`tarball entry "${p}" has an unsafe path`);
  return clean;
}

/** Parse a gzip'd ustar/pax tarball. Only regular files and folders are accepted. */
export function readTarGz(gz: Buffer): Entry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: 4 * MAX_TARBALL_BYTES });
  } catch {
    throw new ReleaseError('tarball is not valid gzip');
  }
  const out: Entry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== octal(h.subarray(148, 156))) throw new ReleaseError('tarball header checksum mismatch');
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156]!);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new ReleaseError('tarball is truncated');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'L') {
      // pax extended header (only `path` is honoured) or GNU long name: applies to the next entry
      if (type === 'L') longName = cstr(body);
      else
        for (const rec of body.toString('utf8').split('\n')) {
          const m = /^\d+ path=(.*)$/.exec(rec);
          if (m) longName = m[1]!;
        }
      continue;
    }
    if (type === 'g') continue;
    const prefix = cstr(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    longName = null;
    if (type === '0' || type === '\0') {
      out.push({ path: safePath(name), type: 'file', mode: octal(h.subarray(100, 108)), data: body });
    } else if (type === '5') {
      out.push({ path: safePath(name), type: 'dir', mode: 0o755, data: Buffer.alloc(0) });
    } else {
      throw new ReleaseError(`tarball entry "${name}" is a link or special file; releases hold files only`);
    }
  }
  return out;
}

export interface Manifest {
  name: 'pasabot';
  version: string;
}

/** Entries share one top folder (`pasabot-<version>/`); returns them relative to it plus the manifest. */
export function releaseContents(entries: Entry[]): { manifest: Manifest; files: Entry[] } {
  const tops = new Set(entries.map((e) => e.path.split('/')[0]!));
  if (tops.size !== 1) throw new ReleaseError('a release tarball must hold exactly one top folder');
  const top = [...tops][0]!;
  const files = entries
    .filter((e) => e.path !== top)
    .map((e) => ({ ...e, path: e.path.slice(top.length + 1) }));
  const m = files.find((e) => e.path === 'pasabot-release.json' && e.type === 'file');
  if (!m) throw new ReleaseError('release has no pasabot-release.json');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(m.data.toString('utf8'));
  } catch {
    throw new ReleaseError('pasabot-release.json is not valid JSON');
  }
  if (manifest.name !== 'pasabot' || typeof manifest.version !== 'string' || !VERSION.test(manifest.version))
    throw new ReleaseError('pasabot-release.json has no valid name/version');
  if (top !== `pasabot-${manifest.version}`)
    throw new ReleaseError('top folder does not match the release version');
  return { manifest, files };
}

const cmpVersion = (a: string, b: string) => {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return (a.includes('-') ? 0 : 1) - (b.includes('-') ? 0 : 1);
};

export function currentVersion(prefix: string): string | null {
  try {
    return JSON.parse(readFileSync(join(prefix, 'current', 'pasabot-release.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

export interface ApplyResult {
  version: string;
  previous: string | null;
  path: string;
}

/**
 * Verify, unpack into `<prefix>/releases/<version>`, then switch `<prefix>/current` atomically. A downgrade or an
 * already-installed version is refused unless `allowDowngrade`.
 */
export function applyRelease(o: {
  tarball: Buffer;
  sig: string;
  keys: KeyObject[];
  prefix: string;
  allowDowngrade?: boolean;
  checkOnly?: boolean;
}): ApplyResult {
  if (o.tarball.length > MAX_TARBALL_BYTES) throw new ReleaseError('tarball is larger than 512 MB');
  verifyRelease(o.tarball, o.sig, o.keys);
  const { manifest, files } = releaseContents(readTarGz(o.tarball));
  const previous = currentVersion(o.prefix);
  if (previous && cmpVersion(manifest.version, previous) <= 0 && !o.allowDowngrade)
    throw new ReleaseError(
      `release ${manifest.version} is not newer than the installed ${previous} (use --allow-downgrade to roll back)`,
    );
  const releases = join(o.prefix, 'releases');
  const dest = join(releases, manifest.version);
  if (o.checkOnly) return { version: manifest.version, previous, path: dest };
  mkdirSync(releases, { recursive: true, mode: 0o755 });
  const staging = join(releases, `.staging-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(staging, { mode: 0o755 });
    const base = resolve(staging);
    for (const e of files) {
      const target = resolve(base, e.path);
      if (!target.startsWith(base + sep))
        throw new ReleaseError(`tarball entry "${e.path}" escapes the release`);
      if (e.type === 'dir') mkdirSync(target, { recursive: true, mode: 0o755 });
      else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        // never setuid/setgid/sticky, never group/world writable
        writeFileSync(target, e.data, { mode: e.mode & 0o755 });
      }
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const link = join(o.prefix, 'current');
  const tmp = join(o.prefix, `.current-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(join('releases', manifest.version), tmp);
  renameSync(tmp, link);
  return { version: manifest.version, previous, path: dest };
}
