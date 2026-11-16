/**
 * @pasabot/protocol — REST DTOs, WebSocket frames and the event map (ARCHITECTURE.md section 4).
 * Shared by server, web and cli. This package imports nothing from the rest of PasaBot.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

/**
 * An absolute http(s) URL. Every link or frame address that comes from data (agents, channels, registries,
 * connectors) is checked with this when it is stored; the web renders it through `safeHref` (@pasabot/ui) too.
 */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

// ---------- shared enums ----------
export const trustLevelSchema = z.enum(['guarded', 'standard', 'trusted']);
export type TrustLevel = z.infer<typeof trustLevelSchema>;
/**
 * Trust for a NEW agent when neither the request nor the owner's server setting names one: the permissive
 * level (the owner consents once, by creating the agent; tier 2 then runs without asking). Hard caps still
 * apply at every level: channel turns at `standard`, tier 3 always asks, non-owner turns never inherit it.
 */
export const DEFAULT_AGENT_TRUST: TrustLevel = 'trusted';
export const TRUST_ORDER: readonly TrustLevel[] = ['guarded', 'standard', 'trusted'];
/** The lower of two trust levels (trust only ever narrows along a chain, ARCHITECTURE 7.4). */
export const minTrust = (...levels: TrustLevel[]): TrustLevel =>
  levels.reduce((a, b) => (TRUST_ORDER.indexOf(a) <= TRUST_ORDER.indexOf(b) ? a : b));

export const userKindSchema = z.enum(['owner', 'member', 'guest']);
export type UserKind = z.infer<typeof userKindSchema>;

// ---------- DTOs ----------
export const userDtoSchema = z.object({
  id: z.string(),
  kind: userKindSchema,
  displayName: z.string(),
});
export type UserDTO = z.infer<typeof userDtoSchema>;

export const agentLimitsSchema = z.object({
  memMb: z.number().optional(),
  cpuPct: z.number().optional(),
  contextPctCompact: z.number().optional(),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

export const agentDtoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  avatar: z.object({ hue: z.number(), glyph: z.string() }),
  /** generated avatar seed salt (seed = id + salt); '' or absent = the original look; owner-only to change */
  avatarSalt: z.string().optional(),
  instructions: z.string(),
  /**
   * What the agent does in one or two plain sentences (the details panel), derived on the server from its job, never a
   * model call. '' when there is nothing to show this reader (a member never gets one derived from owner instructions).
   */
  summary: z.string().optional(),
  /**
   * The built-in team builder: its instructions are PasaBot's own internal prompt, never sent to a client (they come
   * as '') and never edited from a client; `summary` carries a friendly description instead.
   */
  builtIn: z.boolean().optional(),
  providerId: z.string(),
  model: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  fallback: z.array(z.object({ providerId: z.string(), model: z.string().optional() })),
  workspaceDir: z.string(),
  trustLevel: trustLevelSchema,
  /**
   * "Ask before terminal and raw web commands" (7.1): null = the trust level's default (off at `trusted`, on below);
   * true/false = the owner's explicit choice. Owner session only.
   */
  askShellWeb: z.boolean().nullable().optional(),
  limits: agentLimitsSchema,
  status: z.string(),
  createdAt: z.number(),
  archivedAt: z.number().nullable(),
});
export type AgentDTO = z.infer<typeof agentDtoSchema>;

