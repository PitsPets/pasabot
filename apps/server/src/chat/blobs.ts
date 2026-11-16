/** Content-addressed BlobStore: bytes under `blobs/ab/cd/<sha256>`, a `blobs` row with a refcount. */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobMeta, BlobRef, BlobStore } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';

export class FsBlobStore implements BlobStore {
  constructor(
    private readonly db: Sqlite,
    private readonly dir: string,
    private readonly maxBytes = 100 * 1024 * 1024,
  ) {}
  private pathOf(sha: string) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad blob id');
    return join(this.dir, sha.slice(0, 2), sha.slice(2, 4), sha);
  }
  async put(stream: Readable, meta: BlobMeta): Promise<BlobRef> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.tmp-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    let size = 0;
    const max = this.maxBytes;
    try {
      await pipeline(
        stream,
        async function* (src) {
          for await (const c of src) {
            size += (c as Buffer).length;
            if (size > max) throw Object.assign(new Error('blob too large'), { code: 'too_large' });
            hash.update(c as Buffer);
            yield c;
          }
        },
        createWriteStream(tmp, { mode: 0o600 }),
      );
      const sha = hash.digest('hex');
      const dest = this.pathOf(sha);
      mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 });
      if (existsSync(dest)) rmSync(tmp);
      else renameSync(tmp, dest);
      this.db
        .prepare(
          'INSERT INTO blobs (sha256, size, refcount, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(sha256) DO UPDATE SET refcount = refcount + 1',
        )
        .run(sha, size, Date.now());
      if (meta.uploadedBy)
        this.db
          .prepare('INSERT OR IGNORE INTO blob_uploads (sha256, user_id, created_at) VALUES (?, ?, ?)')
          .run(sha, meta.uploadedBy, Date.now());
      return { sha256: sha, size };
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  open(sha: string): Readable {
    return createReadStream(this.pathOf(sha));
  }
  async stat(sha: string): Promise<BlobMeta | null> {
    const r = this.db.prepare('SELECT sha256, size FROM blobs WHERE sha256 = ?').get(sha) as
      | { sha256: string; size: number }
      | undefined;
    return r ? { sha256: r.sha256, size: r.size } : null;
  }
}
