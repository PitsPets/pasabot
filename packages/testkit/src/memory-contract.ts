/**
 * runMemoryContract: the suite every MemoryBackend must pass (ARCHITECTURE 5.5, 9). FakeMemoryBackend is the
 * reference implementation: in-memory, word-overlap scoring, newest first.
 */
import type {
  MemoryBackend,
  MemoryFilter,
  MemoryHit,
  MemoryInput,
  MemoryItem,
  MemoryQuery,
} from '@pasabot/core';
import { ulid } from '@pasabot/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Reference backend: keeps items in a Map; a forgotten item is removed. */
export class FakeMemoryBackend implements MemoryBackend {
  readonly id: string;
  private items = new Map<string, MemoryItem>();
  constructor(id = 'fake') {
    this.id = id;
  }
  async remember(m: MemoryInput): Promise<string> {
    const id = ulid();
    this.items.set(id, {
      id,
      agentId: m.agentId,
      text: m.text,
      tags: m.tags ?? [],
      source: m.source,
      ...(m.origin ? { origin: { ...m.origin } } : {}),
      createdAt: Date.now(),
    });
    return id;
  }
  async search(q: MemoryQuery): Promise<MemoryHit[]> {
    const want = words(q.text);
    const out: MemoryHit[] = [];
    for (const it of this.items.values()) {
      const mine = it.agentId === q.agentId;
      const shared = it.agentId === null && (q.includeShared ?? true);
      if (!mine && !shared) continue;
      const have = words(`${it.text} ${it.tags.join(' ')}`);
      let n = 0;
      for (const w of want) if (have.has(w)) n++;
      if (n > 0) out.push({ ...it, score: n / Math.max(1, want.size) });
    }
    return out.sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1)).slice(0, q.limit ?? 10);
  }
  async forget(id: string): Promise<void> {
    this.items.delete(id);
  }
  async list(f: MemoryFilter): Promise<MemoryItem[]> {
    return [...this.items.values()]
      .filter((i) => f.agentId === undefined || i.agentId === f.agentId)
      .filter((i) => !f.tag || i.tags.includes(f.tag))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, f.limit ?? 100);
  }
}

export interface MemoryContractSubject {
  backend: MemoryBackend;
  cleanup?(): void | Promise<void>;
}

/**
 * Semantics every backend keeps: an item belongs to one agent or is shared (`agentId: null`); a search sees the
 * agent's own items plus shared ones unless `includeShared` is false; a forgotten item never comes back from
 * search or list; `list` is newest first and filters by agent (null = shared only) and tag.
 */