/** A message block; `kind` is `<module>.<kind>` and must match a server BlockKind. */
export const messageBlockSchema = z.object({
  kind: z.string().regex(/^[a-z0-9_-]+\.[a-z0-9_.-]+$/),
  v: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type MessageBlock = { kind: `${string}.${string}`; v: number; data: unknown };

/**
 * W40 cards: ONE card family for everything a helper needs from, or shows, the owner (block `core.card`). The card's
 * data and its settled state live in the block on the server (so a reload or a phone shows the same card); cards that
 * need an answer are also listed by `GET /api/v1/cards` for the pinned decision bar.
 *
 * Text is a locale key with params (the web renders it in the reader's language; a param whose name ends in `At` is
 * an epoch time the web formats) or plain text the server already wrote. Every string is plain text, rendered as text.
 */
const cardParam = z.union([z.string().max(400), z.number()]);
export const cardTextSchema = z.union([
  z.object({
    key: z.string().regex(/^[a-z0-9_-]+:[A-Za-z0-9_.-]+$/),
    params: z.record(z.string().max(40), cardParam).optional(),
  }),
  z.object({ text: z.string().max(1000) }),
]);
export type CardText = z.infer<typeof cardTextSchema>;
export const CARD_VARIANTS = ['ok', 'info', 'connect', 'result', 'error', 'suggestion'] as const;
export type CardVariant = (typeof CARD_VARIANTS)[number];
export const CARD_STATES = ['open', 'done', 'later', 'dismissed', 'failed'] as const;
export type CardState = (typeof CARD_STATES)[number];
/** An app link inside the web app only (`#/...`); never an outside URL. */
const appHref = z
  .string()
  .max(300)
  .regex(/^#\/[A-Za-z0-9/_\-.?=&%:]*$/);
export const cardActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,39}$/),
  label: cardTextSchema,
  style: z.enum(['primary', 'secondary', 'ghost']).optional(),
  /** opens this page of the app (after the server answered, when the action also settles or runs) */
  href: appHref.optional(),
  /** tap-to-send: the owner's own message, sent in the card's chat */
  send: z.string().max(500).optional(),
  /** the card settles to this state when tapped (Later, Not now, Dismiss) */
  settle: z.enum(CARD_STATES).optional(),
  /** the server does something for this tap (Try again, Undo, Pause), through the card source's handler */
  server: z.boolean().optional(),
});
export type CardAction = z.infer<typeof cardActionSchema>;
export const cardVisualSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    /** an app URL of the file (`/api/...`), opened or downloaded by the owner */
    url: z
      .string()
      .regex(/^\/api\/[A-Za-z0-9/_\-.?=&%]+$/)
      .max(400),
    name: z.string().max(200),
    size: z.number().int().nonnegative(),
    mime: z.string().max(120),
  }),
  /** the live picture of a browser profile (the owner's own browser view; frames arrive on the owner topic) */
  z.object({ kind: z.literal('browser'), profileId: z.string().max(40) }),
]);
export type CardVisual = z.infer<typeof cardVisualSchema>;
export const cardDataSchema = z.object({
  id: z.string().max(40),
  variant: z.enum(CARD_VARIANTS),
  title: cardTextSchema,
  text: cardTextSchema.optional(),
  /**
   * the technical words (an error's raw text), as a poster hands them in: the server never stores them in the block
   * (every reader of the chat gets the block); it keeps them owner-only (`GET /api/v1/cards/:id/detail`)
   */
  detail: z.string().max(2000).optional(),
  /** the card has owner-only Details (shown to the owner with "Technical words" on) */
  hasDetail: z.boolean().optional(),
  actions: z.array(cardActionSchema).max(5),
  /** the owner has to answer it: it is in the pinned decision bar until it settles */
  needsAnswer: z.boolean().optional(),
  state: z.enum(CARD_STATES),
  /** the one line a settled card collapses to (default: the state's own words) */
  settled: cardTextSchema.optional(),
  /** the action the owner tapped */
  chose: z.string().max(40).optional(),
  /** who handles its server actions (`core.run`, `memory`, `orchestrator.ok`, ...) */
  source: z.string().max(60),
  /** one open card per ref: posting the same ref again updates that card (`signin:<agentId>`) */
  ref: z.string().max(120).optional(),
  /** the helper the card is about (its name and face) */
  agentId: z.string().max(40).nullable().optional(),
  visual: cardVisualSchema.optional(),
  /** ids the source's handler needs (a queue item, a memory, a routine); ids only, never secrets */
  meta: z.record(z.string().max(40), z.string().max(200)).optional(),
  at: z.number(),
});
export type CardData = z.infer<typeof cardDataSchema>;
/** An open card that needs an answer, for the pinned decision bar (`GET /api/v1/cards`). */
export interface OpenCardDTO {
  id: string;
  chatId: string;
  messageId: string;
  card: CardData;
}

/**
 * A portable copy of one agent and the chats it is in (W19 export/import). It carries no secrets, no paths, no
 * provider account and no attachments: config + chat titles/members + final messages. Imported data is outside
 * input: the server re-validates it, redacts message bodies and never raises trust above the server default.
 */
