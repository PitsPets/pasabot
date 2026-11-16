/** Ports other than providers (ARCHITECTURE.md 5.2–5.5) plus the small host services every module sees. */
import type { Readable } from 'node:stream';
import type {
  ActionClass,
  AgentBundle,
  AgentDTO,
  AgentLimits,
  ApprovalAsk,
  ApprovalDTO,
  CardAction,
  CardData,
  CardState,
  CardText,
  CardVariant,
  CardVisual,
  EventMap,
  EventType,
  LiveType,
  MessageBlock,
  MessageDTO,
  QueueItemDTO,
  RunDTO,
  Topic,
  TrustLevel,
} from '@pasabot/protocol';
import type { ZodType } from 'zod';
import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderErrorKind,
  ProviderId,
  ProviderPolicy,
  SenderInfo,
  UntrustedBlock,
} from './provider.js';

// ---------- logging ----------
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------- event bus ----------
export interface BusEvent {
  /** set for persisted events (global, monotonic); absent for live frames */
  seq?: number;
  topic: Topic;
  type: string;
  data: unknown;
  live?: boolean;
}
export interface EventBus {
  /** Persist into the `events` ring and fan out. Returns the global seq. */
  publish<K extends EventType>(topic: Topic, type: K, data: EventMap[K]): number;
  /** Ephemeral frame (deltas, ticks, browser frames); never persisted. */
  live(topic: Topic, type: LiveType, data: unknown): void;
  subscribe(listener: (ev: BusEvent) => void): () => void;
}

// ---------- 5.2 channels ----------
export interface RemoteFile {
  url: string;
  name: string;
  mime?: string;
  size?: number;
}
export interface InboundMessage {
  externalId: string;
  placeId: string;
  sender: { externalId: string; name: string; isBot: boolean };
  text: string;
  attachments: RemoteFile[];
  replyToExternalId?: string;
  mentionsBot: boolean;
  at: number;
}
export interface OutboundMessage {
  text: string;
  attachments?: RemoteFile[];
  replyToExternalId?: string;
}
export interface PlaceInfo {
  id: string;
  title: string;
  kind: 'dm' | 'group' | 'channel';
}
export type ChannelStatus = 'connected' | 'reconnecting' | 'auth_failed' | 'stopped';
/**
 * Opaque per-binding state an adapter keeps between connections (e.g. a WhatsApp linked-device session). The host
 * keeps it in the vault, never in `channels_binding.config`; `save('')` clears it.
 */
export interface ChannelStateStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}
/** A public HTTP request for a binding (e.g. Slack Events), with the exact bytes received. */
export interface ChannelHttpRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}
export interface ChannelHttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface ChannelContext {
  bindingId: string;
  log: Logger;
  signal: AbortSignal;
  /** present when the host stores adapter state (the binding runtime and the pairing flow do) */
  state?: ChannelStateStore;
  /**
   * Present when the host keeps an audit trail (the binding runtime does): the adapter records something the owner
   * should be able to see that never became a message, e.g. platform messages it had to skip. The host writes
   * `channel.<action>` against this binding with `data` redacted; `action` is `[a-z0-9_.]`, at most 60 chars.
   */
  audit?(action: string, data: Record<string, unknown>): void;
}
export interface ChannelConnection {
  inbound: AsyncIterable<InboundMessage>;
  send(placeId: string, msg: OutboundMessage): Promise<{ externalId: string }>;
  edit?(placeId: string, externalId: string, msg: OutboundMessage): Promise<void>;
  react?(placeId: string, externalId: string, emoji: string): Promise<void>;
  listPlaces(): Promise<PlaceInfo[]>;
  status(): ChannelStatus;
  close(): Promise<void>;
  /**
   * Inbound over HTTP (adapters with `inboundHttp`): the host hands it the public request for this binding
   * (`/hooks/channels/<bindingId>/events`); the adapter checks the platform signature itself.
   */
  handleHttp?(req: ChannelHttpRequest): Promise<ChannelHttpResponse>;
}
export interface ChannelAdapter<Cfg = unknown> {
  readonly kind: 'telegram' | 'discord' | 'slack' | 'whatsapp' | (string & {});
  readonly configSchema: ZodType<Cfg>;
  /** stored in the vault, never in channels_binding.config */
  readonly secretFields: (keyof Cfg)[];
  /** non-secret config fields the owner may set in Settings (kept in channels_binding.config) */
  readonly options?: Partial<Record<keyof Cfg, 'boolean' | 'string'>>;
  /** the platform pushes messages to a public URL (`ChannelConnection.handleHttp`) */
  readonly inboundHttp?: boolean;
  connect(cfg: Cfg, ctx: ChannelContext): Promise<ChannelConnection>;
  /** link flow that stores its result in `ctx.state` (e.g. a QR code scanned as a linked device) */
  pairing?(ctx: ChannelContext): AsyncIterable<{ qr?: string; code?: string; done?: true }>;
}

// ---------- 5.3 triggers ----------
export interface TriggerFire {
  routineId: string;
  at: number;
  source: string;
  payload: unknown;
  idemKey: string;
}
export type Disarm = () => Promise<void>;
export interface TriggerSource<Spec = unknown> {
  readonly kind: 'manual' | 'schedule' | 'webhook' | 'event' | 'github' | (string & {});
  readonly specSchema: ZodType<Spec>;
  arm(id: string, spec: Spec, fire: (f: TriggerFire) => Promise<void>): Disarm;
  test?(spec: Spec): Promise<TriggerFire>;
}

