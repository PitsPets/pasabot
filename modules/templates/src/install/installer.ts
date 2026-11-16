/**
 * The free starter's OpenCode installer. Per user, no admin rights: it reads the latest release's metadata over
 * safe-net, downloads the asset for this platform, checks its SHA-256 against the digest the release publishes,
 * unpacks it into a fresh temp folder and copies only the `opencode` binary (a regular file, never a link) into the
 * chosen bin dir. Nothing is downloaded or written unless the caller passes `consent: true`. A missing digest, a
 * checksum mismatch or any other failure throws `InstallError` and leaves the bin dir untouched.
 *
 * Hosts: the release URL and the asset's `browser_download_url` must be on the catalog's `hosts` list and use the
 * release URL's scheme, or nothing is fetched. safe-net's private-address guard stays on for every request (no
 * `allowHosts`). Redirect hops (GitHub sends downloads to a signed CDN URL) are re-vetted by safe-net but not
 * host-listed; the bytes are trusted only because their SHA-256 matches the digest read from the host-listed API.
 * GitHub's API refuses requests without a User-Agent, so every request names PasaBot.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { SafeNetInit } from '@pasabot/core';

const run = promisify(execFile);

export interface InstallSource {
  release: string;
  /** the only hosts the release metadata and the asset may be fetched from (exact, lowercase) */
  hosts: string[];
  assets: Record<string, string>;
  binary: string;
}
export interface InstallResult {
  binPath: string;
  version: string;
}
export interface Installer {
  /** what the consent screen names: what, where, from where */
  describe(): { what: string; where: string; from: string };
  /** `signal`: the global stop (W31) aborts an install in flight; nothing is written after it fires */
  install(o: { consent: boolean; signal?: AbortSignal }): Promise<InstallResult>;
}
export class InstallError extends Error {
  constructor(
    readonly code: 'no_consent' | 'unsupported_platform' | 'download' | 'checksum' | 'unpack' | 'stopped',
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init?: SafeNetInit) => Promise<Response>;
export const MAX_DOWNLOAD = 300 * 1024 * 1024;
const MAX_META = 2 * 1024 * 1024;
const META_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const USER_AGENT = 'PasaBot';

export class ReleaseInstaller implements Installer {
  constructor(
    private readonly o: {
      source: InstallSource;
      binDir: string;
      fetch: Fetch;
      platform?: string;
    },
  ) {}

  private platform() {
    return this.o.platform ?? `${process.platform}-${process.arch}`;
  }

  /** the program's file name here: `opencode.exe` on Windows */
  private binaryName() {
    return this.platform().startsWith('win32-') ? `${this.o.source.binary}.exe` : this.o.source.binary;
  }

  describe() {
    return {
      what: 'OpenCode CLI',
      where: (this.platform().startsWith('win32-') ? win32.join : join)(this.o.binDir, this.binaryName()),
      from: this.o.source.release,
    };
  }

