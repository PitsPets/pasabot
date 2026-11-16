/** The default MemoryBackend: rows in `memory_item`, full-text search through the FTS5 index `memory_fts`. */
import type {
  MemoryBackend,
  MemoryFilter,
  MemoryHit,
  MemoryInput,
  MemoryItem,
  MemoryOrigin,
  MemoryQuery,
  ModuleHost,
} from '@pasabot/core';
import { ulid } from '@pasabot/core';

type Row = {
  id: string;
  agent_id: string | null;
  text: string;
  tags: string;
  source: string | null;
  created_at: number;
  reviewed_at: number | null;
  origin_sender: string | null;
  origin_sender_id: string | null;
  origin_trust: string | null;
};

export interface LocalMemoryItem extends MemoryItem {
  reviewedAt: number | null;
}

const toItem = (r: Row): LocalMemoryItem => ({
  id: r.id,
  agentId: r.agent_id,
  text: r.text,
  tags: JSON.parse(r.tags) as string[],
  ...(r.source ? { source: r.source } : {}),
  ...(r.origin_sender && r.origin_trust
    ? {
        origin: {
          sender: r.origin_sender as MemoryOrigin['sender'],
          ...(r.origin_sender_id ? { senderId: r.origin_sender_id } : {}),
          trust: r.origin_trust as MemoryOrigin['trust'],
        },
      }
    : {}),
  createdAt: r.created_at,
  reviewedAt: r.reviewed_at,
});

/**
 * Turn free text into an FTS5 query that cannot use FTS syntax: every word becomes a quoted term and the terms
 * are OR-ed, so `AND`, `NEAR(`, `*`, quotes and parentheses in the input are plain words or dropped.
 */
export function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const uniq = [...new Set(words)].slice(0, 32);
  return uniq.length ? uniq.map((w) => `"${w}"`).join(' OR ') : null;
}

export class LocalMemoryBackend implements MemoryBackend {
  readonly id = 'local';
  constructor(private readonly raw: ModuleHost['raw']) {}

  async remember(m: MemoryInput): Promise<string> {
    const id = ulid();
    this.raw
      .prepare(
        `INSERT INTO memory_item (id, agent_id, text, tags, source, origin_sender, origin_sender_id, origin_trust,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.agentId,
        m.text,
        JSON.stringify(m.tags ?? []),
        m.source ?? null,
        m.origin?.sender ?? null,
        m.origin?.senderId ?? null,
        m.origin?.trust ?? null,
        Date.now(),
      );
    return id;
  }

  async search(q: MemoryQuery): Promise<MemoryHit[]> {
    const match = ftsQuery(q.text);
    if (!match) return [];
    const shared = (q.includeShared ?? true) ? 1 : 0;
    const rows = this.raw
      .prepare(
        `SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts JOIN memory_item m ON m.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ? AND m.forgotten_at IS NULL AND (m.agent_id IS ? OR (m.agent_id IS NULL AND ?))
         ORDER BY rank, m.id DESC LIMIT ?`,
      )
      .all(match, q.agentId, shared, q.limit ?? 10) as (Row & { rank: number })[];
    // bm25 is lower-is-better and negative; flip it so a higher score is a better hit
    return rows.map((r) => ({ ...toItem(r), score: -r.rank }));
  }

  async forget(id: string): Promise<void> {
    this.raw
      .prepare(
        "UPDATE memory_item SET text = '', tags = '[]', source = NULL, forgotten_at = ? WHERE id = ? AND forgotten_at IS NULL",
      )
      .run(Date.now(), id);
  }

  async list(f: MemoryFilter): Promise<LocalMemoryItem[]> {
    const where = ['forgotten_at IS NULL'];
    const args: unknown[] = [];
    if (f.agentId !== undefined) {
      where.push('agent_id IS ?');
      args.push(f.agentId);
    }
    if (f.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(memory_item.tags) WHERE value = ?)');
      args.push(f.tag);
    }
    args.push(f.limit ?? 100);
    const rows = this.raw
      .prepare(`SELECT * FROM memory_item WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args) as Row[];
    return rows.map(toItem);
  }

  /** Local only: the owner marked the item as looked at on the review screen. */
  markReviewed(id: string): boolean {
    return (
      this.raw
        .prepare('UPDATE memory_item SET reviewed_at = ? WHERE id = ? AND forgotten_at IS NULL')
        .run(Date.now(), id).changes > 0
    );
  }
}