// ---------- 5.4 tools and connectors ----------
export type ApprovalTier = 0 | 1 | 2 | 3;
export interface ScopedVault {
  /** Resolve a `{{secret:name}}` reference granted to this agent (tier 3 for raw reads). */
  resolve(ref: string): Promise<string>;
}
export interface ToolCtx {
  run: RunDTO;
  agent: AgentDTO;
  sender: SenderInfo;
  signal: AbortSignal;
  log: Logger;
  vault: ScopedVault;
  net: SafeNet;
  files: BlobStore;
  emit(ev: Partial<EventMap>): void;
}
export interface ToolDef<I = unknown, O = unknown> {
  /** snake_case, globally unique, module-prefixed: "memory_search" */
  name: string;
  /** English; what a person reads is `titleKey` in their language */
  title: string;
  /** W24: the title's locale key; the module host sets `<module>:tools.<name>` when a module leaves it out */
  titleKey?: string;
  description: string;
  input: ZodType<I>;
  output?: ZodType<O>;
  tier: ApprovalTier | ((input: I, ctx: ToolCtx) => ApprovalTier);
  /**
   * Widens access (trust, allowlists, "always allow", MCP levels, tokens, sender trust). Widening tools are
   * owner-only REST concerns: the `/mcp` gateway never lists or invokes them (ARCHITECTURE 4.1, 7.4).
   */
  widens?: boolean;
  /**
   * Never covered by a per-tool "always allow" (ARCHITECTURE 7.1): the owner is asked every time, at every trust
   * level, and setting "always allow" for it is refused. For tools whose individual calls the owner must see.
   */
  noAlwaysAllow?: boolean;
  /**
   * Computer use (ARCHITECTURE 8 "Screen helpers"): a call sees or drives a screen the owner may be looking at, so
   * a synthetic click could land on the owner's own approval cards. Its approval needs a fresh re-auth for that one
   * card (the 5-minute window never counts), an agent has at most one such approval pending, and while one runs (and
   * 2 s after) the server refuses every approval.
   */
  screenControl?: boolean;
  /**
   * What kind of effect a call has (ARCHITECTURE 7.1 "Always asks"). A call whose class is `money`,
   * `outbound-message`, `delete` or one the owner added asks every time, at every trust level, with no "always
   * allow". `delete` means a delete outside the calling agent's own workspace (another agent's or shared data, a
   * remote resource): a tool whose delete may stay inside the workspace returns it per call, never statically. A
   * function decides per call from the server's own state (a stored classification, the page the browser read);
   * it must never trust a class the agent wrote, except to ADD one.
   */
  actionClass?:
    | ActionClass
    | ((input: I, ctx: ToolCtx) => ActionClass | undefined | Promise<ActionClass | undefined>);
  /**
   * The always-ask card's facts for a call of `cls` (keys from `ACTION_CLASS_FIELDS`), captured by the server from
   * the arguments or the page; without it the gateway reads well-known argument names. Never the agent's summary.
   */
  actionDetails?(input: I, ctx: ToolCtx, cls: ActionClass): ApprovalAsk | Promise<ApprovalAsk>;
  handler(input: I, ctx: ToolCtx): Promise<O>;
}
/**
 * A run-time check on every `/mcp` gateway tool call, before approvals and before the handler (W31 skill manifests).
 * Return a plain refusal reason to refuse the call (the agent sees it as a tool error), or null to let it through.
 * A throw counts as a refusal. Guards only narrow: they can never approve a call the tiers would ask about.
 */
export type ToolCallGuard = (call: {
  name: string;
  input: unknown;
  def: ToolDef;
  run: RunDTO;
  agent: AgentDTO;
  /** the call's resolved action class (a tool's dynamic class worked out by the gateway), when it has one */
  actionClass?: ActionClass;
}) => string | null | Promise<string | null>;
export interface ToolRegistry {
  add<I, O>(def: ToolDef<I, O>): void;
  get(name: string): ToolDef | undefined;
  list(): ToolDef[];
  /** Validates input (and output when declared) and runs the handler. Approval gating is W0b's. */
  invoke(name: string, input: unknown, ctx: ToolCtx): Promise<unknown>;
  /** add a run-time guard every gateway call passes first; returns its remover */
  addGuard(g: ToolCallGuard): () => void;
  /** the first guard's refusal for this call, or null (the gateway calls it) */
  refusal(call: Parameters<ToolCallGuard>[0]): Promise<string | null>;
}

export interface ConnectorManifest {
  schema: 'pasabot.connector/v1';
  slug: string;
  name: string;
  version: string;
  category: string;
  summary: string;
  icon?: string;
  homepage?: string;
  kind: 'mcp-stdio' | 'mcp-http' | 'oauth-api';
  /**
   * `env` and `headers` values (and `args`/`url`) may name `{{secret:<field key>}}` (a secret auth field, or
   * `oauth_token` for `oauth2_pkce`) and `{{field:<field key>}}` (a non-secret field); `headers` are sent by an
   * `mcp-http` server, e.g. `Authorization: Bearer {{secret:token}}`.
   */
  mcp?: {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  auth?: {
    type: 'none' | 'api_key' | 'oauth2_pkce';
    fields?: { key: string; label: string; secret: boolean }[];
    oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[]; clientIdFrom: 'owner' };
  };
  network?: { allowHosts: string[] };
  defaultTier?: ApprovalTier;
  /** the action class of the server's tools by tool name (7.1 "Always asks"); the owner can still correct each */
  toolClasses?: Record<string, ActionClass>;
}

// ---------- 5.5 other ports ----------
/** Who caused an item to be saved: the turn's sender kind and the effective trust of that turn (7.4). */
export interface MemoryOrigin {
  sender: SenderInfo['kind'];
  /**
   * the sender's own id (a member's or guest's user id, a channel stranger's platform id): a non-owner turn reads
   * back only items saved during that same person's turns. Absent or null (older items, a backend that does not
   * keep it) = unknown: such items are read on owner turns only.
   */
  senderId?: string | null;
  trust: TrustLevel;
}
export interface MemoryInput {
  agentId: string | null;
  text: string;
  tags?: string[];
  source?: string;
  /** recorded with the item and returned by search/list, so a later turn can tell owner facts from injected ones */
  origin?: MemoryOrigin;
}
export interface MemoryQuery {
  agentId: string | null;
  text: string;
  limit?: number;
  includeShared?: boolean;
}
export interface MemoryItem {
  id: string;
  agentId: string | null;
  text: string;
  tags: string[];
  source?: string;
  /** absent on items saved before origins were recorded: treat as unknown (not owner) */
  origin?: MemoryOrigin;
  createdAt: number;
}
export interface MemoryHit extends MemoryItem {
  score: number;
}
export interface MemoryFilter {
  agentId?: string | null;
  tag?: string;
  limit?: number;
}
export interface MemoryBackend {
  id: string;
  remember(m: MemoryInput): Promise<string>;
  search(q: MemoryQuery): Promise<MemoryHit[]>;
  forget(id: string): Promise<void>;
  list(f: MemoryFilter): Promise<MemoryItem[]>;
}
/** Memory backends by id: the memory module registers `local`, plugins (Hindsight) add theirs; the owner picks one. */
export interface MemoryRegistry {
  register(b: MemoryBackend): void;
  get(id: string): MemoryBackend | undefined;
  list(): MemoryBackend[];
  /** W33: the memory module installs the pool's export/import port here (once). */
  setPool(p: MemoryPoolPort): void;
  /**
   * W33 export port (used by the W32 bundle): absent when no memory module is loaded. The host wraps it so every
   * call checks its actor (the owner user, or `asSystem(reason)`) before the module sees it.
   */
  pool(): MemoryPoolPort | undefined;
}
/** One memory entry as it travels in an agent bundle (W32): only data, never ids of the source server. */
export interface MemoryExportEntry {
  text: string;
  tags: string[];
  key?: string;
  confidence?: 'low' | 'high';
  source?: string;
  /** who wrote it on the source server (provenance) */
  writer: { kind: 'owner' | 'agent' | 'import' };
  trust: TrustLevel;
  createdAt: number;
}
export type MemoryPoolActor = AgentAdminActor | SystemActor;
export interface MemoryPoolPort {
  /** the agent's own (private) scope; forgotten or superseded entries are never included */
  exportAgent(actor: MemoryPoolActor, agentId: string): Promise<MemoryExportEntry[]>;
  /** writes entries into the agent's private scope; each entry's trust is lowered to at most `maxTrust` (7.4) */
  importAgent(
    actor: MemoryPoolActor,
    agentId: string,
    entries: MemoryExportEntry[],
    o: { maxTrust: TrustLevel },
  ): Promise<number>;
}

