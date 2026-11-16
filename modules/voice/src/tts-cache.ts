/**
 * Spoken replies, cached on disk in a folder the voice module owns, by voice + text hash. Least recently used files
 * are deleted once the folder passes `maxBytes`, so the cache never grows without bound; it survives a restart (the
 * index is rebuilt from the folder, oldest first by modification time, and a hit touches the file).
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const NAME = /^[0-9a-f]{64}\.wav$/;

export class TtsCache {
  /** key -> size, in least-recently-used-first order */
  private index = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly dir: string,
    readonly maxBytes = 50 * 1024 * 1024,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const found: { key: string; size: number; at: number }[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!NAME.test(name)) {
        // a half-written temp file from a crash, or anything else: not ours to keep
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      try {
        const st = statSync(p);
        if (st.isFile()) found.push({ key: name.slice(0, 64), size: st.size, at: st.mtimeMs });
      } catch {}
    }
    found.sort((a, b) => a.at - b.at);
    for (const f of found) {
      this.index.set(f.key, f.size);
      this.total += f.size;
    }
    this.evict();
  }

  /** bytes on disk */
  get size() {
    return this.total;
  }
  get count() {
    return this.index.size;
  }

  private path(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('bad cache key');
    return join(this.dir, `${key}.wav`);
  }

  get(key: string): Buffer | null {
    const size = this.index.get(key);
    if (size === undefined) return null;
    const p = this.path(key);
    try {
      const buf = readFileSync(p);
      const now = new Date();
      utimesSync(p, now, now);
      this.index.delete(key);
      this.index.set(key, size);
      return buf;
    } catch {
      this.drop(key);
      return null;
    }
  }

  put(key: string, wav: Buffer) {
    if (wav.length > this.maxBytes) return;
    const p = this.path(key);
    const tmp = join(this.dir, `.tmp-${key}-${process.pid}`);
    writeFileSync(tmp, wav, { mode: 0o600 });
    renameSync(tmp, p);
    const old = this.index.get(key);
    if (old !== undefined) this.total -= old;
    this.index.delete(key);
    this.index.set(key, wav.length);
    this.total += wav.length;
    this.evict();
  }

  private drop(key: string) {
    const size = this.index.get(key);
    if (size === undefined) return;
    this.index.delete(key);
    this.total -= size;
    rmSync(this.path(key), { force: true });
  }

  private evict() {
    while (this.total > this.maxBytes) {
      const oldest = this.index.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }
}
