/** Small core services: logger, auth token lookup, registries, in-app notifier, agent reader, module config. */

import { createHash } from 'node:crypto';
import {
  type AgentReader,
  type BlockKind,
  type BlockKindRegistry,
  type ChannelAdapter,
  type ChannelRegistry,
  type EventBus,
  type FlowRegistry,
  type Logger,
  type ManagedBrowserPort,
  type ManagedBrowserRegistry,
  type MemoryBackend,
  type MemoryPoolActor,
  type MemoryPoolPort,
  type MemoryRegistry,
  type ModuleConfig,
  type Notification,
  type Notifier,
  type NotifyTransport,
  PortUnavailableError,
  type Principal,
  type PromptContextRegistry,
  type PromptContributor,
  type ProviderAdapter,
  type ProviderPolicy,
  type ProviderProbeOptions,
  type ProviderProbeResult,
  type ProviderRegistry,
  type RoutineControl,
  type RoutineRegistry,
  type RunnerLimits,
  type ServerI18n,
  type SkillManifestActor,
  type SkillManifestPort,
  type SkillManifestRegistry,
  type ToolCallGuard,
  type ToolCtx,
  type ToolDef,
  type ToolRegistry,
  type TriggerRegistry,
  type TriggerSource,
  type WorkflowStarter,
} from '@pasabot/core';
import type { CoreDatabase, Sqlite } from '@pasabot/db';
import type { AgentDTO } from '@pasabot/protocol';
import type { ZodType } from 'zod';
import { builtInAgentId } from '../chat/agent-view.js';
import { markUserAuthoredKind } from './shared-blocks.js';

// ---------- logger ----------
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];
export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
  /** redaction filter applied to every line (W0b plugs in the vault redactor) */
  redact: (line: string) => string = (l) => l,
): Logger {
  const min = LEVELS.indexOf(level);
  const write = (l: LogLevel) => (msg: string, data?: Record<string, unknown>) => {
    if (LEVELS.indexOf(l) < min) return;
    process.stderr.write(
      `${redact(JSON.stringify({ t: Date.now(), level: l, msg, ...bindings, ...data }))}\n`,
    );
  };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (b) => createLogger(level, { ...bindings, ...b }, redact),
  };
}

// ---------- auth ----------
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export type AuthResolver = (req: {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}) => Principal | null;
export const bearerOf = (headers: Record<string, string | string[] | undefined>): string | null => {
  const h = headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  const m = v?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
};

/**
 * Bearer-token lookup against `sessions`, `automation_tokens` and `run_tokens` (tokens stored only as sha256).
 * W0b layers cookies, the Host allowlist, loopback/Origin rules and rate limits on top of this.
 */