// ---------- skill manifests in the agent bundle (W31 x W32) ----------
/** The file the skills module writes into every synced skill folder of a workspace: `{ id, name, rev }` (JSON). */
export const SKILL_SYNC_MARKER = '.pasabot-skill.json';
/** One skill's owner-approved W31 permission manifest as it travels in an agent bundle (data, checked on import). */
export interface SkillManifestExport {
  skillId: string;
  /** the W31 manifest JSON (files / network / messaging / tools); the safety module validates it on import */
  manifest: unknown;
}
export type SkillManifestActor = AgentAdminActor | SystemActor;
export interface SkillManifestPort {
  /** the owner-approved manifests of these skills; a pending (unapproved) proposal is never exported */
  exportManifests(actor: SkillManifestActor, skillIds: string[]): Promise<SkillManifestExport[]>;
  /**
   * Stores each manifest as a PROPOSAL the owner approves or rejects, never as an approved (enforced) one, whatever
   * the bundle says (7.4: only the owner widens). `by` is the agent it came with; its trust is at most `maxTrust`.
   * A manifest equal to the approved one, or a skill that already has a pending proposal, is skipped.
   */
  importProposals(
    actor: SkillManifestActor,
    entries: SkillManifestExport[],
    o: { by: string; maxTrust: TrustLevel },
  ): Promise<{ proposed: number; skipped: number }>;
}
/** ModuleHost.skillManifests: the safety module installs the port (once); the host wraps it with the actor check. */
export interface SkillManifestRegistry {
  setPort(p: SkillManifestPort): void;
  /** absent when no safety module is loaded; every call checks its actor (the owner user, or `asSystem(reason)`) */
  port(): SkillManifestPort | undefined;
}

// ---------- prompt context (W33) ----------
// UntrustedBlock (the block a contributor returns) lives in provider.ts next to TurnInput.context
export interface PromptContextRequest {
  agent: AgentDTO;
  sender: SenderInfo;
  /** the turn's user text (for relevance search) */
  text: string;
  chatId: string | null;
}
export interface PromptContributor {
  /** unique, usually the module id */
  id: string;
  /** called for agent turns with tools (never tool-less steps); a slow or failing contributor is skipped */
  contribute(req: PromptContextRequest): Promise<UntrustedBlock | null>;
}
export interface PromptContextRegistry {
  register(c: PromptContributor): void;
  get(id: string): PromptContributor | undefined;
  list(): PromptContributor[];
}

export interface SecretRef {
  id: string;
  scope: string;
  name: string;
}
export interface SecretMeta extends SecretRef {
  backend: string;
  createdAt: number;
  rotatedAt: number | null;
}
export interface AccessReason {
  actor: string;
  purpose: string;
  runId?: string;
}
export interface VaultBackend {
  id: string;
  resolve(ref: string): Promise<string>;
  test(): Promise<boolean>;
}
export interface SecretVault {
  put(scope: string, name: string, value: string): Promise<SecretRef>;
  /**
   * A reference into a read-only backend (`bitwarden`, `1password`): only `ref` is stored, the value is fetched
   * through the registered backend on every `get` and then joins the redaction set. Replaces an entry of the same
   * scope + name.
   */
  putRef(scope: string, name: string, backend: string, ref: string): Promise<SecretRef>;
  get(ref: SecretRef, why: AccessReason): Promise<string>;
  list(scope?: string): Promise<SecretMeta[]>;
  /** Deletes one entry; false when there was none. Its last value stays in the redaction set until a restart. */
  remove(id: string): Promise<boolean>;
  rotateKey(): Promise<void>;
  /** for redaction */
  knownValues(): Iterable<string>;
  addBackend(b: VaultBackend): void;
}

/**
 * Text the server writes for a person to read, as a locale key and its params (`<namespace>:<key>`, e.g.
 * `core:server.approval.needed`): the web translates it in the viewer's language; push, channels and stored text
 * are rendered on the server in the person's saved language (`ServerI18n`). Params are data, never translated.
 */
export interface Msg {
  key: string;
  /** a param that is itself a `Msg` (a tool's title) is rendered in the same language first */
  params?: Record<string, string | number | Msg>;
  /** English to show when no locale file has `key` (an outside tool's own title) */
  fallback?: string;
}

/** Server-side translation (W24): the owner's saved app language and the merged locale files. */
export interface ServerI18n {
  /** the language a person saved in the app (`PUT /api/v1/me/language`); the owner's without `userId`; else `en` */
  language(userId?: string | null): string;
  /** `key` (with its namespace) in `lng` (default: the owner's language); English when the language lacks it */
  t(key: string, params?: Record<string, string | number>, lng?: string): string;
  /** a `Msg` in `lng` (default: the owner's language) */
  render(m: Msg, lng?: string): string;
}

export interface Notification {
  userId?: string;
  level: 'info' | 'warn' | 'error';
  /** English, for logs and old clients; `msg` (when given) is what a person reads, in their own language */
  title: string;
  body?: string;
  /** the title and body as locale keys: push and channels get them rendered in the person's saved language */
  msg?: { title: Msg; body?: Msg };
  href?: string;
  /**
   * Extra transports for this one notification. `channel:<bindingId>` posts it to the owner's own linked DM on that
   * channel binding (W4b runtime). When `via` is given, `notify` rejects if a named transport is missing or fails
   * (the in-app notification still goes out), so a caller can report that nothing was sent.
   */
  via?: ('push' | `channel:${string}`)[];
  /**
   * What this is about (W23): push lets each device choose which kinds it gets. Without it a notification counts as
   * `alert`. `tag` groups notifications that replace each other on a device (e.g. `run:<id>`: progress, then done).
   */
  category?: 'approval' | 'run.failed' | 'run.finished' | 'progress' | 'alert';
  tag?: string;
  /**
   * W40: the in-app notification is a card in a chat (never a toast): by default in the chat its `href` names, else
   * in the main helper's own chat, with Open (the href) and Dismiss. `false`: no card (the sender already posted one,
   * or an approval card says it). Given, it shapes the card: its own buttons, whether it needs an answer (then it is
   * in the pinned decision bar too), a ref (a later notice with the same ref updates that card), the source whose
   * handler runs its server actions, and a visual.
   */
  card?: false | NotificationCard;
  /**
   * The module that sent it, stamped by the module host (a module cannot set it for itself). A notice card may claim
   * a card `source` (its server actions, meta) only when that source is the sender's own (`<id>` or `<id>.*`).
   */
  fromModule?: string;
}
export interface NotificationCard {
  variant?: CardVariant;
  title?: CardText;
  text?: CardText;
  actions?: CardAction[];
  needsAnswer?: boolean;
  ref?: string;
  source?: string;
  agentId?: string | null;
  visual?: CardVisual;
  meta?: Record<string, string>;
  /** the chat the card goes in (instead of the href's or the main helper's) */
  chatId?: string;
}
/** What a card source does when the owner taps one of its `server` actions; returns how the card settles. */
export type CardActionHandler = (o: {
  card: CardData;
  action: CardAction;
  chatId: string;
  userId: string;
}) => Promise<CardSettle | undefined> | CardSettle | undefined;
export interface CardSettle {
  state: CardState;
  settled?: CardText;
}
/** The input of a card: everything but its id, state and time (the port sets them). */
export type CardInput = Omit<CardData, 'id' | 'state' | 'at'> & { state?: CardState };
/**
 * W40 cards for modules (block `core.card`; protocol `CardData`). A card is a message in a chat, authored by a helper
 * (`agentId`) or the system; its state lives in the block, so it survives a reload and shows the same on every
 * device. Cards that need an answer are also in the owner's pinned decision bar until they settle.
 */