export function runMemoryContract(
  name: string,
  make: () => MemoryContractSubject | Promise<MemoryContractSubject>,
) {
  describe(`memory contract: ${name}`, () => {
    let s: MemoryContractSubject;
    let b: MemoryBackend;
    beforeEach(async () => {
      s = await make();
      b = s.backend;
    });
    afterEach(async () => {
      await s.cleanup?.();
    });

    it('has an id and remembers an item it can list back', async () => {
      expect(b.id.length).toBeGreaterThan(0);
      const id = await b.remember({
        agentId: 'a1',
        text: 'Boss prefers tea over coffee',
        tags: ['prefs'],
        source: 'chat',
      });
      expect(typeof id).toBe('string');
      const all = await b.list({ agentId: 'a1' });
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id,
        agentId: 'a1',
        text: 'Boss prefers tea over coffee',
        tags: ['prefs'],
      });
      expect(all[0]!.createdAt).toBeGreaterThan(0);
    });

    it('keeps the origin (sender kind + trust) it was given and returns it from list and search', async () => {
      const id = await b.remember({
        agentId: 'a1',
        text: 'webhook said deploy on fridays',
        origin: { sender: 'webhook', trust: 'guarded' },
      });
      const plain = await b.remember({ agentId: 'a1', text: 'owner said deploy on mondays' });
      const listed = await b.list({ agentId: 'a1' });
      expect(listed.find((i) => i.id === id)!.origin).toEqual({ sender: 'webhook', trust: 'guarded' });
      expect(listed.find((i) => i.id === plain)!.origin).toBeUndefined();
      const hit = (await b.search({ agentId: 'a1', text: 'fridays' })).find((h) => h.id === id);
      expect(hit!.origin).toEqual({ sender: 'webhook', trust: 'guarded' });
    });

    it('keeps the sender id of the origin when given (a non-owner turn reads only its own sender’s items)', async () => {
      const id = await b.remember({
        agentId: 'a1',
        text: 'guest asked for a window seat',
        origin: { sender: 'guest', senderId: 'guest-1', trust: 'guarded' },
      });
      const listed = await b.list({ agentId: 'a1' });
      expect(listed.find((i) => i.id === id)!.origin).toEqual({
        sender: 'guest',
        senderId: 'guest-1',
        trust: 'guarded',
      });
    });

    it('search finds by word with a score and misses unrelated text', async () => {
      const id = await b.remember({ agentId: 'a1', text: 'The office wifi password lives in the vault' });
      await b.remember({ agentId: 'a1', text: 'Lunch is at noon' });
      const hits = await b.search({ agentId: 'a1', text: 'wifi' });
      expect(hits.map((h) => h.id)).toContain(id);
      expect(hits.find((h) => h.id === id)!.score).toBeGreaterThan(0);
      expect(hits.some((h) => h.text === 'Lunch is at noon')).toBe(false);
      expect(await b.search({ agentId: 'a1', text: 'zebra' })).toEqual([]);
    });

    it('keeps agents apart and shares shared items unless includeShared is false', async () => {
      const own = await b.remember({ agentId: 'a1', text: 'alpha project deadline friday' });
      const shared = await b.remember({ agentId: null, text: 'alpha project lives in the shared drive' });
      const other = await b.search({ agentId: 'a2', text: 'alpha' });
      expect(other.map((h) => h.id)).toEqual([shared]);
      const mine = await b.search({ agentId: 'a1', text: 'alpha' });
      expect(mine.map((h) => h.id).sort()).toEqual([own, shared].sort());
      const noShared = await b.search({ agentId: 'a1', text: 'alpha', includeShared: false });
      expect(noShared.map((h) => h.id)).toEqual([own]);
      expect((await b.list({ agentId: 'a2' })).length).toBe(0);
      expect((await b.list({ agentId: null })).map((i) => i.id)).toEqual([shared]);
    });

    it('forget removes the item from search and list, and forgetting twice is harmless', async () => {
      const id = await b.remember({ agentId: 'a1', text: 'gate code is on the fridge' });
      const keep = await b.remember({ agentId: 'a1', text: 'gate opens at six' });
      await b.forget(id);
      await b.forget(id);
      expect((await b.search({ agentId: 'a1', text: 'gate' })).map((h) => h.id)).toEqual([keep]);
      expect((await b.list({ agentId: 'a1' })).map((i) => i.id)).toEqual([keep]);
    });

    it('lists newest first, filters by tag and honours limits', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          await b.remember({
            agentId: 'a1',
            text: `note number ${i} about bikes`,
            tags: i % 2 ? ['odd'] : [],
          }),
        );
        await new Promise((r) => setTimeout(r, 2));
      }
      const listed = await b.list({ agentId: 'a1' });
      expect(listed.map((i) => i.id)).toEqual([...ids].reverse());
      expect((await b.list({ agentId: 'a1', limit: 2 })).map((i) => i.id)).toEqual([ids[4], ids[3]]);
      expect((await b.list({ agentId: 'a1', tag: 'odd' })).map((i) => i.id).sort()).toEqual(
        [ids[1], ids[3]].sort(),
      );
      expect((await b.search({ agentId: 'a1', text: 'bikes', limit: 3 })).length).toBe(3);
    });

    it('treats query syntax characters as plain text', async () => {
      await b.remember({ agentId: 'a1', text: `Juan's "quoted" note (with) AND/OR * stars` });
      for (const q of [`Juan's`, '"quoted', '(with)', 'AND', 'OR *', 'NEAR(', '-', '']) {
        await expect(b.search({ agentId: 'a1', text: q })).resolves.toBeInstanceOf(Array);
      }
      expect((await b.search({ agentId: 'a1', text: `"quoted"` })).length).toBe(1);
    });
  });
}