export const agentBundleSchema = z.object({
  format: z.literal('pasabot.agent-bundle'),
  v: z.literal(1),
  exportedAt: z.number().int(),
  agent: z.object({
    name: z.string().min(1).max(80),
    slug: z.string().max(80).optional(),
    avatar: z.object({ hue: z.number(), glyph: z.string().max(8) }),
    instructions: z.string().max(100_000),
    providerId: z.string().min(1).max(80),
    model: z.string().max(200).nullable(),
    fallback: z
      .array(z.object({ providerId: z.string().max(80), model: z.string().max(200).optional() }))
      .max(5),
    trustLevel: trustLevelSchema,
    limits: agentLimitsSchema,
  }),
  chats: z
    .array(
      z.object({
        ref: z.string().max(64),
        kind: z.enum(['direct', 'channel']),
        title: z.string().max(200),
        createdAt: z.number().int(),
        messages: z
          .array(
            z.object({
              authorKind: z.enum(['user', 'agent', 'system', 'external']),
              body: z.string().max(1_000_000),
              blocks: z.array(messageBlockSchema).max(50).default([]),
              createdAt: z.number().int(),
            }),
          )
          .max(20_000),
      }),
    )
    .max(500),
});
export type AgentBundle = z.infer<typeof agentBundleSchema>;

export const messageDtoSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  authorKind: z.enum(['user', 'agent', 'system', 'external']),
  authorId: z.string().nullable(),
  replyTo: z.string().nullable(),
  body: z.string(),
  blocks: z.array(messageBlockSchema),
  status: z.enum(['pending', 'streaming', 'final', 'error']),
  runId: z.string().nullable(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
});
export type MessageDTO = Omit<z.infer<typeof messageDtoSchema>, 'blocks'> & { blocks: MessageBlock[] };

export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheTokens: z.number().optional(),
  contextUsed: z.number().optional(),
  contextWindow: z.number().optional(),
  costHint: z.number().optional(),
});
export type UsageSnapshot = z.infer<typeof usageSchema>;

export const runStateSchema = z.enum(['running', 'done', 'failed', 'cancelled', 'interrupted']);
export const runDtoSchema = z.object({
  id: z.string(),
  queueItemId: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  model: z.string().nullable(),
  state: runStateSchema,
  usage: usageSchema.nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  stopReason: z.string().nullable(),
});
export type RunDTO = z.infer<typeof runDtoSchema>;

export const runEventDtoSchema = z.object({
  runId: z.string(),
  n: z.number(),
  type: z.string(),
  data: z.unknown(),
});
export type RunEventDTO = z.infer<typeof runEventDtoSchema>;

export const queueStateSchema = z.enum([
  'queued',
  'leased',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'held',
]);
export type QueueState = z.infer<typeof queueStateSchema>;
export const queueItemDtoSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  chatId: z.string().nullable(),
  seq: z.number(),
  priority: z.number(),
  kind: z.string(),
  state: queueStateSchema,
  attempts: z.number(),
  resumeAt: z.number().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type QueueItemDTO = z.infer<typeof queueItemDtoSchema>;

/**
 * What kind of effect a tool call has (ARCHITECTURE 7.1 "Always asks"). `money`, `outbound-message` and `delete`
 * (a delete outside the calling agent's own workspace, W38) always ask, at every trust level, and never take a
 * per-tool "always allow"; the owner may add `publish` to that set.
 */
export const ACTION_CLASSES = ['money', 'outbound-message', 'delete', 'publish'] as const;
export const actionClassSchema = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof actionClassSchema>;
/** the classes that always ask; the owner may add to them, never remove these */
export const FIXED_ALWAYS_ASK: readonly ActionClass[] = ['money', 'outbound-message', 'delete'];
/** the fields an always-ask card shows per class, in order; a value the call did not give is `null` ("not stated") */
export const ACTION_CLASS_FIELDS: Record<ActionClass, readonly string[]> = {
  money: ['items', 'merchant', 'total', 'paymentMethod'],
  'outbound-message': ['recipients', 'channel', 'subject', 'text'],
  // what is deleted (paths, table, resource), where (another agent, shared, outside the workspace, which server or
  // connector) and how many when known (W38)
  delete: ['target', 'where', 'count'],
  publish: ['target'],
};
/**
 * The card of an always-ask approval: captured by the server from the tool call's arguments (or the page the browser
 * module read), never from the agent's own summary. `undeclared`: a browser action on a page detected as checkout or
 * compose whose call did not declare that intent. `unshown`: names of the call's arguments the summary facts did not
 * read; the card warns "more details not shown" and names them (they are in the exact request).
 */