export interface CardsPort {
  /**
   * Posts a card (an open card with the same `ref` in that chat is updated instead); returns it, or null without a
   * chat. `files`: blobs already in the blob store that the card hands to the owner (a file a helper made); they are
   * attached to the card's message, so the people who can read that chat (and only they) can open or download them.
   */
  post(o: {
    chatId: string;
    authorAgentId?: string | null;
    card: CardInput;
    files?: { sha256: string; name: string; mime: string; size: number }[];
  }): CardData | null;
  /** Settles a card (it collapses to one line); null when it is gone or already settled. */
  settle(cardId: string, s: CardSettle & { chose?: string }): CardData | null;
  /** Settles every open card with this ref (its cause is gone: signed in again, key given); returns how many. */
  settleRef(ref: string, s: CardSettle): number;
  /** The handler of `server` actions on cards whose `source` is `source` (a module may claim only its own id or `<id>.*`). */
  onAction(source: string, handler: CardActionHandler): void;
  /** The main helper's own chat (the team builder's), or null. */
  mainChat(): { chatId: string; agentId: string } | null;
}
export interface NotifyTransport {
  /** `push`, or `channel` (handles every `channel:<bindingId>` entry of `via`) */
  id: string;
  send(n: Notification): Promise<void>;
}
/** core = in-app (publishes a `notification` event); W23 adds web push. */
export interface Notifier {
  notify(n: Notification): Promise<void>;
  addTransport(t: NotifyTransport): void;
}

export interface RunnerLimits {
  apply(agentId: string, limits: AgentLimits): Promise<void>;
  sample(agentId: string): Promise<{ memMb: number; cpuPct: number }>;
}

export type Png = Uint8Array;
export type PointerOrKeyAction =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string };
export interface DisplayInfo {
  width: number;
  height: number;
  scale: number;
}
export interface ComputerDriver {
  screenshot(): Promise<Png>;
  act(a: PointerOrKeyAction): Promise<void>;
  display(): DisplayInfo;
}

export interface BlobMeta {
  sha256?: string;
  size?: number;
  mime?: string;
  name?: string;
  /**
   * The user who uploaded these bytes. Recorded per (blob, user): a user may attach a blob to a message only when
   * they uploaded it or it is already attached in a chat they can read (knowing a hash is never enough).
   */
  uploadedBy?: string;
}
export interface BlobRef {
  sha256: string;
  size: number;
}
export interface BlobStore {
  put(stream: Readable, meta: BlobMeta): Promise<BlobRef>;
  open(sha: string): Readable;
  stat(sha: string): Promise<BlobMeta | null>;
}

/**
 * Outbound network with the SSRF guard (implemented by @pasabot/safe-net, W0b). `allowHosts` lets the named hosts
 * resolve to private addresses (it is not a whitelist). `maxBytes` / `timeoutMs` raise or lower the default body
 * cap (10 MB) and timeout (30 s) for one call, e.g. a large download; safe-net clamps them (at most 512 MB, 15 min).
 * Redirects are always followed (re-vetted per hop, max 5); `redirect` in the init is ignored.
 */
export interface SafeNetInit extends RequestInit {
  allowHosts?: string[];
  maxBytes?: number;
  timeoutMs?: number;
}
export interface SafeNet {
  fetch(url: string, init?: SafeNetInit): Promise<Response>;
}

export interface ApprovalRequest {
  runId: string;
  agentId: string;
  tier: ApprovalTier;
  action: unknown;
  /** English; with `msg` the stored summary is `msg` in the owner's saved language (channels and push read it) */
  summary: string;
  msg?: Msg;
  expiresInMs?: number;
  /** an always-ask approval's card (7.1): only the owner's web session answers it, never a channel or a module */
  ask?: ApprovalAsk;
  /** a computer-use action (`ToolDef.screenControl`): fresh re-auth for this one card, one pending per agent */
  screen?: boolean;
}
/**
 * An approval no agent run waits on (a workflow's approval step, W9). It is a core approval like any other (the
 * decision bar, `/api/v1/approvals`, the "needs you" count), but it outlives a restart: the decision reaches the
 * module as `approval.resolved` on the bus (topic `owner`) with this `subject`, and `get(id)` reads it back.
 */
export interface DetachedApprovalRequest {
  /** `<module>:<what>`, e.g. `workflow:<runId>:<stepId>`; one pending approval per subject (opening it again returns the same id) */
  subject: string;
  tier: ApprovalTier;
  action: unknown;
  /** English; with `msg` the stored summary is `msg` in the owner's saved language (channels and push read it) */
  summary: string;
  msg?: Msg;
  expiresInMs?: number;
  /** where the owner sees what is being approved, e.g. `/workflows` */
  href?: string;
  /** an always-ask card (7.1) built by the server (W30 Buy button: a money card); only the owner's web session answers it */
  ask?: ApprovalAsk;
}
export interface ApprovalService {
  request(r: ApprovalRequest): Promise<'approved' | 'denied' | 'expired'>;
  /** files a detached approval and returns its id (idempotent per pending subject) */
  open(r: DetachedApprovalRequest): string;
  get(id: string): ApprovalDTO | null;
  /**
   * The owner's decision taken in a module's own owner-only screen (the core REST is the other way in); null when
   * the approval is not pending. `by` is the deciding user id. Tier-3 approvals are refused here (re-auth is REST-only).
   */
  decide(id: string, decision: 'approved' | 'denied', by: string): ApprovalDTO | null;
  /** a pending detached approval nobody needs any more (its run was cancelled) ends as `expired` */
  withdraw(id: string): void;
  /**
   * Computer use (ARCHITECTURE 8 "Screen helpers"): a helper was just handed control of a screen the owner uses
   * (a grant was issued). For the next 30 s, approving money, deleting, messages to others, the vault or trust and
   * permission changes (every tier-3 or always-ask card) needs a fresh re-auth for that one card.
   */
  noteScreenGrant?(): void;
}

/**
 * Workflows something else may start (W9 + W8: a routine that targets a workflow). The workflows module sets the
 * starter; other modules look it up at call time, so module registration order does not matter.
 */
export interface WorkflowStarter {
  list(): { id: string; name: string; createdBy: string; createdTrust: TrustLevel }[];
  /**
   * Starts a run. `sender` is who the run acts for; the starter caps it at the workflow's own `created_trust` and at
   * its maker's current trust (lowest in the chain), and never lets an agent-made workflow act as the owner. Rejects
   * when the workflow does not exist.
   */
  start(o: {
    workflowId: string;
    sender: SenderInfo;
    startedBy: string;
    input?: string;
  }): Promise<{ runId: string }>;
  /**
   * the run's state (`running`, `done`, `failed`, `rejected`, `stopped`, `cancelled`), its error and who started it
   * (`startedBy`, e.g. `routine:<id>`: W32 refuses a routine-started run's steps at a budget cap), or null
   */
  runState(runId: string): { state: string; error: string | null; startedBy?: string } | null;
}
export interface FlowRegistry {
  set(s: WorkflowStarter): void;
  get(): WorkflowStarter | undefined;
}

