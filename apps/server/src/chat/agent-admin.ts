/**
 * AgentAdmin port (W19): export/import an agent with its chats, and memory/CPU limits. Core-owned because it
 * writes `agents`, `chats`, `chat_members` and `messages` rows, which modules never touch (ARCHITECTURE 5.5).
 * Every call names its actor and is checked here (active owner only); only the admin module's host holds it.
 */
import { mkdirSync } from 'node:fs';
import {
  type AgentAdmin,
  type AgentAdminActor,
  type BlockKindRegistry,
  type EventBus,
  HttpError,
  ORCHESTRATOR_AGENT_SETTING,
  type ServerI18n,
  ulid,
} from '@pasabot/core';
import type { CoreDatabase, Sqlite } from '@pasabot/db';
import {
  type AgentBundle,
  type AgentDTO,
  agentBundleSchema,
  DEFAULT_AGENT_TRUST,
  minTrust,
  trustLevelSchema,
} from '@pasabot/protocol';
import { toAgentDTO } from '../core/services.js';
import { workspaceFor } from '../runner/orchestrator.js';
import { builtInAgentId } from './agent-view.js';
import { publishAgentUpdated } from './index.js';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';

type Block = AgentBundle['chats'][number]['messages'][number]['blocks'][number];
const MAX_DEPTH = 32;
/** Every string in block data (keys included) through `redact`; undefined when nested deeper than MAX_DEPTH. */
function redactDeep(v: unknown, redact: (t: string) => string, depth = 0): { value: unknown } | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof v === 'string') return { value: redact(v) };
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const r = redactDeep(x, redact, depth + 1);
      if (!r) return undefined;
      out.push(r.value);
    }
    return { value: out };
  }
  if (v && typeof v === 'object') {
    const out: [string, unknown][] = [];
    for (const [k, x] of Object.entries(v)) {
      const r = redactDeep(x, redact, depth + 1);
      if (!r) return undefined;
      out.push([redact(k), r.value]);
    }
    return { value: Object.fromEntries(out) }; // own properties only (a "__proto__" key never sets a prototype)
  }
  return { value: v };
}
/** A card bound to a live server-side prompt (it names a promptId): dead elsewhere, and here it would answer the
 * original run's prompt, and its answer values are what a person typed. It never travels in a bundle. */
const boundToPrompt = (b: Block) =>
  !!b.data && typeof b.data === 'object' && Object.hasOwn(b.data as object, 'promptId');