export function tokenPrincipal(db: Sqlite, token: string, now = Date.now()): Principal | null {
  const h = hashToken(token);
  const s = db
    .prepare(
      `SELECT s.id, s.user_id, u.kind FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
    )
    .get(h, now) as { id: string; user_id: string; kind: 'owner' | 'member' | 'guest' } | undefined;
  if (s) return { kind: 'session', userId: s.user_id, userKind: s.kind, sessionId: s.id };
  const a = db
    .prepare(
      'SELECT id, agent_id FROM automation_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
    )
    .get(h, now) as { id: string; agent_id: string } | undefined;
  if (a) return { kind: 'automation', tokenId: a.id, agentId: a.agent_id };
  const r = db
    .prepare('SELECT run_id, agent_id FROM run_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(h) as { run_id: string; agent_id: string } | undefined;
  if (r) return { kind: 'run', runId: r.run_id, agentId: r.agent_id };
  return null;
}
export const bearerAuthResolver =
  (db: Sqlite): AuthResolver =>
  (req) => {
    const t = bearerOf(req.headers);
    return t ? tokenPrincipal(db, t) : null;
  };

// ---------- registries ----------
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, ToolDef<any, any>>();
  add<I, O>(def: ToolDef<I, O>): void {
    if (!TOOL_NAME_RE.test(def.name))
      throw new Error(`tool name "${def.name}" must be snake_case and module-prefixed`);
    if (this.tools.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
    this.tools.set(def.name, def as ToolDef<any, any>);
  }
  get(name: string) {
    return this.tools.get(name) as ToolDef | undefined;
  }
  list() {
    return [...this.tools.values()] as ToolDef[];
  }
  async invoke(name: string, input: unknown, ctx: ToolCtx): Promise<unknown> {
    const def = this.tools.get(name);
    if (!def) throw new Error(`unknown tool "${name}"`);
    const parsed = def.input.parse(input);
    const out = await def.handler(parsed, ctx);
    return def.output ? def.output.parse(out) : out;
  }
  private guards = new Set<ToolCallGuard>();
  addGuard(g: ToolCallGuard): () => void {
    this.guards.add(g);
    return () => this.guards.delete(g);
  }
  async refusal(call: Parameters<ToolCallGuard>[0]): Promise<string | null> {
    for (const g of [...this.guards]) {
      try {
        const r = await g(call);
        if (r) return r;
      } catch (e) {
        return `refused by a safety check (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    return null;
  }
}

export class BlockKindRegistryImpl implements BlockKindRegistry {
  private kinds = new Map<string, BlockKind>();
  register<T>(
    kind: `${string}.${string}`,
    schema: ZodType<T>,
    opts: {
      v?: number;
      userAuthored?: boolean;
      attachmentRefs?: (data: T) => { sha256: string; name: string; mime: string; size: number }[];
    } = {},
  ): void {
    if (!/^[a-z0-9_-]+\.[a-z0-9_.-]+$/.test(kind))
      throw new Error(`block kind "${kind}" must be <module>.<kind>`);
    if (this.kinds.has(kind)) throw new Error(`block kind "${kind}" is already registered`);
    this.kinds.set(kind, {
      kind,
      v: opts.v ?? 1,
      schema: schema as ZodType<unknown>,
      ...(opts.userAuthored ? { userAuthored: true } : {}),
      ...(opts.attachmentRefs ? { attachmentRefs: opts.attachmentRefs as BlockKind['attachmentRefs'] } : {}),
    });
    // what people may post is the conversation: anyone who reads the chat gets it (chat/view.ts)
    if (opts.userAuthored) markUserAuthoredKind(kind);
  }
  get(kind: string) {
    return this.kinds.get(kind);
  }
  list() {
    return [...this.kinds.values()];
  }
  validate(block: { kind: string; v: number; data: unknown }): { ok: true } | { ok: false; reason: string } {
    const k = this.kinds.get(block.kind);
    if (!k) return { ok: false, reason: 'unknown_kind' };
    if (block.v > k.v) return { ok: false, reason: 'newer_version' };
    const r = k.schema.safeParse(block.data);
    return r.success ? { ok: true } : { ok: false, reason: 'invalid_data' };
  }
}

class MapRegistry<T> {
  protected items = new Map<string, T>();
  constructor(private readonly key: (t: T) => string) {}
  register(t: T): void {
    const k = this.key(t);
    if (this.items.has(k)) throw new Error(`"${k}" is already registered`);
    this.items.set(k, t);
  }
  get(k: string): T | undefined {
    return this.items.get(k);
  }
  list(): T[] {
    return [...this.items.values()];
  }
}
export class TriggerRegistryImpl extends MapRegistry<TriggerSource<any>> implements TriggerRegistry {
  constructor() {
    super((t) => t.kind);
  }
}
export class ChannelRegistryImpl extends MapRegistry<ChannelAdapter<any>> implements ChannelRegistry {
  constructor() {
    super((c) => c.kind);
  }
}
export class MemoryRegistryImpl extends MapRegistry<MemoryBackend> implements MemoryRegistry {
  private poolPort: MemoryPoolPort | undefined;
  /**
   * `checkActor` throws unless the actor is the owner user or `asSystem(reason)`: the W33 export port is reached
   * only through it, so a module cannot skip the check (house rule: core ports take an actor).
   */
  // no default: a registry without an actor check would answer anyone
  constructor(private readonly checkActor: (a: MemoryPoolActor) => void) {
    super((b) => b.id);
  }
  setPool(p: MemoryPoolPort): void {
    if (this.poolPort) throw new Error('a memory pool is already installed');
    this.poolPort = p;
  }
  pool(): MemoryPoolPort | undefined {
    const p = this.poolPort;
    if (!p) return undefined;
    return {
      exportAgent: async (actor, agentId) => {
        this.checkActor(actor);
        return p.exportAgent(actor, agentId);
      },
      importAgent: async (actor, agentId, entries, o) => {
        this.checkActor(actor);
        return p.importAgent(actor, agentId, entries, o);
      },
    };
  }
}
/**
 * W31 x W32: skill manifests in the agent bundle. The safety module installs the port once; `port()` hands out a
 * wrapper whose every call runs `checkActor` first (the owner user or `asSystem(reason)`), so no module skips it.
 */
export class SkillManifestRegistryImpl implements SkillManifestRegistry {
  private installed: SkillManifestPort | undefined;
  constructor(private readonly checkActor: (a: SkillManifestActor) => void) {}
  setPort(p: SkillManifestPort): void {
    if (this.installed) throw new Error('a skill manifest port is already installed');
    this.installed = p;
  }
  port(): SkillManifestPort | undefined {
    const p = this.installed;
    if (!p) return undefined;
    return {
      exportManifests: async (actor, skillIds) => {
        this.checkActor(actor);
        return p.exportManifests(actor, skillIds);
      },
      importProposals: async (actor, entries, o) => {
        this.checkActor(actor);
        return p.importProposals(actor, entries, o);
      },
    };
  }
}
/** W33: modules' prompt context contributors, called by the orchestrator for agent turns with tools. */
export class PromptContextRegistryImpl
  extends MapRegistry<PromptContributor>
  implements PromptContextRegistry
{
  constructor() {
    super((c) => c.id);
  }
}
/** Default policy: always the agent's own provider, never compact (W3 installs the real one). */
export const defaultProviderPolicy: ProviderPolicy = {
  choose: (agent) => ({ providerId: agent.providerId as never, model: agent.model ?? undefined }),
  shouldCompact: () => false,
  summarize: async () => '',
};
export class ProviderRegistryImpl extends MapRegistry<ProviderAdapter> implements ProviderRegistry {
  private current: ProviderPolicy = defaultProviderPolicy;
  constructor() {
    super((p) => p.id);
  }
  unregister(id: string): boolean {
    return this.items.delete(id);
  }
  setPolicy(p: ProviderPolicy): void {
    this.current = p;
  }
  policy(): ProviderPolicy {
    return this.current;
  }
  private prober: ((id: string, o: ProviderProbeOptions) => Promise<ProviderProbeResult>) | null = null;
  /** the host wires the orchestrator's brain test in (it owns the sandbox, env scrub and redaction) */
  setProber(f: (id: string, o: ProviderProbeOptions) => Promise<ProviderProbeResult>): void {
    this.prober = f;
  }
  probe(id: string, o: ProviderProbeOptions): Promise<ProviderProbeResult> {
    if (!this.prober)
      return Promise.resolve({
        ok: false,
        kind: 'crash',
        message: 'brain test is not available here',
        ms: 0,
      });
    return this.prober(id, o);
  }
  /** brains whose last test or turn failed on sign-in (memory only: a restart forgets, the next check tells again) */
  private lost = new Map<string, string>();
  noteSignIn(id: string, ok: boolean, keyStamp = ''): void {
    if (ok) this.lost.delete(id);
    else this.lost.set(id, keyStamp);
  }
  signInLost(id: string, keyStamp = ''): boolean {
    const at = this.lost.get(id);
    if (at === undefined) return false;
    if (at === keyStamp) return true;
    // the brain's keys changed since (a new token or key was saved): what failed was the old sign-in
    this.lost.delete(id);
    return false;
  }
  private signInChecker: ((id: string) => Promise<boolean | 'unknown'>) | null = null;
  /** the host wires the orchestrator's turn-time sign-in check in (it owns the sandbox and the vault) */
  setSignInChecker(f: (id: string) => Promise<boolean | 'unknown'>): void {
    this.signInChecker = f;
  }
  turnSignIn(id: string): Promise<boolean | 'unknown'> {
    return this.signInChecker
      ? this.signInChecker(id).catch(() => 'unknown' as const)
      : Promise.resolve('unknown');
  }
}

/** Holds the one WorkflowStarter (set by the workflows module, looked up by others at call time). */
export class FlowRegistryImpl implements FlowRegistry {
  private starter: WorkflowStarter | undefined;
  set(s: WorkflowStarter): void {
    if (this.starter) throw new Error('a workflow starter is already registered');
    this.starter = s;
  }
  get(): WorkflowStarter | undefined {
    return this.starter;
  }
}

/** Holds the one RoutineControl (set by the routines module, looked up by others at call time). */
export class RoutineRegistryImpl implements RoutineRegistry {
  private control: RoutineControl | undefined;
  set(c: RoutineControl): void {
    if (this.control) throw new Error('a routine control is already registered');
    this.control = c;
  }
  get(): RoutineControl | undefined {
    return this.control;
  }
}

/** Holds the one ManagedBrowserPort (set by the browser module, looked up by others at call time). */
export class ManagedBrowserRegistryImpl implements ManagedBrowserRegistry {
  private port: ManagedBrowserPort | undefined;
  set(p: ManagedBrowserPort): void {
    if (this.port) throw new Error('a managed browser port is already registered');
    this.port = p;
  }
  get(): ManagedBrowserPort | undefined {
    return this.port;
  }
}

/** Core notifier: in-app (a `notification` event on the owner-only `owner` topic); W23 adds web push as a transport. */
export class InAppNotifier implements Notifier {
  private transports: NotifyTransport[] = [];
  /** W40: turns an owner notification into a card in a chat (never a toast); returns the card's id or null */
  private cardSink: ((n: Notification) => string | null) | null = null;
  setCardSink(f: (n: Notification) => string | null) {
    this.cardSink = f;
  }
  constructor(
    private readonly bus: EventBus,
    private readonly i18n?: ServerI18n,
  ) {}
  /** the notification as the person reads it: `msg` rendered in their saved language (W24) */
  private localized(n: Notification): Notification {
    if (!n.msg || !this.i18n) return n;
    const lng = this.i18n.language(n.userId ?? null);
    return {
      ...n,
      title: this.i18n.render(n.msg.title, lng),
      ...(n.msg.body ? { body: this.i18n.render(n.msg.body, lng) } : {}),
    };
  }
  /**
   * In-app always. Without `via`, every transport gets it and failures are swallowed (best effort). With `via`,
   * only the named transports get it (`channel:<id>` -> the `channel` transport) and a missing or failing one
   * rejects, so the caller knows nothing was sent there.
   */
  async notify(raw: Notification): Promise<void> {
    const n = this.localized(raw);
    // in the owner's saved language (W24); owner-only topic (W23): notices name approvals, failed runs and security events, and `global` reaches every
    // member and guest. A notice for another person (`userId`) goes out through the transports (push) only.
    if (!n.userId) {
      let cardId: string | null = null;
      try {
        cardId = this.cardSink?.(n) ?? null;
      } catch {
        cardId = null;
      }
      this.bus.publish('owner', 'notification', {
        level: n.level,
        text: n.body ? `${n.title}: ${n.body}` : n.title,
        ...(n.href ? { href: n.href } : {}),
        ...(cardId ? { cardId } : {}),
      });
    }
    if (!n.via?.length) {
      await Promise.allSettled(this.transports.map((t) => t.send(n)));
      return;
    }
    const errors: string[] = [];
    for (const v of n.via) {
      const t = this.transports.find((x) => x.id === v || v.startsWith(`${x.id}:`));
      if (!t) {
        errors.push(`no "${v.split(':')[0]}" transport is running`);
        continue;
      }
      try {
        await t.send({ ...n, via: [v] });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }
  addTransport(t: NotifyTransport): void {
    this.transports.push(t);
  }
}

export const toAgentDTO = (r: CoreDatabase['agents']): AgentDTO => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  avatar: JSON.parse(r.avatar),
  avatarSalt: r.avatar_salt ?? '',
  instructions: r.instructions,
  providerId: r.provider_id,
  model: r.model,
  providerAccountId: r.provider_account_id,
  fallback: JSON.parse(r.fallback),
  workspaceDir: r.workspace_dir,
  trustLevel: r.trust_level,
  askShellWeb: r.ask_shell_web === null || r.ask_shell_web === undefined ? null : r.ask_shell_web === 1,
  limits: JSON.parse(r.limits),
  status: r.status,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});
export class SqliteAgentReader implements AgentReader {
  constructor(private readonly db: Sqlite) {}
  async get(id: string) {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | CoreDatabase['agents']
      | undefined;
    return r ? toAgentDTO(r) : null;
  }
  async list() {
    return (
      this.db
        .prepare('SELECT * FROM agents WHERE archived_at IS NULL ORDER BY name')
        .all() as CoreDatabase['agents'][]
    ).map(toAgentDTO);
  }
}
/**
 * The agent reader every module gets: the same rows, except the built-in team builder comes with `builtIn: true` and
 * no instructions, so its internal prompt never leaves the server through a module route (a template export, the
 * people list). The runner keeps the plain reader: it needs the real prompt.
 */
export class ModuleAgentReader implements AgentReader {
  private readonly rows: SqliteAgentReader;
  constructor(private readonly db: Sqlite) {
    this.rows = new SqliteAgentReader(db);
  }
  private mask(a: AgentDTO, builtIn: string | null): AgentDTO {
    return builtIn && a.id === builtIn ? { ...a, instructions: '', builtIn: true } : a;
  }
  async get(id: string) {
    const a = await this.rows.get(id);
    return a ? this.mask(a, builtInAgentId(this.db)) : null;
  }
  async list() {
    const builtIn = builtInAgentId(this.db);
    return (await this.rows.list()).map((a) => this.mask(a, builtIn));
  }
}

/** Per-module settings stored in `settings` under `module:<id>:<key>`. */
export function moduleConfig(db: Sqlite, id: string): ModuleConfig {
  return {
    get<T>(key: string, fallback: T): T {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`module:${id}:${key}`) as
        | { value: string }
        | undefined;
      return r ? (JSON.parse(r.value) as T) : fallback;
    },
    set(key: string, value: unknown) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(`module:${id}:${key}`, JSON.stringify(value));
    },
  };
}

/** Until W0b's runner lands, limits are recorded only. */
export const noopRunnerLimits: RunnerLimits = {
  apply: async () => {},
  sample: async () => ({ memMb: 0, cpuPct: 0 }),
};

/** A port whose implementation arrives in a later workstream: every call throws PortUnavailableError. */
export function unavailablePort<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_t, prop) => {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => {
        throw new PortUnavailableError(name);
      };
    },
  });
}