/**
 * Routines something else may list, start and stop (W28: what a linked machine's `manage` grant adds). The routines
 * module sets it; other modules look it up at call time. Never secrets (no webhook URLs or prompts with payloads),
 * never settings: only names, state and the two actions.
 */
export interface RoutineSummary {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  target: string;
  /** the trigger kind (`schedule`, `webhook`, …), never its spec */
  trigger: string;
  lastFireAt: number | null;
  lastResult: string | null;
  /** fires still queued or running */
  active: number;
}
export interface RoutineControl {
  list(): RoutineSummary[];
  /**
   * Fires a routine now for `sender` (never the owner): the work runs at the lowest of the routine's own trust, its
   * agent's trust and `sender.trust`. A paused routine stays paused (skipped).
   */
  start(o: { routineId: string; sender: SenderInfo }): Promise<{ status: string; reason?: string }>;
  /** Pauses the routine (no more fires until the owner turns it back on) and cancels its queued or running fires. */
  stop(o: { routineId: string; by: string }): { paused: boolean; cancelled: number };
}
export interface RoutineRegistry {
  set(c: RoutineControl): void;
  get(): RoutineControl | undefined;
}

// ---------- managed browser for other modules (W15 x W30) ----------
/**
 * The structured data of the page a managed browser profile shows (W30 product capture). Everything here was read
 * from an outside page: untrusted data, never instructions, rendered as text only.
 */
export interface BrowserPageData {
  /** the address after navigation (always on the caller's `allowedHosts`) */
  url: string;
  title: string;
  /** the text of each `<script type="application/ld+json">` (bounded) */
  jsonLd: string[];
  /** `<meta property|name|itemprop content>` pairs (bounded) */
  meta: { key: string; value: string }[];
  /** `[itemprop]` elements: their content/src/href attribute, else their text (bounded) */
  microdata: { prop: string; value: string }[];
  /** each asked CSS selector's first match: its content/src/value attribute, else its text; null when absent */
  selected: Record<string, string | null>;
  /** what the page shows that only the owner may handle */
  signals: {
    /** a captcha or bot check */
    captcha: boolean;
    /** card or bank-account entry fields */
    cardField: boolean;
    /** a password field (a sign-in or sign-up form) */
    signIn: boolean;
  };
}
/** who drives the browser through the port: the owner user, an agent's run, or `asSystem(reason)` */
export type BrowserPortActor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; runId: string }
  | SystemActor;
/**
 * The W15 managed browser for server-side module code (W30 shopping): never an agent tool by itself. Every page it
 * opens, and the page it ends on, must be on `allowedHosts` (else it throws); it never types into a card, bank,
 * password or one-time-code field, and never clicks a pay / place-order control or anything on a payment page.
 */
export interface ManagedBrowserPort {
  /**
   * The profile a call means (default: the first) and whether it may hold the owner's sign-ins (`loggedIn`); null
   * when there is no profile yet (the first one is made signed out). A caller's agent tool uses it for its tier: an
   * agent's use of a signed-in profile is tier 3, like the browser module's own tools.
   */
  profileInfo(o?: { profile?: string }): { id: string; loggedIn: boolean } | null;
  /**
   * Opens `url` (or reads the current page) in the profile (default: the first) and returns its data.
   * `approvedTier` (on read, fill, click and handOver): the tier the caller's own action was cleared at; an `agent` actor on a
   * profile that may hold the owner's sign-ins is refused below 3. Each call's check and page action run under the
   * profile's page lock, shared with the browser module's tools.
   */
  read(
    actor: BrowserPortActor,
    o: {
      profile?: string;
      url?: string;
      allowedHosts: readonly string[];
      selectors?: Record<string, string>;
      approvedTier?: ApprovalTier;
    },
  ): Promise<BrowserPageData>;
  /** Sets a form field on the current page (refused: card, bank, password, one-time-code fields). */
  fill(
    actor: BrowserPortActor,
    o: {
      profile?: string;
      selector: string;
      value: string;
      allowedHosts: readonly string[];
      approvedTier?: ApprovalTier;
    },
  ): Promise<void>;
  /** Clicks an element on the current page (refused: a money action such as pay / place order, a payment page). */
  click(
    actor: BrowserPortActor,
    o: { profile?: string; selector: string; allowedHosts: readonly string[]; approvedTier?: ApprovalTier },
  ): Promise<void>;
  /**
   * Hands the profile's live view to the owner: the browser stays open, the profile counts as owner-driven, and the
   * owner is notified with `reason` (plain text). Returns the profile id. Gated like read, fill and click: once a
   * profile counts as owner-driven (a first hand-over sets that), an `agent` actor's later hand-over needs
   * `approvedTier` 3.
   */
  handOver(
    actor: BrowserPortActor,
    o: { profile?: string; reason: string; approvedTier?: ApprovalTier },
  ): Promise<{ profileId: string }>;
  /**
   * W43 "Do it with me" (ARCHITECTURE 8.2): a guided sign-up on one profile, driven by the caller's server code only.
   * While a profile is in a guided flow the browser module refuses, for its own agent tools and this port alike,
   * typing into password, one-time-code, phone and OTP-like fields, clicking submit-like controls, pressing Enter to
   * submit, and opening any address off `allowedHosts`; after `takeOver` no helper may act in that browser and its
   * frames are neither kept nor read. Absent when the browser module predates W43.
   */
  guided?: {
    /** opens `url` (on `allowedHosts`) in the profile named `profileName` (made when missing) and starts the flow */
    start(
      actor: BrowserPortActor,
      o: { profileName: string; url: string; allowedHosts: readonly string[] },
    ): Promise<{ profileId: string }>;
    /** fills only these fields, found by the module's fixed heuristics; returns the kinds it filled */
    fill(
      actor: BrowserPortActor,
      o: { profileId: string; fields: { kind: 'givenName' | 'familyName' | 'username'; value: string }[] },
    ): Promise<{ filled: string[] }>;
    /** the owner drives the live view from now on */
    takeOver(o: { profileId: string }): void;
    /** the flow ends (the owner said Done, or the setup moved on) */
    end(o: { profileId: string }): void;
    state(profileId: string): { active: boolean; takenOver: boolean };
  };
}
/** ModuleHost.browser: the browser module sets the port; others look it up at call time (absent: no browser). */
export interface ManagedBrowserRegistry {
  set(p: ManagedBrowserPort): void;
  get(): ManagedBrowserPort | undefined;
}

