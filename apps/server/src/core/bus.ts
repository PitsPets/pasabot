/** Event bus + the persisted `events` ring used for WebSocket resume (ARCHITECTURE.md 4.2). */
import type { BusEvent, EventBus } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { EventMap, EventType, LiveType, Topic } from '@pasabot/protocol';

export interface StoredEvent {
  seq: number;
  topic: Topic;
  type: string;
  data: unknown;
  created_at: number;
}

export class EventStore {
  private insert;
  private sinceStmt;
  constructor(
    private readonly db: Sqlite,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare('INSERT INTO events (topic, type, data, created_at) VALUES (?, ?, ?, ?)');
    this.sinceStmt = db.prepare(
      'SELECT seq, topic, type, data, created_at FROM events WHERE seq > ? AND topic IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT ?',
    );
  }
  append(topic: Topic, type: string, data: unknown): number {
    return Number(this.insert.run(topic, type, JSON.stringify(data ?? null), this.now()).lastInsertRowid);
  }
  /** Highest seq ever issued (survives pruning: AUTOINCREMENT never reuses numbers). */
  lastSeq(): number {
    const r = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
      | { seq: number }
      | undefined;
    return r?.seq ?? 0;
  }
  oldestSeq(): number | null {
    const r = this.db.prepare('SELECT min(seq) AS s FROM events').get() as { s: number | null };
    return r.s;
  }
  /** Can a client that last saw `from` be brought up to date from the ring? */
  canResume(from: number): boolean {
    const last = this.lastSeq();
    if (from > last) return false; // seq from another server or a wiped db
    if (from === last) return true;
    const oldest = this.oldestSeq();
    return oldest !== null && from + 1 >= oldest;
  }
  /** Events after `from` on `topics` (filtered in SQL), oldest first, at most `limit` rows. */
  since(from: number, topics: ReadonlySet<string>, limit = 10_000): StoredEvent[] {
    if (topics.size === 0 || limit <= 0) return [];
    const rows = this.sinceStmt.all(from, JSON.stringify([...topics]), limit) as (Omit<
      StoredEvent,
      'data'
    > & {
      data: string;
    })[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as unknown }));
  }
  /** Keep the ring to `maxAgeMs` and `maxRows` (defaults: 7 days / 100k rows). Returns rows deleted. */
  prune(opts: { maxAgeMs?: number; maxRows?: number } = {}): number {
    const maxAge = opts.maxAgeMs ?? 7 * 24 * 3600_000;
    const maxRows = opts.maxRows ?? 100_000;
    let n = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(this.now() - maxAge).changes;
    const last = this.lastSeq();
    n += this.db.prepare('DELETE FROM events WHERE seq <= ?').run(last - maxRows).changes;
    return n;
  }
}

export class Bus implements EventBus {
  private listeners = new Set<(ev: BusEvent) => void>();
  constructor(readonly store: EventStore) {}
  publish<K extends EventType>(topic: Topic, type: K, data: EventMap[K]): number {
    const seq = this.store.append(topic, type, data);
    this.emit({ seq, topic, type, data });
    return seq;
  }
  live(topic: Topic, type: LiveType, data: unknown): void {
    this.emit({ topic, type, data, live: true });
  }
  subscribe(listener: (ev: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(ev: BusEvent) {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // a broken listener must not break publishing
      }
    }
  }
}
