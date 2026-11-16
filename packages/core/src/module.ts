/** Module SDK (ARCHITECTURE.md 2.1): how parallel work plugs in without editing shared files. */

import type { TrustLevel } from '@pasabot/protocol';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Kysely } from 'kysely';
import type { ZodType } from 'zod';
import type {
  AgentAdmin,
  AgentReader,
  ApprovalService,
  AutomationTokenInfo,
  BlobStore,
  BlockKindRegistry,
  CardsPort,
  ChannelRegistry,
  ChatPort,
  EventBus,
  FlowRegistry,
  KillSwitch,
  Logger,
  ManagedBrowserRegistry,
  MemoryRegistry,
  ModuleConfig,
  Notifier,
  PromptContextRegistry,
  ProviderRegistry,
  QueueService,
  RoutineRegistry,
  RunnerLimits,
  SafeNet,
  SecretVault,
  ServerI18n,
  SkillManifestRegistry,
  SystemActor,
  ToolRegistry,
  TriggerRegistry,
} from './ports.js';
import type { SenderInfo } from './provider.js';

/** 'public' only on publicHttp; 'session' = owner/member cookie or bearer. */
export type RouteAuth = 'session' | 'automation' | 'run' | 'public';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Who made the request, as resolved by the host's auth layer. */
export type Principal =
  | {
      kind: 'session';
      userId: string;
      userKind: 'owner' | 'member' | 'guest';
      sessionId: string;
      /**
       * Set on module routes: true when this session re-authenticated (password or passkey with UV) within the
       * last 5 minutes (2.4). A module route that needs a fresh re-auth answers 401 `reauth_required` without it.
       */
      reauthed?: boolean;
    }
  | { kind: 'automation'; tokenId: string; agentId: string }
  | { kind: 'run'; runId: string; agentId: string };

// automation tokens port (W21; here, not in ports.ts, because it takes a `Principal`)
/**
 * Who acts through the automation port: the request's principal, or `asSystem(reason)` for server-made checks that
 * act for no principal (the queue's dispatch-time `admit` of an `automation.run`). Never pass `asSystem` for
 * something a person, token or agent asked for.
 */
export type AutomationActor = Principal | SystemActor;
/** Thrown by the automation port when the actor may not do that (another agent's token, not the owner, ...). */
export class AutomationAccessError extends Error {
  readonly code = 'automation_forbidden';
  constructor(message = 'not allowed to act on this automation token') {
    super(message);
    this.name = 'AutomationAccessError';
  }
}
/**
 * The core's automation-token helpers for the automation module (W21). Only the module with id `automation` gets a
 * working port (host allowlist); every other module's `ModuleHost.automation` throws on use. Every call takes the
 * acting principal first and the port checks it itself, the way the ChatPort does (refusals throw
 * `AutomationAccessError`, code `automation_forbidden`), so code holding the port can never act on another agent's
 * tokens:
 * - an owner session (live: checked against the sessions table, not just its shape) may do everything but `source`;
 * - a token principal reads only itself: `get`/`isActive`/`budget` of its own id and its own `source`;
 * - `asSystem(reason)` may `get`/`isActive`/`budget` (the dispatch-time check), never issue, revoke or list;
 * - any other principal (a member session, an agent run) is refused.
 * Issuing and revoking are owner-only widening (7.4): `createdBy` is that owner, and both are audit-logged. The auth
 * resolver already enforces the guards (hash-only, Origin refused, loopback unless `remoteOk`, expiry, revoke,
 * archived agent).
 */
export interface AutomationTokens {
  /** Mint a token (trust ≤ `standard`, else throws); the raw token is returned once and only its hash is stored. */
  issue(
    actor: Principal,
    o: {
      agentId: string;
      trust?: TrustLevel;
      scopes?: string[];
      remoteOk?: boolean;
      ratePerHour?: number;
      expiresAt?: number | null;
    },
  ): { id: string; token: string };
  /** false when unknown or already revoked; throws unless `actor` is a live owner session */
  revoke(actor: Principal, id: string): boolean;
  /** owner or system: any token (null when unknown); a token principal: only its own id */
  get(actor: AutomationActor, id: string): AutomationTokenInfo | null;
  /** newest first; revoked ones included; a live owner session only */
  list(actor: Principal, o?: { agentId?: string }): AutomationTokenInfo[];
  /** true while the token is neither revoked nor expired (same actor rule as `get`) */
  isActive(actor: AutomationActor, id: string, now?: number): boolean;
  /**
   * Queue-item `source` for a run the calling token starts: `actor` must be that token's own automation principal
   * (from the request), and the token must still be active, else throws. The sender is the token's (never the
   * owner) + the budget tag.
   */
  source(actor: Principal): { sender: SenderInfo; automation: { tokenId: string } };
  /**
   * Per-token runs in the last hour (default 30/h); `ok: false` = answer 429 + Retry-After. Same actor rule as
   * `get`: a token principal reads only its own budget.
   */
  budget(
    actor: AutomationActor,
    tokenId: string,
    now?: number,
  ): { ok: true; remaining: number } | { ok: false; retryAfterSec: number };
}