// ---------- automation tokens (W0b model, W21 REST; ARCHITECTURE 2.3, 4.1) ----------
/** An `automation_tokens` row without its hash. */
export interface AutomationTokenInfo {
  id: string;
  agentId: string;
  scopes: string[];
  /** at most `standard` */
  trust: TrustLevel;
  remoteOk: boolean;
  ratePerHour: number;
  createdBy: string;
  createdTrust: TrustLevel;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
// ---------- registries the host hands to modules ----------
export interface TriggerRegistry {
  register(t: TriggerSource<any>): void;
  get(kind: string): TriggerSource<any> | undefined;
  list(): TriggerSource<any>[];
}
export interface ChannelRegistry {
  register(c: ChannelAdapter<any>): void;
  get(kind: string): ChannelAdapter<any> | undefined;
  list(): ChannelAdapter<any>[];
  /**
   * Hand a public request to the running connection of a binding (set by the binding runtime); 404 when the
   * binding is not connected or its adapter takes no HTTP.
   */
  deliverHttp?(bindingId: string, req: ChannelHttpRequest): Promise<ChannelHttpResponse>;
}
export interface ProviderRegistry {
  register(p: ProviderAdapter): void;
  /** removes a provider a module registered at runtime (e.g. an uninstalled ACP agent); false when absent */
  unregister(id: ProviderId | string): boolean;
  get(id: ProviderId | string): ProviderAdapter | undefined;
  list(): ProviderAdapter[];
  setPolicy(p: ProviderPolicy): void;
  policy(): ProviderPolicy;
  /**
   * Brain test (Brains page, W-simplify): one tool-less, session-less turn with a fixed tiny prompt through the
   * provider's own adapter, in the runner sandbox with a scrubbed env and a throwaway workspace. It never resumes,
   * saves or ends a native session, books no run or usage, denies every permission event and is aborted after
   * `timeoutMs`. Every text in the result has passed the 7.3 redaction filter. Absent on registries without a host.
   */
  probe?(id: ProviderId | string, o: ProviderProbeOptions): Promise<ProviderProbeResult>;
  /**
   * Sign-in memory (Brains page honesty): a brain test or a real turn (no provider account) that failed on sign-in
   * marks the brain as signed out, and the next one that works clears it. In memory only, never stored.
   */
  noteSignIn?(id: ProviderId | string, ok: boolean, keyStamp?: string): void;
  /**
   * true while the brain's last test or turn failed on sign-in and none has worked since, with the same vault keys
   * (`keyStamp` from `brainKeyStamp`; a key saved since then ends the memory)
   */
  signInLost?(id: ProviderId | string, keyStamp?: string): boolean;
  /**
   * Signed in the way a turn really runs (`ProviderAdapter.turnSignIn`: the runner sandbox, the turn's scrubbed env,
   * the vault key's presence), when the adapter can check that cheaply; 'unknown' otherwise.
   */
  turnSignIn?(id: ProviderId | string): Promise<boolean | 'unknown'>;
}
export interface ProviderProbeOptions {
  prompt: string;
  model?: string;
  account?: ProviderAccount;
  timeoutMs: number;
}
/**
 * `ok: true` only for a real answer: a sign-in, usage-limit or quota error, or a reply that is the CLI's own "not
 * logged in" line (`looksSignedOut`), is `ok: false` even when the CLI also printed text. `retryAfterMs`: when a
 * usage limit resets, if the CLI said.
 */
export type ProviderProbeResult =
  | { ok: true; reply: string; ms: number; model?: string }
  | {
      ok: false;
      kind: ProviderErrorKind | 'not_installed';
      message: string;
      ms: number;
      retryAfterMs?: number;
    };
export interface BlockKind<T = unknown> {
  kind: `${string}.${string}`;
  /** current schema version; blocks carry `v` */
  v: number;
  schema: ZodType<T>;
  userAuthored?: boolean;
  /**
   * For user-authored kinds that describe the message's own attachments: the file refs a block names. The message
   * route accepts the block only when every ref matches one of that message's attachments (sha256, name, mime, size).
   */
  attachmentRefs?: (data: T) => { sha256: string; name: string; mime: string; size: number }[];
}
export interface BlockKindRegistry {
  /** kind must be `<module id>.<kind>` */
  /** `userAuthored`: users may attach blocks of this kind to their own messages (`POST /api/v1/chats/:id/messages`) */
  register<T>(
    kind: `${string}.${string}`,
    schema: ZodType<T>,
    opts?: {
      v?: number;
      userAuthored?: boolean;
      attachmentRefs?: (data: T) => { sha256: string; name: string; mime: string; size: number }[];
    },
  ): void;
  get(kind: string): BlockKind | undefined;
  list(): BlockKind[];
  /** ok=false means "render as the plain fallback card" (unknown kind or invalid data). */
  validate(block: { kind: string; v: number; data: unknown }): { ok: true } | { ok: false; reason: string };
}
/** A module's copy returns the built-in team builder with `builtIn: true` and no instructions (its prompt stays on the server). */
export interface AgentReader {
  get(id: string): Promise<AgentDTO | null>;
  list(): Promise<AgentDTO[]>;
}
/**
 * Owner-side agent administration (W19). Only the admin module's ModuleHost carries the real port
 * (`AGENT_ADMIN_MODULES`: admin, budget, orchestrator); every other module's copy refuses. Each call names the acting person and the port itself
 * checks that it is an active owner account (403 otherwise), as the ChatPort checks its actor.
 * - `exportBundle`: the agent's config and the chats it is a member of (final messages only; no secrets, paths,
 *   provider account or attachments). Bodies and every string inside block data pass the redaction filter; cards
 *   bound to a live server-side prompt (block data naming a `promptId`) stay behind. null when the agent is missing;
 *   the built-in team builder is refused (409 `builtin_agent`): it is never a portable agent.
 * - `importBundle`: creates a NEW agent (fresh ids, free slug, own workspace) and its chats with the acting owner as
 *   the only person; bodies and block strings pass the redaction filter, blocks that fail validation, refer to
 *   attachments or name a `promptId` are dropped, and trust is min(bundle trust, server default trust): an outside
 *   file never widens trust. People's words from a bundle ('user' / 'external') are stored as `external` with no
 *   author id: imported text is never attributed to the owner or anyone else on this server.
 *   `opts.teamBuilder` (module code only, never from a bundle): the new agent is the built-in team builder; it is
 *   recorded under ORCHESTRATOR_AGENT_SETTING before anything is published, so its internal prompt never reaches
 *   a client, not even in the first `agent.updated`.
 * - `setLimits`: merges memory/CPU limits into `agents.limits` and publishes `agent.updated`.
 * - `rename`: a new name (and avatar salt) for an agent and its direct chats' titles; publishes `agent.updated`.
 */
export type AgentAdminActor = { kind: 'user'; id: string };
export interface AgentAdmin {
  exportBundle(actor: AgentAdminActor, agentId: string): AgentBundle | null;
  importBundle(
    actor: AgentAdminActor,
    bundle: AgentBundle,
    opts?: { teamBuilder?: boolean },
  ): { agentId: string; chatIds: string[] };
  setLimits(
    actor: AgentAdminActor,
    agentId: string,
    limits: Pick<AgentLimits, 'memMb' | 'cpuPct'>,
  ): AgentDTO | null;
  /**
   * Renames an agent (the team builder's "name your helper" step): its name, its avatar's letter and re-roll salt
   * (seed = id + salt; '' = the original look), and the title of each of its direct chats that still carries the old
   * name; publishes `agent.updated`. The caller validates the name. null when the agent is missing.
   */
  rename(actor: AgentAdminActor, agentId: string, o: { name: string; avatarSalt: string }): AgentDTO | null;
}

/**
 * Who acts through the ChatPort. Every call that reads or changes one chat's content names an actor and the port
 * checks it (ARCHITECTURE 5.5): a user by their `users` row (owner: every chat; others: `chat_members`), an agent
 * by its `chat_members` row (observers read, never write). `asSystem(reason)` is the explicit, greppable escape for
 * server-made effects that are not done for one principal (notices, reading a run's reply after it finished,
 * settling a card a route already authorised); never pass it for something an agent or person asked for.
 */
export type ChatActor = { kind: 'user'; id: string } | { kind: 'agent'; id: string } | SystemActor;
/** The `asSystem(reason)` actor, accepted by the ports that take an actor (ChatPort, AutomationTokens). */
export type SystemActor = { readonly kind: 'system'; readonly reason: string };
/**
 * A server-made port call (see ChatActor, AutomationActor). The reason names the module and why; grep `asSystem(`
 * to audit.
 */
export const asSystem = (reason: string): SystemActor => Object.freeze({ kind: 'system' as const, reason });
/** Thrown by the ChatPort when the actor may not do that in that chat. */
export class ChatAccessError extends Error {
  readonly code = 'chat_forbidden';
  constructor(message = 'not allowed in this chat') {
    super(message);
    this.name = 'ChatAccessError';
  }
}

/**
 * Core chats as modules may use them; modules never read or write the core chat tables themselves. Calls that
 * touch one chat's content take a `ChatActor` first and check it; the rest return only ids or membership
 * (`ownChat`, `openDirect`, `isMember`, `runChat`), are membership checks themselves (`canRead`, `canWrite`), or
 * filter by their own `reader` (`search`).
 */
export interface ChatPort {
  /**
   * The agent's main chat: its oldest open direct chat with no other agent that no module opened. With
   * `create: true` (default false) a missing one is opened (the agent + every active owner, titled with its name).
   */
  ownChat(agentId: string, opts?: { create?: boolean }): string | null;
  /** Opens a new direct chat for one agent, the core's members (the agent + every active owner); marked `moduleChat`. */
  openDirect(o: { agentId: string; title: string; settings?: Record<string, unknown> }): string;
  /** Final messages of a chat, newest first. Throws ChatAccessError unless the actor can read the chat. */
  recent(
    actor: ChatActor,
    chatId: string,
    limit: number,
  ): { authorKind: string; body: string; createdAt: number }[];
  /** The body of the newest final agent message a run wrote, or null (also when the actor cannot read its chat). */
  runReply(actor: ChatActor, runId: string): string | null;
  isMember(chatId: string, member: { kind: 'user' | 'agent'; id: string }): boolean;
  /** A chat's kind, task owner, archive state and members; null when it does not exist or the actor cannot read it. */
  get(actor: ChatActor, chatId: string): ChatInfo | null;
  /**
   * Make an agent member the chat's task owner (the agent that answers people's messages). Throws when the agent
   * is not a member, or (ChatAccessError) unless the actor is the owner user, the current task-owner agent (a
   * writing member), or system. Publishes `chat.created` with the id so open clients refetch the chat.
   */
  setTaskOwner(actor: ChatActor, chatId: string, agentId: string): void;
  /** Archive (hide) or restore a chat (owner user or system only); publishes `chat.created` with the id. */
  setArchived(actor: ChatActor, chatId: string, archived: boolean): void;
  /**
   * The actor (a user or agent that may write in the chat) adds (`on` true) or removes its reaction on a message
   * of that chat; false when the message is not in the chat. Throws ChatAccessError otherwise.
   */
  react(actor: ChatActor, chatId: string, messageId: string, emoji: string, on: boolean): boolean;
  /** Reactions on a chat's messages, grouped per message. Throws ChatAccessError unless the actor can read it. */
  reactions(
    actor: ChatActor,
    chatId: string,
  ): { messageId: string; emoji: string; actorKind: string; actorId: string }[];
  /**
   * Posts an agent or system message with blocks into a chat (body redacted, every block validated against the
   * BlockKindRegistry; an invalid block throws) and publishes `message.created`. An agent actor posts only as
   * itself, into a chat where it is a writing member, with its own run; system may post as anyone; users post
   * through the message route, never here (ChatAccessError).
   */
  post(
    actor: ChatActor,
    o: {
      chatId: string;
      authorKind: 'agent' | 'system';
      authorId: string | null;
      body: string;
      blocks?: MessageBlock[];
      runId?: string | null;
      /** a message of the same chat this one answers (a thread); anything else throws */
      replyTo?: string | null;
      /** system only: when it was said (moving older talk into a chat keeps its place in time) */
      createdAt?: number;
    },
  ): MessageDTO;
  /**
   * A chat's messages, oldest first (at most `limit`, default 200, the newest ones), optionally only those a run
   * wrote. Throws ChatAccessError unless the actor can read the chat; a person who is not the owner gets them as
   * the serialiser shows them (chat/view.ts).
   */
  messages(actor: ChatActor, chatId: string, o?: { runId?: string; limit?: number }): MessageDTO[];
  /**
   * System only: move messages (of any chat) into another chat, optionally pointing them at a message there
   * (`replyTo`, a thread). Nothing is deleted: each message keeps its id, words, blocks, reactions and files.
   * Publishes `message.deleted` on the old chat and `message.created` on the new one.
   */
  move(actor: ChatActor, o: { messageIds: string[]; toChatId: string; replyTo?: string | null }): number;
  /**
   * Replaces a message's blocks (validated) and publishes `message.updated`; null when the message is gone. A user
   * or agent actor must be the message's author and still able to write in its chat (else ChatAccessError).
   */
  updateBlocks(actor: ChatActor, messageId: string, blocks: MessageBlock[]): MessageDTO | null;
  /** A message by id; null when it does not exist or the actor cannot read its chat. */
  message(actor: ChatActor, messageId: string): MessageDTO | null;
  /** The chat a run belongs to (through its queue item), or null. An id only: reading it needs an actor. */
  runChat(runId: string): string | null;
  /** Can this user read the chat? Owners read every chat, others only chats they are a member of. */
  canRead(chatId: string, user: { id: string; kind: 'owner' | 'member' | 'guest' }): boolean;
  /**
   * May this user act in the chat (post, answer a card)? The message route's rule: they can read it and (unless an
   * owner) their `chat_members` role is not `observer`. Guests pass this check; a module refuses them on top if needed.
   */
  canWrite(chatId: string, user: { id: string; kind: 'owner' | 'member' | 'guest' }): boolean;
  /**
   * Full-text search over message bodies (FTS5), newest first, filtered by membership: an owner user reads every
   * chat, any other user or an agent only chats it is a member of.
   */
  search(q: {
    text: string;
    reader:
      | { kind: 'user'; id: string; userKind: 'owner' | 'member' | 'guest' }
      | { kind: 'agent'; id: string };
    chatId?: string;
    limit?: number;
  }): MessageSearchHit[];
}
export interface ChatInfo {
  id: string;
  kind: 'direct' | 'channel';
  title: string;
  taskOwnerAgentId: string | null;
  archivedAt: number | null;
  members: { kind: 'user' | 'agent'; id: string; role: string }[];
}
export interface MessageSearchHit {
  messageId: string;
  chatId: string;
  chatTitle: string;
  authorKind: string;
  authorId: string | null;
  /** the body around the match, at most ~200 characters */
  snippet: string;
  createdAt: number;
}

// ---------- queue (ARCHITECTURE 6) ----------
export const QUEUE_PRIORITY = { chat: 0, task: 10, handoff: 10, routine: 20, workflow: 20 } as const;
export interface QueueKindSpec {
  /** lower runs first */
  priority: number;
  /** an `interrupted` item of this kind blocks the agent's queue until the owner picks Retry/Skip */
  blocksOnInterrupt: boolean;
  /**
   * Safe to re-run after a crash. Only then does a crashed item whose payload also says `retryOnCrash: true`
   * requeue (up to 3 attempts) instead of becoming `interrupted`. Never true for a `blocksOnInterrupt` kind.
   */
  idempotent?: boolean;
  /**
   * Checked at dispatch time, right before an item of this kind runs (also after a requeue, retry or hold): return
   * a reason to refuse it (the item ends `cancelled` with that reason and never runs), or null to run it. A throw
   * counts as a refusal. Use it when what allowed the enqueue can be withdrawn later (e.g. a revoked token).
   */
  admit?(item: {
    id: string;
    agentId: string;
    kind: string;
    payload: unknown;
    source: unknown;
  }): string | null;
}
/**
 * A dispatch-time check for items of every kind (W32 budgets), run right after the kind's own `admit`. `null` runs
 * the item; `refuse` ends it `cancelled` with that reason (it never runs; `queue.refused` is published); `hold` parks
 * it `held` until `until` with that reason (released like any held item, or earlier through `hold(id, now)`). A throw
 * holds the item for a minute (fail closed: a broken gate never lets work through, never drops it).
 */
export type QueueGateVerdict = null | { refuse: string } | { hold: { until: number; reason: string } };
export type QueueGate = (item: {
  id: string;
  agentId: string;
  chatId: string | null;
  kind: string;
  payload: unknown;
  source: unknown;
}) => QueueGateVerdict;
export interface EnqueueInput {
  agentId: string;
  chatId?: string | null;
  kind: string;
  /** default: the kind's priority */
  priority?: number;
  payload: unknown;
  /**
   * `sender` runs the turn. `origin` (set by agent-to-agent work, e.g. collab) is the sender that started the chain:
   * the person, webhook or routine whose turn made one agent hand work to another. A turn whose sender is an agent
   * never reads more than its origin could, and an agent turn without an origin reads nothing beyond its task.
   */
  source: { sender: SenderInfo; origin?: SenderInfo; [k: string]: unknown };
  idemKey?: string;
}
export interface QueueService {
  /** Register a module-specific kind (e.g. 'workflow' is core; 'collab.delegate' a module's). */
  registerKind(kind: string, spec: QueueKindSpec): void;
  enqueue(input: EnqueueInput): { item: QueueItemDTO; duplicate: boolean };
  /** true when an item with this `idem_key` was ever enqueued (finished items included) */
  hasIdem(idemKey: string): boolean;
  get(id: string): QueueItemDTO | null;
  /**
   * The payload and source an item was enqueued with (server code only, never agent input), e.g. so collab's
   * silent-lead retry re-runs the original message under its original sender and trust.
   */
  input(
    id: string,
  ): { payload: unknown; source: { sender?: SenderInfo; origin?: SenderInfo; [k: string]: unknown } } | null;
  list(agentId: string, opts?: { includeFinished?: boolean }): QueueItemDTO[];
  pause(agentId: string, reason?: string): void;
  resume(agentId: string): void;
  cancel(id: string): boolean;
  retry(id: string): boolean;
  skip(id: string): boolean;
  hold(id: string, resumeAt: number, error?: string): void;
  /** Add a dispatch-time gate checked for every item (see `QueueGate`); returns a function that removes it. */
  addGate(gate: QueueGate): () => void;
}

// ---------- kill switch (W31, ARCHITECTURE 12) ----------
/**
 * Who pulled or lifts the global stop. Anyone may stop (an owner session, a linked machine, a channel command, an
 * automation token, an agent, the server itself); only an owner session with a fresh re-auth may resume.
 */
export type StopActor =
  | { kind: 'owner'; userId: string; sessionId?: string; device?: string | null }
  | { kind: 'linked-machine'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'automation'; tokenId: string; agentId: string }
  | { kind: 'agent'; agentId: string; runId?: string }
  | SystemActor;
/** One thing a stop ended or parked, for the owner's report. */
export interface StoppedItem {
  /** `run` (a turn that was running), `queued` (waiting work left held), or a module's own kind (`browser` ...) */
  kind: string;
  id: string;
  /** what it was: a routine or workflow name, a browser profile ... (never a secret) */
  label?: string | null;
  /** W24: a queue item's kind (`message`, `task`, `routine`, `workflow`, ...); the app names it in its language */
  queueKind?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  /** the run id when `kind` is `run` */
  runId?: string | null;
  /** `cancelled` (was running), `held` (was waiting; runs after a resume), `closed` (a session) */
  outcome: 'cancelled' | 'held' | 'closed';
}
export interface StopReport {
  id: string;
  at: number;
  actorKind: StopActor['kind'];
  /** the actor's id (user, machine, channel, token, agent) or the system reason */
  by: string;
  reason: string;
  items: StoppedItem[];
}
export interface StopState {
  stopped: boolean;
  since: number | null;
  actorKind: StopActor['kind'] | null;
  by: string | null;
  reason: string | null;
  /** the last stop's report (kept after a resume until the next stop) */
  report: StopReport | null;
}
/** A module's part of a stop: end what it runs outside the queue (sessions, workers) and say what it ended. */
export type StopHandler = (stop: { reason: string; at: number }) => StoppedItem[] | Promise<StoppedItem[]>;
/** Thrown by `KillSwitch.resume`: `resume_forbidden` (403: not an owner session) or `reauth_required` (401). */
export class KillSwitchError extends Error {
  constructor(
    readonly code: 'resume_forbidden' | 'reauth_required',
    message = code === 'reauth_required' ? 'confirm your password to resume' : 'only the owner may resume',
  ) {
    super(message);
    this.name = 'KillSwitchError';
  }
}
/**
 * The global stop (ARCHITECTURE 12). One stored flag, read at boot before the queue dispatches. `stopAll` cancels
 * every running queue item, leaves every waiting one `held`, runs every module's `onStop` handler and blocks new
 * work until `resume`. Code that starts work outside the queue checks `isStopped()` first and registers an
 * `onStop` handler.
 */
export interface KillSwitch {
  isStopped(): boolean;
  state(): StopState;
  stopAll(actor: StopActor, reason: string): Promise<StopReport>;
  /** Owner session with a fresh re-auth only; anything else throws `KillSwitchError`. Releases the held items. */
  resume(actor: StopActor, o: { reauthed: boolean }): StopState;
  onStop(h: StopHandler): () => void;
  /** told after every stop and resume (e.g. to publish a live event) */
  watch(fn: (s: StopState) => void): () => void;
}

export interface ModuleConfig {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}