export const approvalAskSchema = z.object({
  class: actionClassSchema,
  fields: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  undeclared: z.boolean().optional(),
  unshown: z.array(z.string()).max(21).optional(),
});
export type ApprovalAsk = z.infer<typeof approvalAskSchema>;

export const approvalDtoSchema = z.object({
  id: z.string(),
  /** the agent run waiting on it; null for a detached approval (a workflow step) */
  runId: z.string().nullable(),
  agentId: z.string().nullable(),
  /** what a detached approval is about, e.g. `workflow:<runId>:<stepId>`; null for an agent run's */
  subject: z.string().nullable(),
  /** where the owner sees what is being approved (detached approvals) */
  href: z.string().nullable(),
  tier: z.number().int().min(0).max(3),
  summary: z.string(),
  action: z.unknown(),
  /** set on an always-ask approval (money, outbound message, an owner-added class): what exactly will happen */
  ask: approvalAskSchema.nullable().optional(),
  /**
   * The card's own value (ARCHITECTURE 8 "Screen helpers"): an approve over REST carries it, so one card's answer
   * never approves another. Only in what the owner's app renders; never in what modules or agents read.
   */
  nonce: z.string().optional(),
  /** a computer-use action (sees or drives a screen): approving it needs a fresh re-auth for this one card */
  screen: z.boolean().optional(),
  state: z.enum(['pending', 'approved', 'denied', 'expired']),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().nullable(),
  expiresAt: z.number(),
});
export type ApprovalDTO = z.infer<typeof approvalDtoSchema>;

// ---------- events ----------
/**
 * The domain event map. Modules extend it by augmentation, never by editing this file:
 * `declare module '@pasabot/protocol' { interface EventMap { 'routine.fired': RoutineFireDTO } }`
 */
export interface EventMap {
  'message.created': MessageDTO;
  'message.updated': MessageDTO;
  'message.deleted': { id: string; chatId: string };
  'run.started': RunDTO;
  'run.finished': RunDTO;
  'run.event': RunEventDTO;
  'queue.changed': { agentId: string; items: QueueItemDTO[]; paused: boolean };
  /**
   * An item was refused at dispatch time (its kind's `admit` or a queue gate) and ended `cancelled` without a run;
   * published on `agent:<id>`, so the module that enqueued it can report it (routines: the fire is `skipped`).
   * `workflowRunId`: the workflow run the item is a step of (from its source), so a routine that started that run
   * can report its fire too.
   */
  'queue.refused': {
    itemId: string;
    agentId: string;
    chatId: string | null;
    kind: string;
    reason: string;
    workflowRunId?: string;
  };
  'approval.requested': ApprovalDTO;
  'approval.resolved': ApprovalDTO;
  'agent.updated': AgentDTO;
  'agent.context': { agentId: string; used: number; window: number };
  /**
   * The orchestrator retried a turn on another provider/model/account after a provider error (fallback, 5.1), or on
   * the same one after a context overflow; published on `agent:<id>` (owner only). Modules post the chat notice.
   */
  'provider.switched': {
    agentId: string;
    chatId: string | null;
    /** the run that failed */
    runId: string;
    /** `offline`: the primary was unreachable and the item was marked "run even offline" (W34) */
    reason: 'rate_limit' | 'quota' | 'auth' | 'context_overflow' | 'offline';
    from: { providerId: string; model: string | null; accountId: string | null };
    to: { providerId: string; model: string | null; accountId: string | null };
  };
  /** after a turn, the native session of that chat was compacted (`native`) or ended for a reseed (`reseed`) */
  'provider.compacted': {
    agentId: string;
    chatId: string | null;
    runId: string;
    mode: 'native' | 'reseed';
    contextUsed: number;
    contextWindow: number;
  };
  /** a chat was opened server-side (routine thread, channel place): clients refetch their membership-filtered list */
  'chat.created': { id: string };
  /** someone (a person or an agent) added or removed a reaction on a message of this chat */
  'reaction.changed': { chatId: string; messageId: string };
  notification: { level: 'info' | 'warn' | 'error'; text: string; href?: string; cardId?: string };
  /** W40: a card was posted, changed or settled (owner topic): the pinned decision bar refetches its open cards */
  'card.changed': { id: string; chatId: string; state: CardState };
  /** work one helper gave another started, changed or ended (owner only): the chats list refetches who works for whom */
  'collab.tasks': { at: number };
}
export type EventType = keyof EventMap & string;

