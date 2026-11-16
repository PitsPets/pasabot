/**
 * W33 pool bookkeeping kept by this module whichever backend holds the text: teams (named groups of agents),
 * provenance + conflict data per item (`memory_meta`) and the owner's merge queue (`memory_merge`).
 */
import type { ModuleHost } from '@pasabot/core';
import { ulid } from '@pasabot/core';
import type { TrustLevel } from '@pasabot/protocol';

export type ScopeKind = 'private' | 'global' | 'team';
export type Confidence = 'low' | 'high';
export type WriterKind = 'owner' | 'agent' | 'import';

/**
 * A scope as the backend sees it (`MemoryInput.agentId`): null = global, agent id = private, `team-<id>` = team.
 * The team key stays inside `[A-Za-z0-9_-]` because plugin backends take `agentId` as a bank/path name and refuse
 * anything else (Hindsight: /^[A-Za-z0-9_-]{1,128}$/); agent ids are ULIDs, so `team-` never clashes with one.
 */
export type ScopeKey = string | null;
export const TEAM_PREFIX = 'team-';
/** what every backend accepts as an `agentId` (the strictest one shipped: the Hindsight plugin) */
export const BACKEND_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const teamKey = (teamId: string) => `${TEAM_PREFIX}${teamId}`;
export function scopeOf(k: ScopeKey): { kind: ScopeKind; teamId?: string; agentId?: string } {
  if (k === null) return { kind: 'global' };
  if (k.startsWith(TEAM_PREFIX)) return { kind: 'team', teamId: k.slice(TEAM_PREFIX.length) };
  return { kind: 'private', agentId: k };
}

export interface Team {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
}

export interface Meta {
  backend: string;
  itemId: string;
  scopeKey: ScopeKey;
  key: string | null;
  confidence: Confidence | null;
  writer: { kind: WriterKind; agentId: string | null };
  trust: TrustLevel;
  createdAt: number;
  state: 'live' | 'superseded' | 'deleted';
}

type MetaRow = {
  backend: string;
  item_id: string;
  scope_key: string | null;
  key: string | null;
  confidence: Confidence | null;
  writer_kind: WriterKind;
  writer_agent_id: string | null;
  writer_trust: TrustLevel;
  created_at: number;
  state: Meta['state'];
};
const toMeta = (r: MetaRow): Meta => ({
  backend: r.backend,
  itemId: r.item_id,
  scopeKey: r.scope_key,
  key: r.key,
  confidence: r.confidence,
  writer: { kind: r.writer_kind, agentId: r.writer_agent_id },
  trust: r.writer_trust,
  createdAt: r.created_at,
  state: r.state,
});

/**
 * Why an entry waits for the owner: `conflict` = two differing high-confidence values; `protected` = the new value
 * would replace one written by the owner, by another writer, or at a higher trust (that replace is a delete of
 * someone else's entry, so only the owner may make it).
 */
export type MergeReason = 'conflict' | 'protected';

export interface MergeEntry {
  id: string;
  reason: MergeReason;
  backend: string;
  scopeKey: ScopeKey;
  key: string;
  currentId: string;
  incoming: {
    text: string;
    tags: string[];
    source: string | null;
    writer: { kind: WriterKind; agentId: string | null };
    trust: TrustLevel;
    confidence: Confidence | null;
    originSender: string | null;
    /** the sender's id on that turn (null: unknown, owner turns only) */
    originSenderId?: string | null;
  };
  createdAt: number;
}
type MergeRow = {
  id: string;
  backend: string;
  scope_key: string | null;
  key: string;
  current_id: string;
  incoming_text: string;
  incoming_tags: string;
  incoming_source: string | null;
  writer_kind: WriterKind;
  writer_agent_id: string | null;
  writer_trust: TrustLevel;
  origin_sender: string | null;
  origin_sender_id: string | null;
  incoming_confidence: Confidence | null;
  reason: MergeReason;
  created_at: number;
};
const toMerge = (r: MergeRow): MergeEntry => ({
  id: r.id,
  reason: r.reason,
  backend: r.backend,
  scopeKey: r.scope_key,
  key: r.key,
  currentId: r.current_id,
  incoming: {
    text: r.incoming_text,
    tags: JSON.parse(r.incoming_tags) as string[],
    source: r.incoming_source,
    writer: { kind: r.writer_kind, agentId: r.writer_agent_id },
    trust: r.writer_trust,
    confidence: r.incoming_confidence,
    originSender: r.origin_sender,
    originSenderId: r.origin_sender_id ?? null,
  },
  createdAt: r.created_at,
});

