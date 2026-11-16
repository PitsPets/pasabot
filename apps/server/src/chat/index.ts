/**
 * Core chat REST: agents CRUD + workspaces, providers, sections, direct chats and channels, members, messages,
 * attachments. Every chat/message read is filtered by `chat_members` for non-owner users (ARCHITECTURE 3.1);
 * widening (trust level) is owner-only REST (7.4).
 */
import { mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  type BlobStore,
  type BlockKindRegistry,
  brainKeyStamp,
  type EventBus,
  ORCHESTRATOR_AGENT_SETTING,
  type Principal,
  type ProviderAdapter,
  type ProviderStatus,
  type SecretVault,
  type SenderInfo,
  type ServerI18n,
  ulid,
  vaultKeyNames,
  withTurnSignIn,
  withVaultKeys,
} from '@pasabot/core';
import type { CoreDatabase, Sqlite } from '@pasabot/db';
import { providerDisplayName } from '@pasabot/i18n';
import {
  type AgentDTO,
  DEFAULT_AGENT_TRUST,
  messageBlockSchema,
  type TrustLevel,
  trustLevelSchema,
} from '@pasabot/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SqliteQueue } from '../core/queue.js';
import { type AuthResolver, type ProviderRegistryImpl, toAgentDTO } from '../core/services.js';
import { agentView, builtInAgentId } from './agent-view.js';
import { toMessageDTO } from './dto.js';
import { viewMessages } from './view.js';

/**
 * `agent.updated` without leaking the team (W23): the owner gets the redacted copy on `owner` (and the full one on
 * `agent:<id>`, owner-only); a member or guest gets the redacted copy only on the `chat:<id>` topics of chats that
 * contain the agent, never on `global`, so a guest invited to one chat never learns about other agents. The built-in
 * team builder's internal prompt is in neither copy (`agentView`).
 */
export const publishAgentUpdated = (db: Sqlite, bus: EventBus, a: AgentDTO, i18n?: ServerI18n) => {
  const builtIn = builtInAgentId(db);
  const pub = agentView(db, a, { owner: false, i18n, builtIn });
  bus.publish('owner', 'agent.updated', pub);
  for (const c of db
    .prepare("SELECT chat_id FROM chat_members WHERE member_kind = 'agent' AND member_id = ?")
    .all(a.id) as { chat_id: string }[])
    bus.publish(`chat:${c.chat_id}`, 'agent.updated', pub);
  bus.publish(`agent:${a.id}`, 'agent.updated', agentView(db, a, { owner: true, i18n, builtIn }));
};
/** may this signed-in person see the agent at all: the owner always, others only an agent of a chat they are in */
const AGENTS_OF_MY_CHATS = `SELECT a.member_id FROM chat_members a JOIN chat_members u ON u.chat_id = a.chat_id
  WHERE a.member_kind = 'agent' AND u.member_kind = 'user' AND u.member_id = ?`;

import type { Orchestrator } from '../runner/orchestrator.js';
import { workspaceFor } from '../runner/orchestrator.js';
import type { Redact } from '../vault/index.js';
import { registerPrefsRoutes } from './prefs.js';
import { canReadChatAs, canWriteChat } from './write.js';

export interface ChatDeps {
  db: Sqlite;
  bus: EventBus;
  queue: SqliteQueue;
  providers: ProviderRegistryImpl;
  orchestrator: Orchestrator;
  files: BlobStore;
  home: string;
  resolveAuth: AuthResolver;
  redact: Redact;
  /** message block kinds (user-authored blocks are checked against it) */
  blocks?: BlockKindRegistry;
  /** names a brain in the reader's saved language (modules' screens read `displayName` as sent) */
  i18n?: ServerI18n;
  /** a brain whose API key is in the vault reads as signed in (entry names only) */
  vault?: Pick<SecretVault, 'list'>;
}

/** 250 MB of attachments per message (8, "DoS"); each blob is capped at 100 MB by the BlobStore. */
export const MAX_MESSAGE_BYTES = 250 * 1024 * 1024;
/** how long a brain's model list is kept before the agent form asks the provider again */
export const MODELS_TTL_MS = 5 * 60_000;
/** how long a brain's detected state (GET /api/v1/providers) is kept before its CLI is asked again */
export const PROVIDERS_TTL_MS = 30_000;
/** the owner's window: short, so a brain signed in a moment ago reads as ready on the next page load */
export const OWNER_PROVIDERS_TTL_MS = 3_000;
const attachmentInput = z.union([
  z.string().regex(/^[0-9a-f]{64}$/),
  z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string().min(1).max(255).optional(),
    mime: z
      .string()
      .max(127)
      .regex(/^[\w.+-]+\/[\w.+-]+$/)
      .optional(),
  }),
]);
/** Types a browser may show inline from the app origin; anything else downloads as octet-stream. */
const INLINE_MIME =
  /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/plain)$/;