// ---------- WebSocket frames ----------
export type Topic =
  | 'global'
  /** owner-only events that belong to no chat or agent (detached approvals) */
  | 'owner'
  | `chat:${string}`
  | `agent:${string}`
  | `run:${string}`
  | `module:${string}`;
export const topicSchema = z
  .string()
  .regex(/^(global|owner|(chat|agent|run|module):[A-Za-z0-9_.:-]+)$/) as unknown as z.ZodType<Topic>;
export const isTopic = (s: string): s is Topic => topicSchema.safeParse(s).success;

export type LiveType = 'message.delta' | 'run.tick' | 'browser.frame';

export type C2S =
  | { t: 'hello'; v: 1; token?: string; resumeFrom?: number }
  | { t: 'sub'; topics: Topic[] }
  | { t: 'unsub'; topics: Topic[] }
  | { t: 'typing'; chatId: string }
  | { t: 'ping'; n: number };

export type S2C =
  | { t: 'welcome'; serverId: string; seq: number; user: UserDTO }
  | { t: 'ev'; seq: number; topic: Topic; type: EventType; data: unknown }
  | { t: 'live'; topic: Topic; type: LiveType; data: unknown }
  | { t: 'gap'; from: number }
  | { t: 'pong'; n: number }
  | { t: 'bye'; reason: string };

export const c2sSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.literal(1),
    token: z.string().optional(),
    resumeFrom: z.number().int().nonnegative().optional(),
  }),
  z.object({ t: z.literal('sub'), topics: z.array(topicSchema).max(256) }),
  z.object({ t: z.literal('unsub'), topics: z.array(topicSchema).max(256) }),
  z.object({ t: z.literal('typing'), chatId: z.string() }),
  z.object({ t: z.literal('ping'), n: z.number() }),
]) as unknown as z.ZodType<C2S>;

export const s2cSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), serverId: z.string(), seq: z.number(), user: userDtoSchema }),
  z.object({ t: z.literal('ev'), seq: z.number(), topic: topicSchema, type: z.string(), data: z.unknown() }),
  z.object({
    t: z.literal('live'),
    topic: topicSchema,
    type: z.enum(['message.delta', 'run.tick', 'browser.frame']),
    data: z.unknown(),
  }),
  z.object({ t: z.literal('gap'), from: z.number() }),
  z.object({ t: z.literal('pong'), n: z.number() }),
  z.object({ t: z.literal('bye'), reason: z.string() }),
]) as unknown as z.ZodType<S2C>;

// ---------- REST ----------
export const errorBodySchema = z.object({ error: z.string(), message: z.string().optional() });
export type ErrorBody = z.infer<typeof errorBodySchema>;
export const healthDtoSchema = z.object({ ok: z.literal(true), serverId: z.string(), version: z.string() });
export type HealthDTO = z.infer<typeof healthDtoSchema>;

// ---------- host allow-lists ----------
/**
 * Is `host` allowed by `patterns` (exact host, or `*.suffix` = the suffix itself or any subdomain of it)? The one
 * matcher every store and browser allow-list uses (store packs, the browser port, the Shop page's links and
 * images): `*.shopee.ph` allows `shopee.ph` and `a.shopee.ph`, never `evilshopee.ph` or `shopee.ph.evil.com`.
 */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    if (typeof raw !== 'string') return false;
    const p = raw.toLowerCase();
    if (!p.startsWith('*.')) return h === p;
    const base = p.slice(2);
    return !!base && (h === base || h.endsWith(`.${base}`));
  });
}

/** Is `url` an http(s) URL without user info whose host one of `patterns` allows? (Anything unparsable is not.) */
export function urlAllowed(url: unknown, patterns: readonly string[]): boolean {
  if (typeof url !== 'string' || !Array.isArray(patterns)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  return hostAllowed(u.hostname, patterns);
}
