/**
 * MemoryService: the limits, scope rules (W33: global, team, private) and conflict rule every backend gets, on top of
 * whichever MemoryBackend the owner picked (config `backend`, default `local`). Backends are looked up per call in
 * ModuleHost.memory; teams, provenance and the merge queue live in this module's own tables (`Pool`).
 */
import type {
  MemoryBackend,
  MemoryExportEntry,
  MemoryHit,
  MemoryItem,
  MemoryOrigin,
  ModuleHost,
} from '@pasabot/core';
import { type TrustLevel, trustLevelSchema } from '@pasabot/protocol';
import { z } from 'zod';
import {
  type Confidence,
  type MergeReason,
  type Meta,
  type Pool,
  type ScopeKey,
  type ScopeKind,
  scopeOf,
  TEAM_PREFIX,
  teamKey,
  type WriterKind,
} from './pool.js';

const TRUST_RANK: readonly TrustLevel[] = trustLevelSchema.options;
/** rank of a known trust level; an unknown one (never stored by this module) ranks below everything */
const rank = (t: TrustLevel) => TRUST_RANK.indexOf(t);
/** the lower of two levels; fails closed on a level outside the enum instead of letting it win */
function lowerTrust(a: unknown, b: TrustLevel): TrustLevel {
  const pa = trustLevelSchema.safeParse(a);
  if (!pa.success) throw new MemoryError('invalid', `unknown trust level ${JSON.stringify(a)}`);
  return rank(pa.data) <= rank(b) ? pa.data : b;
}

/**
 * Writes to one scope of one backend run one at a time (in this process): the cap check, the same-key lookup, the
 * backend write and the supersede/merge step are one unit, so two parallel writes of one key (parallel tool calls,
 * two team agents) cannot both see the old value, and parallel writes cannot push a scope past its cap.
 */
const chains = new Map<string, Promise<void>>();
function serial<T>(k: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(k) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(k, tail);
  void tail.then(() => {
    if (chains.get(k) === tail) chains.delete(k);
  });
  return run;
}
const lockKey = (backend: string, scopeKey: ScopeKey) => JSON.stringify([backend, scopeKey]);

export interface MemoryLimits {
  /** items one agent may keep (its own, not counting shared) */
  perAgent: number;
  /** shared items across all agents (global; also the cap of each team) */
  shared: number;
  /** characters per item */
  textChars: number;
  /** tags per item */
  tags: number;
  /** hits per search */
  searchHits: number;
}
export const DEFAULT_LIMITS: MemoryLimits = {
  perAgent: 500,
  shared: 1000,
  textChars: 2000,
  tags: 8,
  searchHits: 20,
};

/** Review screen page size (GET /items `limit` default). */
export const REVIEW_PAGE = 100;
/** Items one turn's prompt gets from memory. */
export const PROMPT_ITEMS = 8;

/** `owner` = saved during an owner turn; `others` = any other sender, or an origin that was never recorded. */
export type OriginFilter = 'owner' | 'others';
export const fromOwner = (i: { origin?: MemoryOrigin }) => i.origin?.sender === 'owner';