  async install({ consent, signal }: { consent: boolean; signal?: AbortSignal }): Promise<InstallResult> {
    if (consent !== true) throw new InstallError('no_consent', 'the owner has not agreed to the install');
    const stopped = () => new InstallError('stopped', 'the install was stopped');
    const checkStop = () => {
      if (signal?.aborted) throw stopped();
    };
    checkStop();
    const { source } = this.o;
    const assetName = source.assets[this.platform()];
    if (!assetName)
      throw new InstallError('unsupported_platform', `no OpenCode build for ${this.platform()}`);
    const hosts = new Set(source.hosts.map((h) => h.toLowerCase()));
    const releaseUrl = listed(source.release, hosts, null);
    let meta: {
      tag_name?: string;
      assets?: { name?: string; browser_download_url?: string; digest?: string }[];
    };
    try {
      const r = await this.o.fetch(releaseUrl.href, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
        maxBytes: MAX_META,
        timeoutMs: META_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (!r.ok) throw new Error(`release metadata: HTTP ${r.status}`);
      meta = (await r.json()) as typeof meta;
    } catch (e) {
      checkStop();
      throw new InstallError('download', `could not read the release: ${(e as Error).message}`);
    }
    const asset = meta.assets?.find((a) => a.name === assetName);
    if (!asset?.browser_download_url) throw new InstallError('download', `the release has no ${assetName}`);
    const assetUrl = listed(asset.browser_download_url, hosts, releaseUrl.protocol);
    const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null;
    if (!digest || !/^[0-9a-f]{64}$/.test(digest))
      throw new InstallError(
        'checksum',
        'the release publishes no SHA-256 for this file, so it cannot be checked',
      );
    let data: Buffer;
    try {
      const r = await this.o.fetch(assetUrl.href, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' },
        maxBytes: MAX_DOWNLOAD,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MAX_DOWNLOAD) throw new Error('file too large');
      data = Buffer.from(buf);
    } catch (e) {
      checkStop();
      throw new InstallError('download', `download failed: ${(e as Error).message}`);
    }
    checkStop();
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha !== digest)
      throw new InstallError('checksum', 'the download does not match its published SHA-256');

    const work = mkdtempSync(join(tmpdir(), 'pasabot-opencode-'));
    try {
      const archive = join(work, assetName);
      writeFileSync(archive, data, { mode: 0o600 });
      const out = join(work, 'x');
      mkdirSync(out);
      try {
        const [cmd, args] = unpackCommand(this.platform(), assetName, archive, out);
        await run(cmd, args, { timeout: 120_000, signal, windowsHide: true });
      } catch (e) {
        checkStop();
        throw new InstallError('unpack', `could not unpack: ${(e as Error).message}`);
      }
      const name = this.binaryName();
      const bin = findFile(out, name, 3);
      if (!bin) throw new InstallError('unpack', `no ${name} binary in the download`);
      checkStop();
      mkdirSync(this.o.binDir, { recursive: true });
      const dest = join(this.o.binDir, name);
      const tmp = `${dest}.pasabot-new`;
      copyFileSync(bin, tmp);
      chmodSync(tmp, 0o755);
      try {
        await renameRetry(tmp, dest);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw new InstallError('unpack', `could not put ${name} in place: ${(e as Error).message}`);
      }
      return { binPath: dest, version: String(meta.tag_name ?? 'unknown').slice(0, 40) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/**
 * How to unpack the download, an argument array (no shell). Windows: its own `tar.exe` by full path (bsdtar, in
 * every Windows 10 since 1803 and Windows 11), which reads zip files too; never a `tar` from PATH (Git's GNU tar
 * cannot read a zip) and never `unzip`, which Windows does not have. Elsewhere `unzip` / `tar -xzf`.
 */
export function unpackCommand(
  platform: string,
  assetName: string,
  archive: string,
  out: string,
  env: Record<string, string | undefined> = process.env,
): [string, string[]] {
  if (platform.startsWith('win32-')) {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return [win32.join(root, 'System32', 'tar.exe'), ['-xf', archive, '-C', out]];
  }
  if (assetName.endsWith('.zip')) return ['unzip', ['-q', '-o', archive, '-d', out]];
  return ['tar', ['-xzf', archive, '-C', out]];
}

/**
 * rename, retried a few times on Windows' EPERM/EBUSY/EACCES (an antivirus scan or the search indexer holds a new
 * file open for a moment; a running opencode.exe cannot be replaced until it exits)
 */
export async function renameRetry(from: string, to: string, tries = 6, waitMs = 250): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= tries - 1 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
}

/** The URL when its host is on the list (and, for the asset, its scheme matches the release's); else refuse. */
function listed(raw: string, hosts: Set<string>, scheme: string | null): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InstallError('download', 'the release names an invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new InstallError('download', `refusing a ${u.protocol} URL`);
  if (scheme && u.protocol !== scheme)
    throw new InstallError(
      'download',
      `refusing ${u.protocol} for the download (the release uses ${scheme})`,
    );
  if (!hosts.has(u.hostname.toLowerCase()))
    throw new InstallError(
      'download',
      `refusing to download from ${u.hostname}: not on the release host list`,
    );
  return u;
}

/** A regular file with that exact name, at most `depth` folders down; links are never followed. */
function findFile(dir: string, name: string, depth: number): string | null {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isFile() && e === name) return p;
    if (st.isDirectory() && depth > 0) {
      const f = findFile(p, name, depth - 1);
      if (f) return f;
    }
  }
  return null;
}

export const binExists = (p: string) => existsSync(p);