// people port (W23; here because it takes a `Principal`)
/** One account on this server. A server has exactly one owner; extra people are `member` or `guest` (3.1). */
export interface PersonInfo {
  id: string;
  kind: 'owner' | 'member' | 'guest';
  displayName: string;
  createdAt: number;
  disabledAt: number | null;
}
/** A person in one chat (`chat_members` row of kind `user`). */
export interface ChatPerson {
  userId: string;
  kind: 'owner' | 'member' | 'guest';
  displayName: string;
  role: 'owner' | 'member' | 'observer';
}
/** Thrown by the people port when the actor may not do that; 403 from a module route (code `people_forbidden`). */
export class PeopleAccessError extends Error {
  readonly code = 'people_forbidden';
  constructor(message = 'not allowed') {
    super(message);
    this.name = 'PeopleAccessError';
  }
}
/**
 * Extra people (W23) for the people module. Only the module with id `people` (`PEOPLE_MODULE`) gets a working port;
 * every other module's copy throws. Every call takes the acting principal and the port checks it itself:
 * - a live owner session (checked against `sessions`/`users`) manages people and chat membership;
 * - `asSystem(reason)` is for accepting an invite the owner minted (the module verified its token first): create
 *   the account, add it to the invite's chats, sign it in. Never for something a request asked for on its own;
 * - a member session may only `openDirect` with an agent the module decided it may use; guests are refused.
 * It never creates or promotes an owner, and a member/guest never gains owner trust: their turns run as their own
 * sender kind (7.4). Changes are audit-logged; adding a person to a chat publishes `chat.created` on `chat:<id>`.
 */
export interface PeoplePort {
  list(actor: Principal): PersonInfo[];
  get(actor: Principal | SystemActor, userId: string): PersonInfo | null;
  /** new member/guest account (argon2id password); `asSystem` only (an accepted invite) */
  create(
    actor: SystemActor,
    o: { kind: 'member' | 'guest'; displayName: string; password: string; invitedBy: string },
  ): Promise<PersonInfo>;
  /**
   * owner only; never the owner account. Disabling ends every session of that person at once and cancels their
   * queued and running turns (an item whose `source.sender` or `source.origin` is that member/guest); the queue also
   * refuses at dispatch any item whose member/guest sender or origin is disabled.
   */
  setDisabled(actor: Principal, userId: string, disabled: boolean): boolean;
  /**
   * `asSystem` only: a fresh session for a person who just accepted an invite. `setCookie` is the session cookie
   * header; `token` is present only for a request without an `Origin` header (CLI, native clients; 2.4).
   */
  signIn(
    actor: SystemActor,
    userId: string,
    req: { ip: string; userAgent: string; origin?: string },
  ): { setCookie: string; token?: string };
  /** people in a chat (owner session, or a person who can read that chat) */
  chatPeople(actor: Principal, chatId: string): ChatPerson[];
  /**
   * owner session or `asSystem` (accepting an invite): add a person to a chat as `member` (may write) or `observer`
   * (read-only), change the role, or remove them (`null`). The owner's own row is never changed.
   */
  setChatRole(
    actor: Principal | SystemActor,
    chatId: string,
    userId: string,
    role: 'member' | 'observer' | null,
  ): void;
  /**
   * a member session: open (or reuse) a direct chat of that member with this agent; returns the chat id. The chat is
   * marked `moduleChat` (and `peopleDirect`), so `ChatPort.ownChat` never takes it for the agent's own main chat.
   */
  openDirect(actor: Principal, agentId: string): string;
  /**
   * owner session: the agent is no longer shared with members. Every member's `openDirect` chat with it is archived,
   * the member is removed from it (the owner keeps the history) and their queued or running turns there are
   * cancelled. Returns how many chats were closed.
   */
  closeDirects(actor: Principal, agentId: string): number;
}

/**
 * Whether a signed-in session is still live (W23: a device's push subscription lives only as long as the session
 * that turned it on). `asSystem` only: server work such as "may this device still get a notification".
 */
export interface SessionReader {
  /** the session's person, or null once it was logged out, revoked (device revoke), expired or its user disabled */
  live(
    actor: SystemActor,
    sessionId: string,
  ): { userId: string; userKind: 'owner' | 'member' | 'guest' } | null;
}

