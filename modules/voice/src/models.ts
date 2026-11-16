/**
 * Speech models, downloaded on demand by the owner (nothing is bundled and nothing downloads by itself).
 * A catalogue entry names one `.tar.bz2` archive (the sherpa-onnx release layout) and the files the speech process
 * needs inside it. Download: through the caller's fetch (the module passes safe-net), capped in size, sha256-checked
 * against the entry's pin (an entry without one is never downloaded: it ships `disabled`), unpacked by the system `tar`
 * (no inherited environment) into a fresh folder under the module's data dir with its unpacked size capped, cleared
 * of links and anything outside the folder, then moved into place in one rename. A failed install leaves nothing.
 *
 * sherpa-onnx publishes its models under moving release tags (`asr-models`, `tts-models`) with no versioned tag, so the
 * pin is the archive's sha256: a replaced asset no longer matches and is refused. There is no way to install an
 * unpinned entry (no dev switch either): a model whose real checksum could not be pinned ships `disabled`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { windowsEnv } from '@pasabot/core';
import type { WorkerConfig } from './engine.js';

export type ModelKind = 'stt' | 'tts';
export interface CatalogModel {
  id: string;
  kind: ModelKind;
  /** a model's own name; the English label when `label` is absent (e.g. a custom catalogue entry) */
  name: string;
  /**
   * The label in the app language: the model's own name (never translated) plus a translated note in brackets
   * (`voice:settings.modelName`). `name` is its English form.
   */
  label?: { model: string; note: ModelNote };
  /** language tags it handles, e.g. ['en', 'fil'] */
  languages: string[];
  /** approximate download size, MB */
  sizeMb: number;
  /** https URL of a .tar.bz2 archive */
  url: string;
  /** hex sha256 of the archive; a different download is refused, and an entry without one is never downloaded */
  sha256?: string;
  /**
   * The entry ships switched off, and why (shown to the owner, never installable): `unpinned` = no real checksum
   * could be pinned for its archive yet. Every entry without a `sha256` must say so.
   */
  disabled?: 'unpinned';
  /** folder inside the archive */
  root: string;
  /** files inside `root` (STT: encoder, decoder, tokens; TTS: model, tokens, dataDir) */
  files: Record<string, string>;
}

/** the bracketed note after a model's own name, translated (`voice:settings.note*`) */
export type ModelNote = 'multilingual' | 'english';