export class Pool {
  constructor(private readonly raw: ModuleHost['raw']) {}

  // ---------- teams ----------
  teams(): Team[] {
    const teams = this.raw.prepare('SELECT * FROM memory_team ORDER BY name').all() as {
      id: string;
      name: string;
      created_at: number;
    }[];
    const members = this.raw.prepare('SELECT team_id, agent_id FROM memory_team_member').all() as {
      team_id: string;
      agent_id: string;
    }[];
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.created_at,
      members: members.filter((m) => m.team_id === t.id).map((m) => m.agent_id),
    }));
  }
  team(id: string): Team | undefined {
    return this.teams().find((t) => t.id === id);
  }
  teamByName(name: string): Team | undefined {
    const n = name.trim().toLowerCase();
    return this.teams().find((t) => t.name.toLowerCase() === n || t.id === name);
  }
  teamsOf(agentId: string): Team[] {
    return this.teams().filter((t) => t.members.includes(agentId));
  }
  createTeam(name: string, members: string[]): Team {
    const id = ulid();
    this.raw.transaction(() => {
      this.raw
        .prepare('INSERT INTO memory_team (id, name, created_at) VALUES (?, ?, ?)')
        .run(id, name, Date.now());
      this.setMembers(id, members);
    })();
    return this.team(id)!;
  }
  updateTeam(id: string, o: { name?: string; members?: string[] }): Team | undefined {
    if (!this.team(id)) return undefined;
    this.raw.transaction(() => {
      if (o.name !== undefined)
        this.raw.prepare('UPDATE memory_team SET name = ? WHERE id = ?').run(o.name, id);
      if (o.members) this.setMembers(id, o.members);
    })();
    return this.team(id);
  }
  deleteTeam(id: string): boolean {
    return this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM memory_team_member WHERE team_id = ?').run(id);
      return this.raw.prepare('DELETE FROM memory_team WHERE id = ?').run(id).changes > 0;
    })();
  }
  private setMembers(id: string, members: string[]) {
    this.raw.prepare('DELETE FROM memory_team_member WHERE team_id = ?').run(id);
    const ins = this.raw.prepare('INSERT INTO memory_team_member (team_id, agent_id) VALUES (?, ?)');
    for (const m of new Set(members)) ins.run(id, m);
  }

  // ---------- provenance ----------
  addMeta(m: Omit<Meta, 'state'>) {
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO memory_meta
         (backend, item_id, scope_key, key, confidence, writer_kind, writer_agent_id, writer_trust, created_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
      )
      .run(
        m.backend,
        m.itemId,
        m.scopeKey,
        m.key,
        m.confidence,
        m.writer.kind,
        m.writer.agentId,
        m.trust,
        m.createdAt,
      );
  }
  meta(backend: string, id: string): Meta | undefined {
    const r = this.raw
      .prepare('SELECT * FROM memory_meta WHERE backend = ? AND item_id = ?')
      .get(backend, id) as MetaRow | undefined;
    return r ? toMeta(r) : undefined;
  }
  metas(backend: string, ids: string[]): Map<string, Meta> {
    const out = new Map<string, Meta>();
    const get = this.raw.prepare('SELECT * FROM memory_meta WHERE backend = ? AND item_id = ?');
    for (const id of ids) {
      const r = get.get(backend, id) as MetaRow | undefined;
      if (r) out.set(id, toMeta(r));
    }
    return out;
  }
  setState(backend: string, id: string, state: Meta['state']) {
    this.raw
      .prepare('UPDATE memory_meta SET state = ? WHERE backend = ? AND item_id = ?')
      .run(state, backend, id);
  }
  /** live entries with this key in this scope, newest first */
  liveByKey(backend: string, scopeKey: ScopeKey, key: string): Meta[] {
    return (
      this.raw
        .prepare(
          `SELECT * FROM memory_meta WHERE backend = ? AND scope_key IS ? AND key = ? AND state = 'live'
           ORDER BY created_at DESC, item_id DESC`,
        )
        .all(backend, scopeKey, key) as MetaRow[]
    ).map(toMeta);
  }

  // ---------- merge queue ----------
  queueMerge(m: Omit<MergeEntry, 'id' | 'createdAt'>): string {
    const id = ulid();
    this.raw
      .prepare(
        `INSERT INTO memory_merge (id, backend, scope_key, key, current_id, incoming_text, incoming_tags,
           incoming_source, writer_kind, writer_agent_id, writer_trust, origin_sender, origin_sender_id,
           incoming_confidence, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.backend,
        m.scopeKey,
        m.key,
        m.currentId,
        m.incoming.text,
        JSON.stringify(m.incoming.tags),
        m.incoming.source,
        m.incoming.writer.kind,
        m.incoming.writer.agentId,
        m.incoming.trust,
        m.incoming.originSender,
        m.incoming.originSenderId ?? null,
        m.incoming.confidence,
        m.reason,
        Date.now(),
      );
    return id;
  }
  openMerges(): MergeEntry[] {
    return (
      this.raw
        .prepare('SELECT * FROM memory_merge WHERE resolved_at IS NULL ORDER BY created_at, id LIMIT 500')
        .all() as MergeRow[]
    ).map(toMerge);
  }
  openMerge(id: string): MergeEntry | undefined {
    const r = this.raw.prepare('SELECT * FROM memory_merge WHERE id = ? AND resolved_at IS NULL').get(id) as
      | MergeRow
      | undefined;
    return r ? toMerge(r) : undefined;
  }
  /** settle one entry; the incoming text and tags are cleared so a dropped value is not kept anywhere */
  resolveMerge(id: string, resolution: string) {
    this.raw
      .prepare(
        "UPDATE memory_merge SET resolved_at = ?, resolution = ?, incoming_text = '', incoming_tags = '[]', incoming_source = NULL WHERE id = ? AND resolved_at IS NULL",
      )
      .run(Date.now(), resolution, id);
  }
  /** open merges whose current item is `itemId` (it was deleted): the incoming value simply becomes the open entry */
  mergesFor(backend: string, itemId: string): MergeEntry[] {
    return (
      this.raw
        .prepare('SELECT * FROM memory_merge WHERE backend = ? AND current_id = ? AND resolved_at IS NULL')
        .all(backend, itemId) as MergeRow[]
    ).map(toMerge);
  }
  /** the owner edited the current entry: the open merge now compares against the edited one */
  retarget(id: string, currentId: string) {
    this.raw
      .prepare('UPDATE memory_merge SET current_id = ? WHERE id = ? AND resolved_at IS NULL')
      .run(currentId, id);
  }
  /** remove a queued entry outright (an import that failed is rolled back; nothing of it may stay) */
  discardMerge(id: string) {
    this.raw.prepare('DELETE FROM memory_merge WHERE id = ? AND resolved_at IS NULL').run(id);
  }
  /** drop every open merge in a scope (its team was deleted) */
  dropMergesIn(scopeKey: ScopeKey) {
    for (const m of this.openMerges().filter((x) => x.scopeKey === scopeKey))
      this.resolveMerge(m.id, 'dropped');
  }
}