export interface RequestCtx<B = unknown> {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body: B;
  ip: string;
}
export interface AuthedCtx<B = unknown> extends RequestCtx<B> {
  principal: Principal;
}
export interface PublicCtx<B = unknown> extends RequestCtx<B> {
  /** exact bytes received (webhook signatures are computed over these) */
  rawBody: Buffer;
}

/** Return this from a handler to choose the status code / headers; anything else is sent as 200 JSON. */
export class HttpResponse {
  constructor(
    readonly status: number,
    readonly body: unknown = null,
    readonly headers: Record<string, string> = {},
  ) {}
}
export const httpResponse = (status: number, body?: unknown, headers?: Record<string, string>) =>
  new HttpResponse(status, body, headers);
/** Throw from a handler to answer with an error status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
  }
}

export interface RouteDef<B = unknown> {
  method: HttpMethod;
  /** relative to /api/m/<id>/, e.g. '/notes/:id' */
  url: string;
  /** one kind or a list of accepted kinds; 'public' is refused here */
  auth: Exclude<RouteAuth, 'public'> | Exclude<RouteAuth, 'public'>[];
  body?: ZodType<B>;
  bodyLimit?: number;
  handler(ctx: AuthedCtx<B>): unknown | Promise<unknown>;
}
export interface ModuleRouter {
  route<B>(def: RouteDef<B>): void;
}

export interface PublicRouteDef<B = unknown> {
  method: HttpMethod;
  /** relative to /hooks/<id>/ */
  url: string;
  /** REQUIRED: requests per window per client address */
  rateLimit: { max: number; windowMs: number };
  /** REQUIRED: max body bytes (413 above it) */
  bodyLimit: number;
  handler(ctx: PublicCtx<B>): unknown | Promise<unknown>;
}
export interface PublicRouter {
  route<B>(def: PublicRouteDef<B>): void;
}