const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
export const BUILTIN_CATALOG: CatalogModel[] = [
  {
    id: 'whisper-tiny',
    kind: 'stt',
    name: 'Whisper tiny (multilingual)',
    label: { model: 'Whisper tiny', note: 'multilingual' },
    languages: ['en', 'fil'],
    sizeMb: 111,
    url: `${REL}/asr-models/sherpa-onnx-whisper-tiny.tar.bz2`,
    // SHIPPED DISABLED: GitHub publishes no digest for this 2024 asset (116204861 bytes, updated 2024-07-13), and no
    // real sha256 could be taken offline. To turn it on, pin `sha256` from a reviewed download and drop `disabled`.
    disabled: 'unpinned',
    root: 'sherpa-onnx-whisper-tiny',
    files: {
      encoder: 'tiny-encoder.int8.onnx',
      decoder: 'tiny-decoder.int8.onnx',
      tokens: 'tiny-tokens.txt',
    },
  },
  {
    id: 'piper-en-amy',
    kind: 'tts',
    name: 'Piper Amy (English)',
    label: { model: 'Piper Amy', note: 'english' },
    languages: ['en'],
    sizeMb: 64,
    url: `${REL}/tts-models/vits-piper-en_US-amy-low.tar.bz2`,
    // GitHub's published asset digest (67095344 bytes, updated 2025-06-30)
    sha256: 'c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639',
    root: 'vits-piper-en_US-amy-low',
    files: { model: 'en_US-amy-low.onnx', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' },
  },
];

export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type Fetcher = (url: string) => Promise<Response>;
export interface Progress {
  state: 'downloading' | 'unpacking' | 'failed';
  received: number;
  total: number | null;
  error?: string;
}

export interface ModelStoreOptions {
  /** compressed download cap (default 600 MB) */
  maxBytes?: number;
  /** unpacked size cap (default 4 x maxBytes); tar is killed and the install refused above it */
  maxUnpackedBytes?: number;
}

/** Why an entry cannot be installed (`disabled`, no pin, or a pin that is not a sha256), or null when it can. */
export function refusal(m: CatalogModel): ModelError | null {
  if (m.disabled)
    return new ModelError(
      'this model is switched off in this build: its download has no pinned checksum yet',
      'disabled',
    );
  const pin = m.sha256?.toLowerCase();
  if (pin === undefined)
    return new ModelError('this model has no pinned checksum, so it cannot be installed', 'unpinned');
  if (!/^[0-9a-f]{64}$/.test(pin))
    return new ModelError('the catalogue checksum is not a sha256', 'unpinned');
  return null;
}

export class ModelStore {
  readonly progress = new Map<string, Progress>();
  private readonly maxBytes: number;
  private readonly maxUnpackedBytes: number;
  constructor(
    private readonly dir: string,
    readonly catalog: CatalogModel[],
    private readonly fetcher: Fetcher,
    opts: ModelStoreOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 600 * 1024 * 1024;
    this.maxUnpackedBytes = opts.maxUnpackedBytes ?? 4 * this.maxBytes;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private folder(m: CatalogModel) {
    return join(this.dir, m.id);
  }
  installed(m: CatalogModel) {
    return Object.values(m.files).every((f) => existsSync(join(this.folder(m), m.root, f)));
  }
  find(id: string) {
    return this.catalog.find((m) => m.id === id) ?? null;
  }
  /**
   * The first installed model of a kind (catalogue order) that this build would also install: a folder left on disk
   * for an entry that is now refused (switched off, or no sha256 pin, e.g. unpacked by an older build without a
   * checksum check) is never chosen, so the speech process never loads unverified bits. The owner can still remove it.
   */
  active(kind: ModelKind) {
    return this.catalog.find((m) => m.kind === kind && refusal(m) === null && this.installed(m)) ?? null;
  }

  /** Paths the speech process needs, for whichever models are installed. */
  workerConfig(): Pick<WorkerConfig, 'stt' | 'tts'> {
    const out: Pick<WorkerConfig, 'stt' | 'tts'> = {};
    const p = (m: CatalogModel, k: string) => join(this.folder(m), m.root, m.files[k] ?? '');
    const s = this.active('stt');
    if (s) out.stt = { encoder: p(s, 'encoder'), decoder: p(s, 'decoder'), tokens: p(s, 'tokens') };
    const t = this.active('tts');
    if (t) out.tts = { model: p(t, 'model'), tokens: p(t, 'tokens'), dataDir: p(t, 'dataDir') };
    return out;
  }

  remove(id: string) {
    const m = this.find(id);
    if (!m) throw new ModelError('no such model', 'not_found');
    if (this.progress.get(id)?.state === 'downloading' || this.progress.get(id)?.state === 'unpacking')
      throw new ModelError('that model is still downloading', 'busy');
    rmSync(this.folder(m), { recursive: true, force: true });
    this.progress.delete(id);
  }

  /** Start a download; resolves when it is installed (callers may ignore the promise and poll `progress`). */
  install(id: string): Promise<void> {
    const m = this.find(id);
    if (!m) return Promise.reject(new ModelError('no such model', 'not_found'));
    // before anything is fetched or written
    const no = refusal(m);
    if (no) return Promise.reject(no);
    const cur = this.progress.get(id);
    if (cur && cur.state !== 'failed') return Promise.reject(new ModelError('already downloading', 'busy'));
    if (this.installed(m)) return Promise.resolve();
    const p: Progress = { state: 'downloading', received: 0, total: null };
    this.progress.set(id, p);
    return this.doInstall(m, p).then(
      () => {
        this.progress.delete(id);
      },
      (e: Error) => {
        p.state = 'failed';
        p.error = e.message;
        throw e;
      },
    );
  }

  private async doInstall(m: CatalogModel, p: Progress) {
    if (!/^https:\/\//.test(m.url)) throw new ModelError('model URLs must be https', 'bad_url');
    const no = refusal(m);
    if (no) throw no;
    const pin = m.sha256!.toLowerCase();
    const tmp = join(this.dir, `.tmp-${m.id}-${process.pid}-${Date.now()}`);
    const archive = `${tmp}.tar.bz2`;
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try {
      const res = await this.fetcher(m.url);
      if (!res.ok || !res.body)
        throw new ModelError(`download failed (HTTP ${res.status})`, 'download_failed');
      const len = Number(res.headers.get('content-length'));
      p.total = Number.isFinite(len) && len > 0 ? len : null;
      if (p.total && p.total > this.maxBytes) throw new ModelError('the download is too large', 'too_large');
      const hash = createHash('sha256');
      const out = createWriteStream(archive, { mode: 0o600 });
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          p.received += chunk.length;
          if (p.received > this.maxBytes) throw new ModelError('the download is too large', 'too_large');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        }
      } finally {
        await new Promise<void>((r) => out.end(r));
      }
      const got = hash.digest('hex');
      if (got !== pin) throw new ModelError('the download does not match its checksum', 'checksum_mismatch');
      p.state = 'unpacking';
      await untar(archive, tmp, this.maxUnpackedBytes);
      cleanTree(tmp);
      const ok = Object.values(m.files).every((f) => existsSync(join(tmp, m.root, f)));
      if (!ok) throw new ModelError('the archive does not hold the expected model files', 'bad_archive');
      rmSync(this.folder(m), { recursive: true, force: true });
      renameSync(tmp, this.folder(m));
    } finally {
      rmSync(archive, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** tar gets only these: no secret from the server's environment reaches it */
export function tarEnv(
  from: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // Windows: System32\tar.exe needs SystemRoot and a TEMP folder it can write
  return {
    ...windowsEnv(from, platform),
    PATH: from.PATH ?? (platform === 'win32' ? from.Path : undefined) ?? '/usr/bin:/bin',
    LANG: from.LANG ?? 'C',
  };
}

/** most files an archive may unpack to (inode exhaustion is a disk-full too) */
const MAX_UNPACKED_FILES = 20_000;

/** Bytes (apparent size) and entries under `root`, without following links. */
export function treeSize(root: string): { bytes: number; entries: number } {
  let bytes = 0;
  let entries = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      entries++;
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else bytes += st.size;
      } catch {
        // tar may be mid-write or the entry just went away
      }
    }
  };
  walk(root);
  return { bytes, entries };
}

/**
 * The system tar (bsdtar on macOS, GNU tar on Linux) refuses absolute and `..` member names by default. A bz2 archive
 * can expand far past its download cap, so the folder is measured while tar runs (and once more after it exits); past
 * `maxBytes` or MAX_UNPACKED_FILES tar is killed and the install refused (the caller removes the folder).
 */
function untar(archive: string, into: string, maxBytes: number): Promise<void> {
  return new Promise((ok, fail) => {
    const c = spawn('tar', ['-xjf', archive, '-C', into, '--no-same-owner'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: tarEnv(),
    });
    let err = '';
    let tooBig = false;
    const over = () => {
      const t = treeSize(into);
      return t.bytes > maxBytes || t.entries > MAX_UNPACKED_FILES;
    };
    const watch = setInterval(() => {
      if (!tooBig && over()) {
        tooBig = true;
        c.kill('SIGKILL');
      }
    }, 100);
    const tooLarge = () => new ModelError('the archive unpacks to more than allowed', 'too_large_unpacked');
    c.stderr.on('data', (d: Buffer) => {
      if (err.length < 2000) err += d.toString();
    });
    c.once('error', (e) => {
      clearInterval(watch);
      fail(new ModelError(`could not run tar: ${e.message}`, 'unpack_failed'));
    });
    c.once('exit', (code) => {
      clearInterval(watch);
      if (tooBig || over()) return fail(tooLarge());
      if (code === 0) return ok();
      fail(new ModelError(`unpacking failed: ${err.trim().slice(0, 300)}`, 'unpack_failed'));
    });
  });
}

/** Remove every symlink and special file, so nothing in the model folder can point outside it. */
export function cleanTree(root: string) {
  const base = resolve(root);
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(base, resolve(p));
      if (rel.startsWith(`..${sep}`) || rel === '..') continue;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (!st.isFile()) rmSync(p, { force: true });
    }
  };
  walk(base);
}