export function createAgentAdmin(d: {
  db: Sqlite;
  bus: EventBus;
  home: string;
  blocks: BlockKindRegistry;
  redact: (t: string) => string;
  /** the built-in team builder's description in the owner's language */
  i18n?: ServerI18n;
}): AgentAdmin {
  const { db } = d;
  /** The port checks its actor itself (never the caller's claim): an active owner account, or 403. */
  const requireOwner = (actor: AgentAdminActor): string => {
    const ok =
      actor?.kind === 'user' &&
      typeof actor.id === 'string' &&
      db.prepare("SELECT 1 FROM users WHERE id = ? AND kind = 'owner' AND disabled_at IS NULL").get(actor.id);
    if (!ok) throw new HttpError(403, 'only the owner administers agents', 'forbidden');
    return actor.id;
  };
  /** Blocks that may travel: no attachments, no live prompt cards, every string redacted, valid after redaction. */
  const portable = (blocks: Block[]): Block[] => {
    const out: Block[] = [];
    for (const b of blocks) {
      if (d.blocks.get(b.kind)?.attachmentRefs || boundToPrompt(b)) continue;
      const r = redactDeep(b.data, d.redact);
      if (!r) continue;
      const nb = { kind: b.kind, v: b.v, data: r.value } as Block;
      if (d.blocks.validate(nb).ok) out.push(nb);
    }
    return out;
  };
  const getAgent = (id: string): AgentDTO | null => {
    const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as CoreDatabase['agents'] | undefined;
    return r ? toAgentDTO(r) : null;
  };
  const publish = (a: AgentDTO) => {
    publishAgentUpdated(d.db, d.bus, a, d.i18n);
  };
  const defaultTrust = () => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'agents.defaultTrust'").get() as
      | { value: string }
      | undefined;
    const v = trustLevelSchema.safeParse(r ? JSON.parse(r.value) : undefined);
    return v.success ? v.data : DEFAULT_AGENT_TRUST;
  };

  return {
    exportBundle(actor, agentId) {
      requireOwner(actor);
      const a = getAgent(agentId);
      if (!a) return null;
      // the built-in team builder runs on PasaBot's own internal prompt: it is never a portable agent (a copy would
      // either carry that prompt or pass a display sentence off as instructions), so it is not exported at all
      if (builtInAgentId(db) === a.id)
        throw new HttpError(409, 'the team builder is part of PasaBot and is not exported', 'builtin_agent');
      const chats = db
        .prepare(
          `SELECT c.id, c.kind, c.title, c.created_at FROM chats c
           JOIN chat_members m ON m.chat_id = c.id AND m.member_kind = 'agent' AND m.member_id = ?
           ORDER BY c.created_at LIMIT 500`,
        )
        .all(agentId) as { id: string; kind: 'direct' | 'channel'; title: string; created_at: number }[];
      const msgs = db.prepare(
        `SELECT author_kind, author_id, body, blocks, created_at FROM messages
         WHERE chat_id = ? AND status = 'final' ORDER BY created_at, id LIMIT 20000`,
      );
      const bundle: AgentBundle = {
        format: 'pasabot.agent-bundle',
        v: 1,
        exportedAt: Date.now(),
        agent: {
          name: a.name,
          slug: a.slug,
          avatar: a.avatar,
          instructions: d.redact(a.instructions),
          providerId: a.providerId,
          model: a.model,
          fallback: a.fallback.slice(0, 5),
          trustLevel: a.trustLevel,
          limits: a.limits,
        },
        chats: chats.map((c, i) => ({
          ref: `c${i + 1}`,
          kind: c.kind,
          title: c.title,
          createdAt: c.created_at,
          messages: (
            msgs.all(c.id) as {
              author_kind: 'user' | 'agent' | 'system' | 'external';
              author_id: string | null;
              body: string;
              blocks: string;
              created_at: number;
            }[]
          )
            // another agent's words in a shared channel stay behind: only this agent, people and system notes go
            .filter((m) => m.author_kind !== 'agent' || m.author_id === agentId)
            .map((m) => ({
              authorKind: m.author_kind,
              body: d.redact(m.body),
              blocks: portable(JSON.parse(m.blocks) as Block[]),
              createdAt: m.created_at,
            })),
        })),
      };
      return agentBundleSchema.parse(bundle);
    },

    importBundle(actor, input, opts) {
      const ownerId = requireOwner(actor);
      const b = agentBundleSchema.parse(input);
      const base = slugify(b.agent.slug || b.agent.name);
      let slug = base;
      for (let i = 2; db.prepare('SELECT 1 FROM agents WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
      const id = ulid();
      const ws = workspaceFor(d.home, slug);
      mkdirSync(ws, { recursive: true, mode: 0o700 });
      const trust = minTrust(b.agent.trustLevel, defaultTrust());
      const limits: Record<string, number> = {};
      for (const k of ['memMb', 'cpuPct', 'contextPctCompact'] as const) {
        const v = b.agent.limits[k];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) limits[k] = v;
      }
      const chatIds: string[] = [];
      db.transaction(() => {
        db.prepare(
          `INSERT INTO agents (id, slug, name, avatar, instructions, provider_id, model, fallback, workspace_dir,
             trust_level, limits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          slug,
          b.agent.name,
          JSON.stringify(b.agent.avatar),
          d.redact(b.agent.instructions),
          b.agent.providerId,
          b.agent.model,
          JSON.stringify(b.agent.fallback),
          ws,
          trust,
          JSON.stringify(limits),
          Date.now(),
        );
        // the built-in team builder is known before its first `agent.updated`, so its prompt is never published
        if (opts?.teamBuilder)
          db.prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          ).run(ORCHESTRATOR_AGENT_SETTING, JSON.stringify(id));
        const insMsg = db.prepare(
          `INSERT INTO messages (id, chat_id, author_kind, author_id, body, blocks, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'final', ?)`,
        );
        for (const c of b.chats) {
          const chatId = ulid();
          chatIds.push(chatId);
          db.prepare(
            'INSERT INTO chats (id, kind, title, task_owner_agent_id, created_at) VALUES (?, ?, ?, ?, ?)',
          ).run(chatId, c.kind, c.title, id, c.createdAt);
          db.prepare(
            "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'owner')",
          ).run(chatId, ownerId);
          db.prepare(
            "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'agent', ?, 'member')",
          ).run(chatId, id);
          for (const m of c.messages) {
            // a person's words in a bundle are outside text: never the owner's (or any account's) own message
            const kind = m.authorKind === 'user' ? 'external' : m.authorKind;
            const authorId = kind === 'agent' ? id : null;
            insMsg.run(
              ulid(),
              chatId,
              kind,
              authorId,
              d.redact(m.body),
              JSON.stringify(portable(m.blocks)),
              m.createdAt,
            );
          }
        }
      })();
      publish(getAgent(id)!);
      for (const c of chatIds) d.bus.publish('global', 'chat.created', { id: c });
      return { agentId: id, chatIds };
    },

    setLimits(actor, agentId, l) {
      requireOwner(actor);
      const a = getAgent(agentId);
      if (!a) return null;
      const next: Record<string, number | undefined> = { ...a.limits };
      for (const k of ['memMb', 'cpuPct'] as const) {
        const v = l[k];
        if (v === undefined) continue;
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) next[k] = v;
        else delete next[k];
      }
      db.prepare('UPDATE agents SET limits = ? WHERE id = ?').run(JSON.stringify(next), agentId);
      const out = getAgent(agentId)!;
      publish(out);
      return out;
    },

    rename(actor, agentId, o) {
      requireOwner(actor);
      const a = getAgent(agentId);
      if (!a) return null;
      const name = o.name.trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'a name is needed', 'invalid_input');
      db.transaction(() => {
        // a direct chat that still carries the agent's old name follows the rename (as PATCH /agents/:id does)
        db.prepare(
          `UPDATE chats SET title = ? WHERE kind = 'direct' AND title = ? AND id IN
             (SELECT chat_id FROM chat_members WHERE member_kind = 'agent' AND member_id = ?)`,
        ).run(name, a.name, agentId);
        db.prepare('UPDATE agents SET name = ?, avatar = ?, avatar_salt = ? WHERE id = ?').run(
          name,
          JSON.stringify({ ...a.avatar, glyph: [...name][0]!.toUpperCase() }),
          o.avatarSalt.slice(0, 80),
          agentId,
        );
      })();
      const out = getAgent(agentId)!;
      publish(out);
      return out;
    },
  };
}