type Session = Extract<Principal, { kind: 'session' }>;

export { toMessageDTO } from './dto.js';

/** Owners see every chat; everyone else only chats where they are a member. */
export function canReadChat(db: Sqlite, p: Session, chatId: string): boolean {
  return canReadChatAs(db, p, chatId);
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'agent';

export function registerChatRoutes(app: FastifyInstance, d: ChatDeps) {
  const { db } = d;
  registerPrefsRoutes(app, { db, resolveAuth: d.resolveAuth });
  const auth = (req: FastifyRequest, reply: FastifyReply, ownerOnly = false): Session | null => {
    const p = d.resolveAuth({ headers: req.headers, ip: req.ip });
    if (p?.kind !== 'session') {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    if (ownerOnly && p.userKind !== 'owner') {
      reply.code(403).send({ error: 'owner_only' });
      return null;
    }
    return p;
  };
  const body = <T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) {
      reply.code(400).send({ error: 'invalid_input', message: r.error.message });
      return null;
    }
    return r.data;
  };
  const getAgent = (id: string) => {
    const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as CoreDatabase['agents'] | undefined;
    return r ? toAgentDTO(r) : null;
  };
  const chatDTO = (id: string) => {
    const c = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!c) return null;
    const members = db
      .prepare('SELECT member_kind, member_id, role FROM chat_members WHERE chat_id = ?')
      .all(id) as { member_kind: 'user' | 'agent'; member_id: string; role: string }[];
    return {
      id: c.id,
      kind: c.kind as 'direct' | 'channel',
      title: c.title as string,
      sectionId: c.section_id as string | null,
      taskOwnerAgentId: c.task_owner_agent_id as string | null,
      settings: JSON.parse(c.settings),
      createdAt: c.created_at as number,
      archivedAt: c.archived_at as number | null,
      members: members.map((m) => ({ kind: m.member_kind, id: m.member_id, role: m.role })),
    };
  };
  const createChat = (o: {
    kind: 'direct' | 'channel';
    title: string;
    sectionId?: string | null;
    agentIds: string[];
    userIds: string[];
    taskOwner?: string | null;
  }) => {
    const id = ulid();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO chats (id, kind, title, section_id, task_owner_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, o.kind, o.title, o.sectionId ?? null, o.taskOwner ?? o.agentIds[0] ?? null, Date.now());
      for (const u of o.userIds)
        db.prepare(
          "INSERT OR IGNORE INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, ?)",
        ).run(id, u, 'owner');
      for (const a of o.agentIds)
        db.prepare(
          "INSERT OR IGNORE INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'agent', ?, 'member')",
        ).run(id, a);
    })();
    return id;
  };

  // ---------- providers ----------
  /**
   * The brains and their state, for the app's brain names and the agent form's picker. Detection starts CLI processes
   * outside any sandbox, so its result is shared by concurrent requests and kept per brain: PROVIDERS_TTL_MS for
   * members and guests (however often they ask, each brain's CLI runs at most once per window), a few seconds for the
   * owner (who may just have signed a brain in). Only the owner (who sets brains up) gets the whole status (hints,
   * version, install command) and the capabilities; members and guests get the name and the three flags the picker
   * reads (installed, signed in, reachable).
   */
  const detectCache = new Map<string, { at: number; status: ProviderStatus }>();
  const detectsInFlight = new Map<string, Promise<ProviderStatus>>();
  const detected = (p: ProviderAdapter, maxAgeMs: number): Promise<ProviderStatus> => {
    const hit = detectCache.get(p.id);
    if (hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.status);
    const running = detectsInFlight.get(p.id);
    if (running) return running;
    const job = (async () => {
      let status: ProviderStatus;
      try {
        status = await p.detect();
        // how a turn really runs (the sandbox, the turn's env): kept with the detection, under the same window
        if (status.installed && status.signedIn !== false && d.providers.turnSignIn)
          status = withTurnSignIn(status, await d.providers.turnSignIn(p.id), false);
      } catch (e) {
        status = { installed: false, signedIn: false, hint: String(e) };
      }
      detectCache.set(p.id, { at: Date.now(), status });
      return status;
    })().finally(() => detectsInFlight.delete(p.id));
    detectsInFlight.set(p.id, job);
    return job;
  };
  app.get('/api/v1/providers', async (req, reply) => {
    const s = auth(req, reply);
    if (!s) return;
    const isOwner = s.userKind === 'owner';
    // a brain whose API key is in the vault is signed in (names only, never values)
    const keys = await vaultKeyNames(d.vault);
    const lng = d.i18n?.language(s.userId);
    const list = d.providers.list();
    const statuses = await Promise.all(
      list.map((p) => detected(p, isOwner ? OWNER_PROVIDERS_TTL_MS : PROVIDERS_TTL_MS)),
    );
    // the last test or turn that failed on sign-in wins until one works or the brain's key is saved anew
    const lost = await Promise.all(
      list.map(async (p) =>
        d.providers.signInLost ? d.providers.signInLost(p.id, await brainKeyStamp(d.vault, p.id)) : false,
      ),
    );
    const out = list.map((p, i) => {
      const status = withTurnSignIn(withVaultKeys(statuses[i]!, p, keys), 'unknown', lost[i]!);
      return {
        id: p.id,
        displayName: d.i18n
          ? providerDisplayName(p, (k, o) => d.i18n!.t(k, undefined, lng) || o.defaultValue)
          : p.displayName,
        ...(p.displayNameKey ? { displayNameKey: p.displayNameKey } : {}),
        ...(isOwner
          ? { status, caps: p.capabilities() }
          : {
              status: {
                installed: status.installed,
                signedIn: status.signedIn,
                ...(status.reachable !== undefined ? { reachable: status.reachable } : {}),
              },
            }),
      };
    });
    return { providers: out };
  });

  /**
   * The models a brain offers right now, asked from the provider itself (`listModels`), for the agent form's model
   * picker. Owner only (only the owner creates and edits agents). Kept for MODELS_TTL_MS so opening the form again
   * does not spawn the CLI again; `?refresh=1` asks anew. `error: 'unavailable'` = the provider could not be asked
   * (the app shows "could not load models"); `listed: false` = this brain has no model list (the app offers only the
   * brain's own default).
   */
  const modelCache = new Map<string, { at: number; body: Record<string, unknown> }>();
  const modelsInFlight = new Map<string, Promise<Record<string, unknown>>>();
  app.get('/api/v1/providers/:id/models', async (req, reply) => {
    const s = auth(req, reply, true);
    if (!s) return;
    const { id } = req.params as { id: string };
    const p = d.providers.get(id);
    if (!p) return reply.code(404).send({ error: 'unknown_provider' });
    if (!p.listModels) return { models: [], listed: false };
    const refresh = (req.query as { refresh?: string }).refresh === '1';
    const hit = modelCache.get(id);
    if (hit && !refresh && Date.now() - hit.at < MODELS_TTL_MS) return hit.body;
    let job = modelsInFlight.get(id);
    if (!job) {
      job = (async () => {
        try {
          const models = (await p.listModels!()).slice(0, 100).map((m) => ({
            id: m.id,
            ...(m.label ? { label: m.label } : {}),
            ...(m.hint ? { hint: m.hint } : {}),
            ...(m.recommended ? { recommended: true } : {}),
            ...(m.curated ? { curated: true } : {}),
          }));
          const body = { models, listed: true };
          modelCache.set(id, { at: Date.now(), body });
          return body;
        } catch (e) {
          app.log.warn({ providerId: id, error: String(e).slice(0, 300) }, 'model list failed');
          modelCache.delete(id);
          return { models: [], listed: true, error: 'unavailable' };
        }
      })().finally(() => modelsInFlight.delete(id));
      modelsInFlight.set(id, job);
    }
    return job;
  });

  // ---------- agents ----------
  const agentCreate = z.object({
    name: z.string().min(1).max(60),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .optional(),
    providerId: z.string().min(1),
    model: z.string().max(100).nullable().optional(),
    instructions: z.string().max(20_000).optional(),
    trustLevel: trustLevelSchema.optional(),
    /** 7.1 "Ask before terminal and raw web commands": null = the trust level's default */
    askShellWeb: z.boolean().nullable().optional(),
    avatar: z.object({ hue: z.number().min(0).max(360), glyph: z.string().max(4) }).optional(),
    /** generated avatar re-roll ("Shuffle"): '' = the original look */
    avatarSalt: z
      .string()
      .regex(/^[A-Za-z0-9_-]{0,32}$/)
      .optional(),
  });
  /** Every user sees `global`: it carries the redacted agent; the full one goes to the owner-only agent topic. */
  const publishAgent = (a: AgentDTO) => publishAgentUpdated(db, d.bus, a, d.i18n);

  /**
   * A reply in a helper thread (collab: the request one helper gave another, its root a `collab.thread` message):
   * the request and this helper's latest answer there, quoted and labelled as context, never as the owner's words.
   */
  const threadContext = (replyTo: string): string | null => {
    const get = db.prepare(
      'SELECT id, chat_id, author_id, reply_to, body, blocks FROM messages WHERE id = ?',
    );
    let root: { id: string; chat_id: string; author_id: string | null; body: string } | null = null;
    let at: string | null = replyTo;
    for (let n = 0; at && !root && n < 8; n++) {
      const r = get.get(at) as
        | {
            id: string;
            chat_id: string;
            author_id: string | null;
            reply_to: string | null;
            body: string;
            blocks: string;
          }
        | undefined;
      if (!r) return null;
      let blocks: unknown = [];
      try {
        blocks = JSON.parse(r.blocks || '[]');
      } catch {
        // unreadable blocks: not a thread
      }
      if (
        Array.isArray(blocks) &&
        blocks.some((x) => (x as { kind?: unknown } | null)?.kind === 'collab.thread')
      )
        root = r;
      else at = r.reply_to;
    }
    if (!root) return null;
    const asker =
      (root.author_id &&
        (
          db.prepare('SELECT name FROM agents WHERE id = ?').get(root.author_id) as
            | { name: string }
            | undefined
        )?.name) ||
      'another helper';
    const answer = db
      .prepare(
        "SELECT body FROM messages WHERE chat_id = ? AND reply_to = ? AND author_kind = 'agent' AND status = 'final' AND body <> '' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(root.chat_id, root.id) as { body: string } | undefined;
    const quote = (x: string) =>
      (x.length > 4000 ? `${x.slice(0, 3999)}…` : x)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    return [
      `(Context, not the owner's words: the owner wrote this as a reply in the thread of a request ${asker} gave you.`,
      'The request:',
      quote(root.body || '(no text)'),
      ...(answer ? ['Your answer there:', quote(answer.body)] : []),
      ')',
    ].join('\n');
  };
  /** an agent as this reader may see it (owner or not, in their language) */
  const view = (a: AgentDTO, p: { userId: string; userKind: string }, builtIn?: string | null) =>
    agentView(db, a, {
      owner: p.userKind === 'owner',
      i18n: d.i18n,
      lng: d.i18n?.language(p.userId),
      builtIn,
    });
  /** Trust for agents created without an explicit level (owner setting `agents.defaultTrust`, else `trusted`). */
  const defaultTrust = (): TrustLevel => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'agents.defaultTrust'").get() as
      | { value: string }
      | undefined;
    const v = trustLevelSchema.safeParse(r ? JSON.parse(r.value) : undefined);
    return v.success ? v.data : DEFAULT_AGENT_TRUST;
  };
  app.get('/api/v1/settings/agent-trust', async (req, reply) => {
    if (!auth(req, reply)) return;
    return { defaultTrust: defaultTrust() };
  });
  app.put('/api/v1/settings/agent-trust', async (req, reply) => {
    const p = auth(req, reply, true); // the server default is a widening field: owner session only
    if (!p) return;
    const b = body(z.object({ defaultTrust: trustLevelSchema }), req, reply);
    if (!b) return;
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('agents.defaultTrust', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(b.defaultTrust));
    return { defaultTrust: b.defaultTrust };
  });
  app.get('/api/v1/agents', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const owner = p.userKind === 'owner';
    // a member or guest sees only the agents of chats they can read (W23: an invited guest learns nothing else)
    const rows = (
      owner
        ? db.prepare('SELECT * FROM agents WHERE archived_at IS NULL ORDER BY name').all()
        : db
            .prepare(
              `SELECT * FROM agents WHERE archived_at IS NULL AND id IN (${AGENTS_OF_MY_CHATS}) ORDER BY name`,
            )
            .all(p.userId)
    ) as CoreDatabase['agents'][];
    const builtIn = builtInAgentId(db);
    return { agents: rows.map((r) => view(toAgentDTO(r), p, builtIn)) };
  });
  app.get('/api/v1/agents/:id', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const id = (req.params as { id: string }).id;
    const a = getAgent(id);
    // a member or guest gets 404 for an agent of no chat they are in (same answer as a missing one)
    if (
      !a ||
      (p.userKind !== 'owner' &&
        !db.prepare(`SELECT 1 FROM (${AGENTS_OF_MY_CHATS}) WHERE member_id = ?`).get(p.userId, id))
    )
      return reply.code(404).send({ error: 'not_found' });
    return { agent: view(a, p) };
  });
  app.post('/api/v1/agents', async (req, reply) => {
    const p = auth(req, reply, true);
    if (!p) return;
    const b = body(agentCreate, req, reply);
    if (!b) return;
    if (!d.providers.get(b.providerId)) return reply.code(400).send({ error: 'unknown_provider' });
    let slug = b.slug ?? slugify(b.name);
    for (let i = 2; db.prepare('SELECT 1 FROM agents WHERE slug = ?').get(slug); i++)
      slug = `${slugify(b.name)}-${i}`;
    const id = ulid();
    const ws = workspaceFor(d.home, slug);
    mkdirSync(ws, { recursive: true, mode: 0o700 });
    db.prepare(
      'INSERT INTO agents (id, slug, name, avatar, avatar_salt, instructions, provider_id, model, workspace_dir, trust_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      slug,
      b.name,
      JSON.stringify(
        b.avatar ?? { hue: Math.floor(Math.random() * 360), glyph: b.name.slice(0, 1).toUpperCase() },
      ),
      b.avatarSalt ?? '',
      b.instructions ?? '',
      b.providerId,
      b.model ?? null,
      ws,
      b.trustLevel ?? defaultTrust(),
      Date.now(),
    );
    if (typeof b.askShellWeb === 'boolean')
      db.prepare('UPDATE agents SET ask_shell_web = ? WHERE id = ?').run(b.askShellWeb ? 1 : 0, id);
    const chatId = createChat({ kind: 'direct', title: b.name, agentIds: [id], userIds: [p.userId] });
    const agent = getAgent(id)!;
    publishAgent(agent);
    return reply.code(201).send({ agent: view(agent, p), chatId });
  });
  app.patch('/api/v1/agents/:id', async (req, reply) => {
    const p = auth(req, reply, true); // trust level is a widening field: owner session only
    if (!p) return;
    const id = (req.params as { id: string }).id;
    if (!getAgent(id)) return reply.code(404).send({ error: 'not_found' });
    const b = body(agentCreate.partial().omit({ slug: true }), req, reply);
    if (!b) return;
    // the built-in team builder runs on PasaBot's own internal prompt: it is never edited from a client
    if (b.instructions !== undefined && builtInAgentId(db) === id)
      return reply.code(409).send({ error: 'builtin_instructions' });
    if (b.providerId && !d.providers.get(b.providerId))
      return reply.code(400).send({ error: 'unknown_provider' });
    // a direct chat that still carries the agent's old name follows a rename (first run: "Meet your first agent")
    const before = getAgent(id)!.name;
    if (b.name && b.name !== before)
      db.prepare(
        `UPDATE chats SET title = ? WHERE kind = 'direct' AND title = ? AND id IN
           (SELECT chat_id FROM chat_members WHERE member_kind = 'agent' AND member_id = ?)`,
      ).run(b.name, before, id);
    const cols: Record<string, unknown> = {
      name: b.name,
      provider_id: b.providerId,
      model: b.model,
      instructions: b.instructions,
      trust_level: b.trustLevel,
      avatar: b.avatar ? JSON.stringify(b.avatar) : undefined,
      avatar_salt: b.avatarSalt,
    };
    for (const [k, v] of Object.entries(cols)) {
      if (v !== undefined) db.prepare(`UPDATE agents SET ${k} = ? WHERE id = ?`).run(v, id);
    }
    // null puts it back to the trust level's default
    if (b.askShellWeb !== undefined)
      db.prepare('UPDATE agents SET ask_shell_web = ? WHERE id = ?').run(
        b.askShellWeb === null ? null : b.askShellWeb ? 1 : 0,
        id,
      );
    const agent = getAgent(id)!;
    publishAgent(agent);
    return { agent: view(agent, p) };
  });
  app.delete('/api/v1/agents/:id', async (req, reply) => {
    if (!auth(req, reply, true)) return;
    const id = (req.params as { id: string }).id;
    // the built-in team builder stays while it is the only agent: a first-timer is never left with no agent at all
    const keep = db.prepare('SELECT value FROM settings WHERE key = ?').get(ORCHESTRATOR_AGENT_SETTING) as
      | { value: string }
      | undefined;
    if (
      keep &&
      JSON.parse(keep.value) === id &&
      !db.prepare('SELECT 1 FROM agents WHERE archived_at IS NULL AND id != ?').get(id)
    )
      return reply.code(409).send({ error: 'orchestrator_only_agent' });
    const r = db
      .prepare('UPDATE agents SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(Date.now(), id);
    if (r.changes !== 1) return reply.code(404).send({ error: 'not_found' });
    publishAgent(getAgent(id)!);
    return { ok: true };
  });

  // ---------- sections ----------
  app.get('/api/v1/sections', async (req, reply) => {
    if (!auth(req, reply)) return;
    return { sections: db.prepare('SELECT id, name, sort FROM sections ORDER BY sort, name').all() };
  });
  app.post('/api/v1/sections', async (req, reply) => {
    if (!auth(req, reply, true)) return;
    const b = body(
      z.object({ name: z.string().min(1).max(60), sort: z.number().int().optional() }),
      req,
      reply,
    );
    if (!b) return;
    const id = ulid();
    db.prepare('INSERT INTO sections (id, name, sort) VALUES (?, ?, ?)').run(id, b.name, b.sort ?? 0);
    return reply.code(201).send({ section: { id, name: b.name, sort: b.sort ?? 0 } });
  });

  // ---------- chats ----------
  app.get('/api/v1/chats', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const rows = (
      p.userKind === 'owner'
        ? db.prepare('SELECT id FROM chats WHERE archived_at IS NULL ORDER BY created_at').all()
        : db
            .prepare(
              "SELECT c.id FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.member_kind = 'user' AND m.member_id = ? WHERE c.archived_at IS NULL ORDER BY c.created_at",
            )
            .all(p.userId)
    ) as { id: string }[];
    return { chats: rows.map((r) => chatDTO(r.id)) };
  });
  app.post('/api/v1/chats', async (req, reply) => {
    const p = auth(req, reply, true);
    if (!p) return;
    const b = body(
      z.object({
        kind: z.enum(['direct', 'channel']),
        title: z.string().max(80).default(''),
        sectionId: z.string().nullable().optional(),
        agentIds: z.array(z.string()).min(1),
        userIds: z.array(z.string()).optional(),
        taskOwnerAgentId: z.string().optional(),
      }),
      req,
      reply,
    );
    if (!b) return;
    if (b.kind === 'direct' && b.agentIds.length !== 1)
      return reply.code(400).send({ error: 'invalid_input', message: 'a direct chat has exactly one agent' });
    for (const a of b.agentIds) if (!getAgent(a)) return reply.code(400).send({ error: 'unknown_agent' });
    const id = createChat({
      kind: b.kind,
      title: b.title,
      sectionId: b.sectionId,
      agentIds: b.agentIds,
      userIds: [p.userId, ...(b.userIds ?? [])],
      taskOwner: b.taskOwnerAgentId,
    });
    return reply.code(201).send({ chat: chatDTO(id) });
  });
  app.get('/api/v1/chats/:id', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const id = (req.params as { id: string }).id;
    if (!canReadChat(db, p, id)) return reply.code(404).send({ error: 'not_found' });
    return { chat: chatDTO(id) };
  });
  app.post('/api/v1/chats/:id/members', async (req, reply) => {
    if (!auth(req, reply, true)) return;
    const id = (req.params as { id: string }).id;
    if (!chatDTO(id)) return reply.code(404).send({ error: 'not_found' });
    const b = body(
      z.object({
        kind: z.enum(['user', 'agent']),
        memberId: z.string(),
        role: z.enum(['owner', 'member', 'observer']).default('member'),
      }),
      req,
      reply,
    );
    if (!b) return;
    db.prepare(
      'INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role',
    ).run(id, b.kind, b.memberId, b.role);
    return { chat: chatDTO(id) };
  });
  app.delete('/api/v1/chats/:id/members/:kind/:memberId', async (req, reply) => {
    if (!auth(req, reply, true)) return;
    const { id, kind, memberId } = req.params as { id: string; kind: string; memberId: string };
    db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND member_kind = ? AND member_id = ?').run(
      id,
      kind,
      memberId,
    );
    return { chat: chatDTO(id) };
  });

  // ---------- messages ----------
  app.get('/api/v1/chats/:id/messages', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const id = (req.params as { id: string }).id;
    if (!canReadChat(db, p, id)) return reply.code(404).send({ error: 'not_found' });
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
    const rows = (
      q.before
        ? db
            .prepare(
              'SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(id, Number(q.before), limit)
        : db
            .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(id, limit)
    ) as Record<string, any>[];
    // the owner's cards reach the owner only (a member or guest gets the neutral line, or nothing)
    const viewer = { kind: p.userKind, userId: p.userId };
    return { messages: viewMessages(rows.reverse().map(toMessageDTO), viewer, { db, i18n: d.i18n }) };
  });

  app.post('/api/v1/chats/:id/messages', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const chatId = (req.params as { id: string }).id;
    if (!canReadChat(db, p, chatId)) return reply.code(404).send({ error: 'not_found' });
    if (!canWriteChat(db, p, chatId)) return reply.code(403).send({ error: 'read_only' });
    const b = body(
      z.object({
        text: z.string().min(1).max(100_000),
        replyTo: z.string().optional(),
        mode: z.enum(['steer', 'queue', 'interrupt']).default('steer'),
        attachments: z.array(attachmentInput).max(20).optional(),
        /** blocks of kinds registered with `userAuthored` (e.g. a module's file-preview block) */
        blocks: z.array(messageBlockSchema).max(10).optional(),
      }),
      req,
      reply,
    );
    if (!b) return;
    // attachments: uploaded blobs (POST /api/v1/blobs, 100 MB each), 250 MB per message (8, "DoS")
    const files: { sha256: string; name: string; mime: string; size: number }[] = [];
    // knowing a hash is not enough: the sender uploaded these bytes, or can already read them in a chat
    const uploadedBy = db.prepare('SELECT 1 FROM blob_uploads WHERE sha256 = ? AND user_id = ?');
    const attachedIn = db.prepare(
      'SELECT DISTINCT m.chat_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.blob_sha256 = ?',
    );
    const mayAttach = (sha: string) =>
      !!uploadedBy.get(sha, p.userId) ||
      (attachedIn.all(sha) as { chat_id: string }[]).some((r) => canReadChat(db, p, r.chat_id));
    for (const a of b.attachments ?? []) {
      const ref = typeof a === 'string' ? { sha256: a } : a;
      const meta = await d.files.stat(ref.sha256);
      if (!meta || !mayAttach(ref.sha256))
        return reply.code(400).send({ error: 'unknown_blob', sha256: ref.sha256 });
      files.push({
        sha256: ref.sha256,
        name: ref.name ?? ref.sha256.slice(0, 12),
        mime: ref.mime ?? 'application/octet-stream',
        size: meta.size ?? 0,
      });
    }
    if (files.reduce((n, f) => n + f.size, 0) > MAX_MESSAGE_BYTES)
      return reply.code(413).send({ error: 'message_too_large', max: MAX_MESSAGE_BYTES });
    for (const bl of b.blocks ?? []) {
      const kind = d.blocks?.get(bl.kind);
      const ok = d.blocks?.validate(bl);
      if (!kind?.userAuthored || !ok?.ok)
        return reply.code(400).send({ error: 'invalid_block', kind: bl.kind });
      // a block that describes attachments must describe this message's own, exactly (no relabelled previews)
      const refs = kind.attachmentRefs?.(bl.data) ?? [];
      const own = (r: (typeof refs)[number]) =>
        files.some(
          (f) => f.sha256 === r.sha256 && f.name === r.name && f.mime === r.mime && f.size === r.size,
        );
      if (!refs.every(own)) return reply.code(400).send({ error: 'invalid_block', kind: bl.kind });
    }
    // a reply points into this chat only: never at (or into) a message of a chat the sender cannot read
    if (
      b.replyTo &&
      !db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(b.replyTo, chatId)
    )
      return reply.code(400).send({ error: 'invalid_reply_to' });
    const chat = chatDTO(chatId)!;
    const agentId = chat.taskOwnerAgentId ?? chat.members.find((m) => m.kind === 'agent')?.id;
    const user = db.prepare('SELECT display_name, kind FROM users WHERE id = ?').get(p.userId) as {
      display_name: string;
      kind: 'owner' | 'member' | 'guest';
    };
    const id = ulid();
    const text = d.redact(b.text);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO messages (id, chat_id, author_kind, author_id, reply_to, body, blocks, status, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?, 'final', ?)",
      ).run(id, chatId, p.userId, b.replyTo ?? null, text, JSON.stringify(b.blocks ?? []), Date.now());
      for (const f of files)
        db.prepare(
          'INSERT INTO attachments (id, message_id, blob_sha256, name, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(ulid(), id, f.sha256, f.name, f.mime, f.size);
    })();
    const msg = toMessageDTO(
      db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, any>,
    );
    d.bus.publish(`chat:${chatId}`, 'message.created', msg);
    if (!agentId) return reply.code(201).send({ message: msg, queued: null });

    const sender: SenderInfo = {
      kind: user.kind,
      id: p.userId,
      name: user.display_name,
      trust: user.kind === 'owner' ? 'trusted' : user.kind === 'member' ? 'standard' : 'guarded',
    };
    // steer the running turn when possible (6, "Steer (default)"), else enqueue at chat priority. A message with
    // files is always queued: steering passes text only, and the files are copied into the workspace per run
    const settingsMode = chat.settings?.mode === 'queue' ? 'queue' : 'steer';
    // work another helper gave this one runs as a thread in this chat, as that helper (a non-owner sender, its own
    // session): a person's message never steers it (their words would read as the other helper's and stay in its
    // session); it is the person's own turn, after it
    const intoTask = d.orchestrator.running.get(chatId)?.sender.kind === 'agent';
    if (
      !intoTask &&
      b.mode === 'steer' &&
      files.length === 0 &&
      settingsMode === 'steer' &&
      (await d.orchestrator.steer(chatId, text, sender, id))
    ) {
      return reply.code(201).send({ message: msg, steered: true, queued: null });
    }
    if (b.mode === 'interrupt') {
      const running = d.orchestrator.running.get(chatId);
      // only the owner, or the sender of the running turn, may cancel it; anyone else just queues behind it
      const mayInterrupt =
        p.userKind === 'owner' || (running?.sender.id === p.userId && running.sender.kind === user.kind);
      if (running && mayInterrupt) {
        const qi = db.prepare('SELECT queue_item_id FROM runs WHERE id = ?').get(running.runId) as {
          queue_item_id: string;
        };
        d.queue.cancel(qi.queue_item_id);
      }
    }
    // the owner's reply in a helper thread is the owner's own turn: it reads the request and the helper's answer there
    // as labelled context (they ran in the other helper's session, which an owner turn never shares)
    const context = p.userKind === 'owner' && b.replyTo ? threadContext(b.replyTo) : null;
    const { item } = d.queue.enqueue({
      agentId,
      chatId,
      kind: 'message',
      priority: 0,
      // the agent sees what was stored: a pasted secret value reaches it only as `[secret:name]` (7.3)
      payload: {
        text: context ? `${text}\n\n${context}` : text,
        messageId: id,
        replyTo: id,
        ...(files.length ? { attachments: files } : {}),
      },
      source: { sender },
    });
    return reply.code(201).send({ message: msg, queued: item });
  });

  // ---------- run activity (the chat's tool-activity line) ----------
  /**
   * A run's tool steps: tool calls/results, permissions, sub-agent spans, errors. They are the owner's (the tools a
   * helper ran, their arguments and results, what it asked the owner: chat/view.ts): anyone else who reads the chat
   * gets the run's state only, never a step.
   */
  app.get('/api/v1/runs/:id/activity', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const runId = (req.params as { id: string }).id;
    const run = db
      .prepare(
        'SELECT r.id, r.state, r.started_at, r.finished_at, q.chat_id FROM runs r JOIN queue_items q ON q.id = r.queue_item_id WHERE r.id = ?',
      )
      .get(runId) as
      | { id: string; state: string; started_at: number; finished_at: number | null; chat_id: string | null }
      | undefined;
    if (!run?.chat_id || !canReadChat(db, p, run.chat_id))
      return reply.code(404).send({ error: 'not_found' });
    const state = { id: run.id, state: run.state, startedAt: run.started_at, finishedAt: run.finished_at };
    if (p.userKind !== 'owner') return { run: state, events: [] };
    const events = db
      .prepare(
        "SELECT n, type, data FROM run_events WHERE run_id = ? AND type IN ('tool.call', 'tool.result', 'permission', 'subagent', 'error') ORDER BY n LIMIT 500",
      )
      .all(runId) as { n: number; type: string; data: string }[];
    return {
      run: state,
      events: events.map((e) => ({ runId, n: e.n, type: e.type, data: JSON.parse(e.data) })),
    };
  });

  // ---------- attachments (raw upload, 100 MB cap) ----------
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: 100 * 1024 * 1024 },
    (_req, payload, done) => done(null, payload),
  );
  app.post('/api/v1/blobs', { bodyLimit: 100 * 1024 * 1024 }, async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    if (!(req.body instanceof Readable))
      return reply.code(415).send({ error: 'use application/octet-stream' });
    try {
      const ref = await d.files.put(req.body, {
        mime: String(req.headers['content-type'] ?? ''),
        uploadedBy: p.userId,
      });
      return reply.code(201).send(ref);
    } catch (e) {
      if ((e as { code?: string }).code === 'too_large') return reply.code(413).send({ error: 'too_large' });
      throw e;
    }
  });
  /**
   * Download an attachment's bytes: owners any attached blob, everyone else only blobs attached to a message in a
   * chat they can read. Never sniffed, never scripted: `nosniff` + a sandbox CSP, and only safe types inline.
   */
  app.get('/api/v1/blobs/:sha', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const sha = (req.params as { sha: string }).sha;
    if (!/^[0-9a-f]{64}$/.test(sha)) return reply.code(404).send({ error: 'not_found' });
    const rows = db
      .prepare(
        'SELECT a.name, a.mime, a.size, m.chat_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.blob_sha256 = ? ORDER BY a.rowid',
      )
      .all(sha) as { name: string; mime: string; size: number; chat_id: string }[];
    const row = rows.find((r) => canReadChat(db, p, r.chat_id));
    if (!row || !(await d.files.stat(sha))) return reply.code(404).send({ error: 'not_found' });
    const inline = INLINE_MIME.test(row.mime);
    const safeName = row.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    reply
      .header('content-type', inline ? row.mime : 'application/octet-stream')
      .header('content-length', String(row.size))
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      )
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      );
    return reply.send(d.files.open(sha));
  });
}