/** Files on the separate sites origin (ARCHITECTURE 8, "Exposure"); served at `<sitesOrigin>/<module id>/<path>`. */
export interface SitesMount {
  put(path: string, data: string | Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** absolute URL once the sites listener is up, else the path */
  url(path: string): string;
}

export interface ModuleHost {
  id: string;
  /** mounted at /api/m/<id>/; every route declares `auth` */
  http: ModuleRouter;
  /** mounted at /hooks/<id>/; each route MUST set rateLimit + bodyLimit */
  publicHttp: PublicRouter;
  sitesOrigin: SitesMount;
  /** own tables only (prefix `<id>_`) */
  db: Kysely<any>;
  raw: SqliteDatabase;
  bus: EventBus;
  tools: ToolRegistry;
  triggers: TriggerRegistry;
  channels: ChannelRegistry;
  providers: ProviderRegistry;
  blocks: BlockKindRegistry;
  /** memory backends (5.5); looked up at call time, so registration order between modules does not matter */
  memory: MemoryRegistry;
  /** W33: modules add labelled untrusted data to agent turns' prompts (rendered by the server, never raw text) */
  prompt: PromptContextRegistry;
  /** W31 x W32: skill permission manifests in the agent bundle (installed by the safety module) */
  skillManifests: SkillManifestRegistry;
  vault: SecretVault;
  net: SafeNet;
  files: BlobStore;
  approvals: ApprovalService;
  /** workflows other modules may start (set by the workflows module) */
  flows: FlowRegistry;
  /** routines other modules may list, start and stop (set by the routines module; W28 `manage` grant) */
  routines: RoutineRegistry;
  /** the W15 managed browser for module code (set by the browser module; W30 shopping), looked up at call time */
  browser: ManagedBrowserRegistry;
  /** automation tokens (W0b model) for the automation module's owner REST and runs route (W21) */
  automation: AutomationTokens;
  notifier: Notifier;
  /** W40: one card family in the chats (and the pinned decision bar for cards that need an answer) */
  cards: CardsPort;
  queue: QueueService;
  agents: AgentReader;
  /** owner-side agent export/import + memory/CPU limits (W19); real only for `AGENT_ADMIN_MODULES`, refuses elsewhere */
  agentAdmin: AgentAdmin;
  /** extra people + chat membership (W23); real only for `PEOPLE_MODULE`, refuses elsewhere */
  people: PeoplePort;
  /** is a session still signed in (W23 push); `asSystem` only */
  sessions: SessionReader;
  chats: ChatPort;
  /** the global stop (W31): check `isStopped()` before starting work outside the queue; `onStop` to end it */
  killSwitch: KillSwitch;
  runner: RunnerLimits;
  log: Logger;
  config: ModuleConfig;
  /** the 7.3 redaction filter: known secret values become `[secret:name]`, common token shapes `[secret]` */
  redact(text: string): string;
  /**
   * W24: text a person reads that never passes through the web (stored messages, push, channels) is rendered here
   * in the person's saved language; text the web shows goes out as a `Msg` (key + params) instead.
   */
  i18n: ServerI18n;
  /** where the server keeps per-module data: $PASABOT_HOME/modules/<id> */
  dataDir: string;
}

export interface PasaBotModule {
  /** "routines", "memory" ... = folder name */
  id: string;
  /** absolute dir of *.sql, namespaced by id */
  migrations?: string;
  register(app: ModuleHost): Promise<void> | void;
}
export const defineModule = (m: PasaBotModule) => m;

/** `pasabot` field in a workspace package.json (discovery, ARCHITECTURE 2.1). */
export interface PasaBotPackageField {
  kind: 'module' | 'provider' | 'channel' | 'plugin';
  /** built server entry, e.g. ./dist/server.js */
  entry: string;
  /** TypeScript source entry used in dev/test runs before a build */
  source?: string;
  /** web entry, e.g. ./web/index.tsx */
  web?: string;
  /**
   * A test-only package (the Fake brain): a normal server never loads it, so it never shows up as a brain for a
   * real person. Tests (Vitest) and dev runs with `PASABOT_TEST_BRAINS=1` still discover it.
   */
  testOnly?: boolean;
}

/** Module ids: lowercase, digits, `-`/`_`; `_example` is the reference module. */
export const MODULE_ID_RE = /^_?[a-z][a-z0-9-]*$/;
/** Table / tool prefix for a module id (`_example` -> `_example_` tables, `example_` tools). */
export const tablePrefix = (id: string) => `${id.replace(/-/g, '_')}_`;
export const toolPrefix = (id: string) => `${id.replace(/^_+/, '').replace(/-/g, '_')}_`;
/**
 * The `/mcp` gateway's lazy-discovery meta-tools (ARCHITECTURE 5.4). They keep these exact names (no module
 * prefix) and only the module named by `GATEWAY_META_TOOLS_OWNER` may register them.
 */
export const GATEWAY_META_TOOLS = ['tools_find', 'tools_describe', 'tools_invoke'] as const;
export const GATEWAY_META_TOOLS_OWNER = 'mcp';
/** The module whose ModuleHost carries the real AgentAdmin port (W19); see `AGENT_ADMIN_MODULES`. */
export const AGENT_ADMIN_MODULE = 'admin';
/**
 * Every module whose ModuleHost carries the real AgentAdmin port: admin (W19 export/import, limits), budget (W32:
 * the encrypted whole-agent bundle wraps the same export/import) and orchestrator (the built-in team builder makes
 * the first agent and, on the owner's approval of its plan card, the team, through `importBundle` at no more than
 * the server's default trust). Every other module's copy refuses.
 */
export const AGENT_ADMIN_MODULES: readonly string[] = [AGENT_ADMIN_MODULE, 'budget', 'orchestrator'];
/**
 * The `settings` key under which the orchestrator module records its agent (`module:orchestrator:agentId`, written
 * through its ModuleConfig). Core refuses to delete that agent while it is the only active agent.
 */
export const ORCHESTRATOR_AGENT_SETTING = 'module:orchestrator:agentId';
/**
 * The `settings` key of the orchestrator's interview (`module:orchestrator:interview`): core reads only its `status`,
 * so the main helper's one-line job says what it does now ("looks after your team") once the team is built.
 */
export const ORCHESTRATOR_INTERVIEW_SETTING = 'module:orchestrator:interview';
/**
 * The only modules whose queue port keeps a payload's `providerOverride` (run this one item on another provider or
 * model): collab's silent-lead backup, chosen by server code from the owner's channel backup or the lead's own
 * fallback chain. Every other module's `enqueue` drops the field, so nothing that carries a client, agent, channel
 * or linked machine's input can route around the free-tier gate, the budget caps or the agent's configured brain.
 */
export const PROVIDER_OVERRIDE_MODULES: readonly string[] = ['collab'];
/** The one module whose ModuleHost carries the real PeoplePort (W23); every other module's copy refuses. */
export const PEOPLE_MODULE = 'people';
/** May module `id` register a tool called `name`? (its prefix, or the gateway meta-tools for their owner) */
export const mayRegisterTool = (id: string, name: string) =>
  name.startsWith(toolPrefix(id)) ||
  (id === GATEWAY_META_TOOLS_OWNER && (GATEWAY_META_TOOLS as readonly string[]).includes(name));