export class MemoryError extends Error {
  constructor(
    readonly code: 'full' | 'not_found' | 'backend_unavailable' | 'too_long' | 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export interface ReviewPage {
  items: (MemoryItem | MemoryHit)[];
  /** offset of the next page, or null when this page is the last */
  next: number | null;
}

/** One write, with provenance decided by the caller on the server side (never taken from the writer's input). */
export interface WriteInput {
  scopeKey: ScopeKey;
  text: string;
  tags?: string[];
  source?: string;
  origin?: MemoryOrigin;
  key?: string;
  confidence?: Confidence;
  writer: { kind: WriterKind; agentId: string | null };
  trust: TrustLevel;
}
export type WriteResult = { id: string } | { queued: string; reason: MergeReason };

/**
 * May a write by `o` replace (and so delete from the backend) the live entry `old`? Only the owner, or the same
 * writer at no lower trust: replacing the owner's, another agent's or an import's entry, or a higher-trust value, is
 * a delete outside the writer's own entries, so it waits for the owner instead (7.1 always-ask class; 7.4 trust).
 */
function mayReplace(old: Meta, o: Pick<WriteInput, 'writer' | 'trust'>): boolean {
  if (o.writer.kind === 'owner') return true;
  return (
    old.writer.kind === o.writer.kind &&
    old.writer.agentId === o.writer.agentId &&
    rank(old.trust) >= 0 &&
    rank(o.trust) >= rank(old.trust)
  );
}

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

export class MemoryService {
  constructor(
    private readonly host: Pick<ModuleHost, 'memory' | 'config' | 'redact' | 'agents'>,
    readonly pool: Pool,
  ) {}

  limits(): MemoryLimits {
    return { ...DEFAULT_LIMITS, ...this.host.config.get<Partial<MemoryLimits>>('limits', {}) };
  }
  activeId(): string {
    return this.host.config.get('backend', 'local');
  }
  backend(): MemoryBackend {
    const id = this.activeId();
    const b = this.host.memory.get(id);
    // never fall back to another store silently: memories written there would vanish when this one returns
    if (!b) throw new MemoryError('backend_unavailable', `memory backend "${id}" is not available`);
    return b;
  }

  // ---------- scopes ----------
  /** every scope `agentId` reads: its own, global, and each team it is in */
  visibleScopes(agentId: string): ScopeKey[] {
    return [agentId, null, ...this.pool.teamsOf(agentId).map((t) => teamKey(t.id))];
  }
  /** The scope an agent may write to, or `forbidden`: only its own, global, and teams it belongs to. */
  writableScope(agentId: string, kind: ScopeKind, team?: string): ScopeKey {
    if (kind === 'private') return agentId;
    if (kind === 'global') return null;
    const t = team ? this.pool.teamByName(team) : undefined;
    if (!t?.members.includes(agentId))
      throw new MemoryError('forbidden', `this agent is not in a team called "${team ?? ''}"`);
    return teamKey(t.id);
  }
  capFor(scopeKey: ScopeKey) {
    const lim = this.limits();
    return scopeOf(scopeKey).kind === 'private' ? lim.perAgent : lim.shared;
  }

  // ---------- writes ----------
  /**
   * Save one entry. With a `key`: the latest value for that key in that scope wins and the older one is superseded,
   * except (a) when both the live value and the new one are high confidence and differ, or (b) when the live value
   * may not be replaced by this writer (`mayReplace`: it was written by the owner, another writer, or at a higher
   * trust). Then the new one waits in the owner's merge queue (it is not stored in any backend until the owner picks).
   * Writes to one scope are serialised (`serial`).
   */
  async write(o: WriteInput): Promise<WriteResult> {
    const lim = this.limits();
    if (o.text.length > lim.textChars)
      throw new MemoryError('too_long', `memory text is limited to ${lim.textChars} characters`);
    const b = this.backend();
    return serial(lockKey(b.id, o.scopeKey), () => this.writeLocked(b, o));
  }

  /** `write` without the lock; `deferred` (import) collects supersedes to run only after the whole batch is stored */
  private async writeLocked(
    b: MemoryBackend,
    o: WriteInput,
    deferred?: { oldId: string; newId: string }[],
  ): Promise<WriteResult> {
    const lim = this.limits();
    if (o.text.length > lim.textChars)
      throw new MemoryError('too_long', `memory text is limited to ${lim.textChars} characters`);
    const bid = b.id;
    const cap = this.capFor(o.scopeKey);
    const have = await b.list({ agentId: o.scopeKey, limit: cap });
    if (have.length >= cap)
      throw new MemoryError(
        'full',
        `${o.scopeKey === null ? 'shared memory' : o.scopeKey.startsWith(TEAM_PREFIX) ? 'this team’s memory' : 'this agent’s memory'} is full (${cap} items); forget something first`,
      );
    // 7.3: nothing a backend stores (and Hindsight sends to another machine) may carry a known secret value
    const tags = [...new Set((o.tags ?? []).map((t) => this.host.redact(t.trim())).filter(Boolean))].slice(
      0,
      lim.tags,
    );
    const text = this.host.redact(o.text);
    const key = o.key?.trim().toLowerCase() || undefined;
    const live = key ? this.pool.liveByKey(bid, o.scopeKey, key) : [];
    const cur = live[0];
    if (cur) {
      const curItem = have.find((i) => i.id === cur.itemId);
      const same = !!curItem && norm(curItem.text) === norm(text);
      const protectedEntry = !live.every((m) => mayReplace(m, o));
      // the same value again from a writer that may not replace the entry: nothing new to store, the entry stays
      if (protectedEntry && same) return { id: cur.itemId };
      const conflict = cur.confidence === 'high' && o.confidence === 'high' && !!curItem && !same;
      if (protectedEntry || conflict) {
        const reason: MergeReason = protectedEntry ? 'protected' : 'conflict';
        const queued = this.pool.queueMerge({
          reason,
          backend: bid,
          scopeKey: o.scopeKey,
          key: key!,
          currentId: cur.itemId,
          incoming: {
            text,
            tags,
            source: o.source ?? null,
            writer: o.writer,
            trust: o.trust,
            confidence: o.confidence ?? null,
            originSender: o.origin?.sender ?? null,
            originSenderId: o.origin?.senderId ?? null,
          },
        });
        return { queued, reason };
      }
    }
    const id = await b.remember({
      agentId: o.scopeKey,
      text,
      tags,
      ...(o.source ? { source: o.source } : {}),
      ...(o.origin ? { origin: o.origin } : {}),
    });
    this.pool.addMeta({
      backend: bid,
      itemId: id,
      scopeKey: o.scopeKey,
      key: key ?? null,
      confidence: o.confidence ?? null,
      writer: o.writer,
      trust: o.trust,
      createdAt: Date.now(),
    });
    const replaced = live.filter((old) => old.itemId !== id);
    if (deferred) deferred.push(...replaced.map((m) => ({ oldId: m.itemId, newId: id })));
    else for (const old of replaced) await this.supersede(b, old.itemId, id);
    return { id };
  }

  private async supersede(b: MemoryBackend, oldId: string, newId: string) {
    await b.forget(oldId);
    this.pool.setState(b.id, oldId, 'superseded');
    // an open merge compared against the old value now compares against the one that replaced it
    for (const mg of this.pool.mergesFor(b.id, oldId)) this.pool.retarget(mg.id, newId);
  }

  /** W10 compatibility: own memory, or global with `shared` (writer = the agent, trust = the turn's). */
  async remember(
    agentId: string,
    o: { text: string; tags?: string[]; shared?: boolean; source?: string; origin?: MemoryOrigin },
  ): Promise<string> {
    const r = await this.write({
      scopeKey: o.shared ? null : agentId,
      text: o.text,
      tags: o.tags,
      source: o.source,
      origin: o.origin,
      writer: { kind: 'agent', agentId },
      trust: o.origin?.trust ?? 'guarded',
    });
    return 'id' in r ? r.id : r.queued;
  }

  // ---------- reads ----------
  /** Search every scope `agentId` reads (own, global, its teams); W10 `includeShared: false` = own scope only. */
  async search(agentId: string, text: string, o: { limit?: number; includeShared?: boolean } = {}) {
    const lim = this.limits();
    const limit = Math.min(o.limit ?? 10, lim.searchHits);
    const b = this.backend();
    const includeShared = o.includeShared ?? true;
    const teams = includeShared ? this.pool.teamsOf(agentId).map((t) => teamKey(t.id)) : [];
    const per = await Promise.all([
      b.search({ agentId, text, limit, includeShared }),
      ...teams.map((k) => b.search({ agentId: k, text, limit, includeShared: false })),
    ]);
    const seen = new Set<string>();
    return per
      .flat()
      .filter((h) => !seen.has(h.id) && seen.add(h.id))
      .sort((x, y) => y.score - x.score || (x.id < y.id ? 1 : -1))
      .slice(0, limit);
  }

  /** The live item with this id in any scope (null when there is none). */
  async findById(id: string): Promise<MemoryItem | null> {
    const b = this.backend();
    const m = this.pool.meta(b.id, id);
    const items = await b.list(
      m ? { agentId: m.scopeKey, limit: this.capFor(m.scopeKey) } : { limit: 1_000_000 },
    );
    return items.find((i) => i.id === id) ?? null;
  }

  /** The item if `agentId` may see it in `scopeKey` (one of its visible scopes); null otherwise. */
  async findVisible(agentId: string, id: string, scopeKey: ScopeKey): Promise<MemoryItem | null> {
    if (!this.visibleScopes(agentId).includes(scopeKey)) return null;
    const items = await this.backend().list({ agentId: scopeKey, limit: this.capFor(scopeKey) });
    return items.find((i) => i.id === id) ?? null;
  }

  /** An agent forgets one item of a scope it belongs to (the tool asks first: tier 3). */
  async forgetFor(agentId: string, id: string, scopeKey: ScopeKey) {
    const item = await this.findVisible(agentId, id, scopeKey);
    if (!item) throw new MemoryError('not_found', 'no such memory');
    await this.delete(id);
  }

  /**
   * Owner review: a page of items by scope ('all', 'shared', an agent id or `team-<id>`), optionally narrowed by a
   * search and by origin. Every item of every scope is reachable by paging; a search runs in each scope through the
   * backend's own search, so nothing is missed because it is older than some cap.
   */
  async review(
    scope: string,
    o: { q?: string; origin?: OriginFilter; offset?: number; limit?: number } = {},
  ): Promise<ReviewPage> {
    const b = this.backend();
    const offset = Math.max(0, o.offset ?? 0);
    const limit = Math.max(1, o.limit ?? REVIEW_PAGE);
    const agentId = scope === 'all' ? undefined : scope === 'shared' ? null : scope;
    const keep = (i: MemoryItem) => !o.origin || (o.origin === 'owner') === fromOwner(i);
    const want = offset + limit + 1; // one extra tells whether a next page exists
    const q = o.q?.trim();

    let found: (MemoryItem | MemoryHit)[] = [];
    // fetch more until `want` items pass the origin filter, or the backend has no more to give
    for (let n = want; ; n *= 2) {
      let got: (MemoryItem | MemoryHit)[];
      let exhausted: boolean;
      if (q) {
        const scopes: (string | null)[] =
          agentId === undefined
            ? [
                null,
                ...(await this.host.agents.list()).map((a) => a.id),
                ...this.pool.teams().map((t) => teamKey(t.id)),
              ]
            : [agentId];
        const per = await Promise.all(
          scopes.map((s) => b.search({ agentId: s, text: q, limit: n, includeShared: false })),
        );
        exhausted = per.every((hits) => hits.length < n);
        const seen = new Set<string>();
        got = per
          .flat()
          .filter((h) => !seen.has(h.id) && seen.add(h.id))
          .sort((x, y) => y.score - x.score || (x.id < y.id ? 1 : -1));
      } else {
        got = await b.list(agentId === undefined ? { limit: n } : { agentId, limit: n });
        exhausted = got.length < n;
      }
      found = got.filter(keep);
      // the size guard only matters for a backend that ignores `limit`; real stores are far smaller
      if (found.length >= want || exhausted || n >= 1_000_000) break;
    }
    return {
      items: found.slice(offset, offset + limit),
      next: found.length > offset + limit ? offset + limit : null,
    };
  }

  // ---------- owner changes ----------
  /** Delete everywhere this module knows: the backend (plugin or local), its provenance row (state `deleted`). */
  async delete(id: string) {
    const b = this.backend();
    await b.forget(id);
    if (this.pool.meta(b.id, id)) this.pool.setState(b.id, id, 'deleted');
  }
  /** W10 name for an owner delete */
  async forget(id: string) {
    await this.delete(id);
  }

  /**
   * Owner edit: the backend has no update, so the old entry is deleted and the new text saved in the same scope with
   * the same key and confidence; the owner becomes the writer. Open merges against the old entry follow the new one.
   */
  async edit(id: string, o: { text: string; tags?: string[] }): Promise<string> {
    const b = this.backend();
    const found = await this.findById(id);
    if (!found) throw new MemoryError('not_found', 'no such memory');
    return serial(lockKey(b.id, found.agentId), () => this.editLocked(b, id, o));
  }
  private async editLocked(b: MemoryBackend, id: string, o: { text: string; tags?: string[] }) {
    // read again under the scope's lock: a parallel write may have superseded it meanwhile
    const item = await this.findById(id);
    if (!item) throw new MemoryError('not_found', 'no such memory');
    const m = this.pool.meta(b.id, id);
    const lim = this.limits();
    if (o.text.length > lim.textChars)
      throw new MemoryError('too_long', `memory text is limited to ${lim.textChars} characters`);
    const tags = [
      ...new Set((o.tags ?? item.tags).map((t) => this.host.redact(t.trim())).filter(Boolean)),
    ].slice(0, lim.tags);
    const newId = await b.remember({
      agentId: item.agentId,
      text: this.host.redact(o.text),
      tags,
      ...(item.source ? { source: item.source } : {}),
      origin: { sender: 'owner', trust: 'trusted' },
    });
    this.pool.addMeta({
      backend: b.id,
      itemId: newId,
      scopeKey: item.agentId,
      key: m?.key ?? null,
      confidence: m?.confidence ?? null,
      writer: { kind: 'owner', agentId: null },
      trust: 'trusted',
      createdAt: Date.now(),
    });
    await b.forget(id);
    if (m) this.pool.setState(b.id, id, 'deleted');
    for (const mg of this.pool.mergesFor(b.id, id)) this.pool.retarget(mg.id, newId);
    return newId;
  }

  /**
   * Settle a merge entry: keep the current value (the incoming one is dropped), keep the incoming one (it replaces
   * the current), or save the owner's merged text (owner-written, replaces the current).
   */
  async resolve(mergeId: string, keep: 'current' | 'incoming' | 'merged', text?: string) {
    const first = this.pool.openMerge(mergeId);
    if (!first) throw new MemoryError('not_found', 'no such merge entry');
    const b = this.backend();
    return serial(lockKey(b.id, first.scopeKey), () => this.resolveLocked(b, mergeId, keep, text));
  }
  private async resolveLocked(
    b: MemoryBackend,
    mergeId: string,
    keep: 'current' | 'incoming' | 'merged',
    text?: string,
  ) {
    const mg = this.pool.openMerge(mergeId);
    if (!mg) throw new MemoryError('not_found', 'no such merge entry');
    if (mg.backend !== b.id)
      throw new MemoryError('backend_unavailable', 'this entry belongs to another backend');
    if (keep === 'current') {
      this.pool.resolveMerge(mergeId, 'kept current');
      return { kept: mg.currentId };
    }
    if (keep === 'merged' && !text?.trim()) throw new MemoryError('too_long', 'write the merged text first');
    // every live value of this key in this scope is replaced (not only the one the entry was queued against)
    const live = this.pool.liveByKey(b.id, mg.scopeKey, mg.key);
    const newId = await b.remember({
      agentId: mg.scopeKey,
      text: this.host.redact(keep === 'merged' ? text!.trim() : mg.incoming.text),
      tags: mg.incoming.tags,
      ...(mg.incoming.source ? { source: mg.incoming.source } : {}),
      origin:
        keep === 'merged'
          ? { sender: 'owner', trust: 'trusted' }
          : {
              sender: (mg.incoming.originSender ?? 'system') as MemoryOrigin['sender'],
              senderId: mg.incoming.originSenderId ?? null,
              trust: mg.incoming.trust,
            },
    });
    this.pool.addMeta({
      backend: b.id,
      itemId: newId,
      scopeKey: mg.scopeKey,
      key: mg.key,
      // the owner's own answer is taken as sure; a kept incoming value keeps the confidence it was written with
      confidence: keep === 'merged' ? 'high' : mg.incoming.confidence,
      writer: keep === 'merged' ? { kind: 'owner', agentId: null } : mg.incoming.writer,
      trust: keep === 'merged' ? 'trusted' : mg.incoming.trust,
      createdAt: Date.now(),
    });
    for (const old of live) {
      await b.forget(old.itemId);
      this.pool.setState(b.id, old.itemId, 'superseded');
    }
    if (!live.some((m) => m.itemId === mg.currentId)) await b.forget(mg.currentId);
    this.pool.resolveMerge(mergeId, keep === 'merged' ? 'merged' : 'kept incoming');
    return { kept: newId };
  }

  /** The owner deleted a team: its entries are deleted everywhere, its open merges dropped. */
  async deleteTeam(teamId: string) {
    const k = teamKey(teamId);
    const b = this.backend();
    for (const i of await b.list({ agentId: k, limit: 1_000_000 })) await this.delete(i.id);
    this.pool.dropMergesIn(k);
    return this.pool.deleteTeam(teamId);
  }

  // ---------- W32 export port ----------
  async exportAgent(agentId: string): Promise<MemoryExportEntry[]> {
    const b = this.backend();
    const items = await b.list({ agentId, limit: this.limits().perAgent });
    const metas = this.pool.metas(
      b.id,
      items.map((i) => i.id),
    );
    return items.map((i) => {
      const m = metas.get(i.id);
      return {
        text: this.host.redact(i.text),
        tags: i.tags.map((t) => this.host.redact(t)),
        ...(m?.key ? { key: m.key } : {}),
        ...(m?.confidence ? { confidence: m.confidence } : {}),
        ...(i.source ? { source: i.source } : {}),
        writer: { kind: m?.writer.kind ?? (fromOwner(i) ? 'owner' : 'agent') },
        trust: m?.trust ?? i.origin?.trust ?? 'guarded',
        createdAt: i.createdAt,
      };
    });
  }
  /**
   * W32 import into one agent's private scope, all or nothing: every entry is checked first (an unknown trust level,
   * an over-long text, bad tags, a full scope: nothing is written), then all are written under the scope's lock;
   * supersedes run only once every entry is stored, and a failure part-way removes what this import wrote. Returns
   * the number of entries stored (a same-key conflict inside the bundle waits in the merge queue and is not counted).
   */
  async importAgent(agentId: string, entries: unknown, maxTrust: TrustLevel): Promise<number> {
    const lim = this.limits();
    const cap = trustLevelSchema.safeParse(maxTrust);
    if (!cap.success) throw new MemoryError('invalid', 'unknown import trust cap');
    const entry = z.object({
      text: z.string().min(1).max(lim.textChars),
      tags: z.array(z.string().min(1).max(32)).max(lim.tags),
      key: z.string().min(1).max(80).optional(),
      confidence: z.enum(['low', 'high']).optional(),
      source: z.string().max(500).optional(),
      writer: z.object({ kind: z.enum(['owner', 'agent', 'import']) }),
      trust: trustLevelSchema,
      createdAt: z.number().finite(),
    });
    const parsed = z.array(entry).safeParse(entries);
    if (!parsed.success)
      throw new MemoryError(
        'invalid',
        `memory entries are not valid: ${parsed.error.issues[0]?.message ?? ''}`,
      );
    const list: MemoryExportEntry[] = parsed.data;
    const b = this.backend();
    return serial(lockKey(b.id, agentId), async () => {
      const have = await b.list({ agentId, limit: lim.perAgent });
      if (have.length + list.length > lim.perAgent)
        throw new MemoryError(
          'full',
          `this agent’s memory can hold ${lim.perAgent} items; the import has ${list.length} and ${have.length} are saved`,
        );
      const written: string[] = [];
      const queued: string[] = [];
      const deferred: { oldId: string; newId: string }[] = [];
      try {
        for (const e of list) {
          const trust = lowerTrust(e.trust, cap.data);
          const r = await this.writeLocked(
            b,
            {
              scopeKey: agentId,
              text: e.text,
              tags: e.tags,
              ...(e.source ? { source: e.source } : {}),
              origin: { sender: 'system', trust },
              ...(e.key ? { key: e.key } : {}),
              ...(e.confidence ? { confidence: e.confidence } : {}),
              writer: { kind: 'import', agentId: null },
              trust,
            },
            deferred,
          );
          if ('id' in r) {
            if (!written.includes(r.id) && !have.some((i) => i.id === r.id)) written.push(r.id);
          } else queued.push(r.queued);
        }
      } catch (err) {
        for (const id of written.reverse()) {
          await b.forget(id).catch(() => undefined);
          this.pool.setState(b.id, id, 'deleted');
        }
        for (const q of queued) this.pool.discardMerge(q);
        throw err;
      }
      const done = new Set<string>();
      for (const d of deferred) {
        if (done.has(d.oldId)) continue;
        done.add(d.oldId);
        await this.supersede(b, d.oldId, d.newId);
      }
      return written.filter((id) => !done.has(id)).length;
    });
  }

  metaOf(id: string): Meta | undefined {
    return this.pool.meta(this.activeId(), id);
  }
}
