/** Server boot: db + migrations, discovery, module registration, HTTP/WS + sites listeners, queue + dispatcher. */
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import {
  type ApprovalService,
  type BlobStore,
  type ChannelAdapter,
  canLinkFiles,
  httpResponse,
  mkdirPrivate,
  type PasaBotModule,
  type Principal,
  type ProviderAdapter,
  protectDataDir,
  type RunnerLimits,
  type SafeNet,
  type SecretVault,
  type ServerI18n,
  ulid,
} from '@pasabot/core';
import {
  CORE_MIGRATIONS_DIR,
  createKysely,
  type MigrationSet,
  openDatabase,
  runMigrations,
  type Sqlite,
} from '@pasabot/db';
import type { Resource } from '@pasabot/i18n';
import { loadLocaleDir } from '@pasabot/i18n/node';
import { cardDataSchema } from '@pasabot/protocol';
import { createSafeNet } from '@pasabot/safe-net';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { ApprovalServiceImpl } from '../approvals/index.js';
import { automationPort } from '../auth/automation.js';
import { type Auth, createAuth } from '../auth/index.js';
import { createPeoplePort, createSessionReader } from '../auth/people.js';
import { ChannelRuntime, type ChannelRuntimeOptions } from '../channels/runtime.js';
import { createAgentAdmin } from '../chat/agent-admin.js';
import { FsBlobStore } from '../chat/blobs.js';
import { registerChatRoutes } from '../chat/index.js';
import { createChatPort } from '../chat/port.js';
import { DROP, type MessageViewer, viewEvent, viewPayload } from '../chat/view.js';
import { Bus, EventStore } from '../core/bus.js';
import { CARD_KIND, CardService, registerCardActions } from '../core/cards.js';
import { Dispatcher, type Executor } from '../core/dispatcher.js';
import { createServerI18n, workspaceLocaleFiles } from '../core/i18n.js';
import { KillSwitch } from '../core/kill-switch.js';
import { type QueueRow, SqliteQueue } from '../core/queue.js';
import {
  type AuthResolver,
  BlockKindRegistryImpl,
  ChannelRegistryImpl,
  createLogger,
  FlowRegistryImpl,
  InAppNotifier,
  type LogLevel,
  ManagedBrowserRegistryImpl,
  MemoryRegistryImpl,
  ModuleAgentReader,
  moduleConfig,
  noopRunnerLimits,
  PromptContextRegistryImpl,
  ProviderRegistryImpl,
  RoutineRegistryImpl,
  SkillManifestRegistryImpl,
  SqliteAgentReader,
  ToolRegistryImpl,
  TriggerRegistryImpl,
  unavailablePort,
} from '../core/services.js';
import { registerWs } from '../core/ws.js';
import { registerMcp } from '../mcp/index.js';
import { Orchestrator } from '../runner/orchestrator.js';
import {
  defaultRunnerMode,
  hostModeWarning,
  linuxSandboxProblem,
  noOsSandbox,
  type RunnerMode,
} from '../runner/sandbox.js';
import {
  createRedactor,
  LocalVault,
  type MasterKeySource,
  type Redact,
  VaultConfigError,
} from '../vault/index.js';
import { type DiscoveredPackage, discoverPackages, loadEntry } from './discovery.js';
import {
  createModuleHost,
  type MountedModule,
  mountAuthedRoute,
  mountPublicRoutes,
  SitesStore,
} from './module-host.js';
import { type NoticeId, registerNoticeRoutes, type SystemNotice } from './notices.js';
import { serveWebApp } from './web-static.js';

export const VERSION = '0.0.0';

export interface ServerOptions {
  /** $PASABOT_HOME */
  home: string;
  /** workspace root to discover providers/channels/modules/plugins in; null = no discovery */
  root?: string | null;
  host?: string;
  /** 0 = any free port */
  port?: number;
  sitesPort?: number;
  /** extra in-process modules (tests) */
  modules?: PasaBotModule[];
  providers?: ProviderAdapter[];
  /** extra in-process channel adapters (tests); discovered `channel` packages are added too */
  channels?: ChannelAdapter<any>[];
  /** binding runtime tuning (backoff, edit throttle); tests shorten it */
  channelRuntime?: ChannelRuntimeOptions;
  /** replaces the default provider executor (tests, W0b orchestrator) */
  executor?: Executor;
  dispatcher?: {
    maxConcurrentAgents?: number;
    renewMs?: number;
    pollMs?: number;
    sweepMs?: number;
    autoStart?: boolean;
  };
  queue?: { depthCap?: number; leaseMs?: number };
  /** events-ring prune + idle WAL checkpoint interval (default 10 min) */
  maintenanceMs?: number;
  ws?: { heartbeatMs?: number; maxBufferedBytes?: number; maxReplay?: number; recheckMs?: number };
  logLevel?: LogLevel;
  /** hostnames besides localhost/127.0.0.1/[::1] that may reach the server (Host allowlist, 4.1) */
  allowedHosts?: string[];
  /** extra browser origins (exact scheme://host:port) allowed on WS upgrades and mutations, e.g. a dev web server */
  allowedOrigins?: string[];
  /** runner sandbox mode (7.2); default per platform, or PASABOT_RUNNER */
  runnerMode?: RunnerMode;
  /** the operating system the notices and Windows data-folder protection are for (default: this one; tests) */
  platform?: NodeJS.Platform;
  /** vault master key: source + passphrase (default: PASABOT_VAULT_PASSPHRASE / keychain / vault.key per mode) */
  vault?: { source?: MasterKeySource; passphrase?: string };
  /** base URL of the web app, used in the first-run setup link (default: this server) */
  publicUrl?: string;
  /** built web app to serve at `/` (default: none) */
  webDir?: string | null;
  /** approval expiry (default 30 min) */
  approvalExpiresMs?: number;
  /** print the first-run setup link to stderr (default true outside tests) */
  printSetupLink?: boolean;
  /** later workstreams plug real implementations in here */
  ports?: {
    vault?: SecretVault;
    net?: SafeNet;
    files?: BlobStore;
    approvals?: ApprovalService;
    auth?: AuthResolver;
    /** per-agent memory/CPU limits (default: recorded only until the runner enforces them) */
    runner?: RunnerLimits;
  };
}

export interface PasaBotServer {
  url: string;
  sitesUrl: string;
  home: string;
  serverId: string;
  bootId: string;
  db: Sqlite;
  kysely: Kysely<any>;
  bus: Bus;
  events: EventStore;
  queue: SqliteQueue;
  dispatcher: Dispatcher;
  /** the W31 global stop */
  killSwitch: KillSwitch;
  tools: ToolRegistryImpl;
  blocks: BlockKindRegistryImpl;
  providers: ProviderRegistryImpl;
  triggers: TriggerRegistryImpl;
  channels: ChannelRegistryImpl;
  memory: MemoryRegistryImpl;
  skillManifests: SkillManifestRegistryImpl;
  /** W30: the managed browser port the browser module sets (absent without it) */
  browser: ManagedBrowserRegistryImpl;
  prompt: PromptContextRegistryImpl;
  notifier: InAppNotifier;
  /** W40: the one card family (cards in chats, the open list for the pinned decision bar) */
  cards: CardService;
  auth: Auth;
  approvals: ApprovalServiceImpl;
  vault: SecretVault;
  redact: Redact;
  orchestrator: Orchestrator;
  /** the channel binding runtime (W4b); idle when the `channels` module is not loaded */
  channelRuntime: ChannelRuntime;
  runnerMode: RunnerMode;
  /** one-line warnings logged once at startup (e.g. the macOS host-mode keychain limitation) */
  startupWarnings: string[];
  /** set when the first-run setup token was minted at boot (no owner yet) */
  setupLink: string | null;
  packages: DiscoveredPackage[];
  modules: string[];
  locales: Resource;
  /** W24: server-written text in each person's saved language */
  i18n: ServerI18n;
  app: FastifyInstance;
  sitesApp: FastifyInstance;
  close(): Promise<void>;
}

export async function startServer(o: ServerOptions): Promise<PasaBotServer> {
  // the logger redacts known secret values once the vault is open (7.3)
  let redactRef: Redact = (t) => t;
  const log = createLogger(o.logLevel ?? 'info', {}, (t) => redactRef(t));
  // owner-only (0o700), and an older home made with default permissions is tightened on boot
  for (const d of ['', 'blobs', 'workspaces', 'skills', 'sites', 'logs', 'backups', 'modules']) {
    mkdirPrivate(join(o.home, d), { tighten: true });
  }
  const db = openDatabase(join(o.home, 'pasabot.db'));
  try {
    return await boot(o, db, log, (r) => {
      redactRef = r;
    });
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * A test-only package (`"testOnly": true`, the Fake brain) loads only under Vitest or with `PASABOT_TEST_BRAINS=1`, so a
 * normal server never lists it as a brain a person could pick.
 */
export const testPackagesAllowed = (env: NodeJS.ProcessEnv = process.env) =>
  !!env.VITEST || env.PASABOT_TEST_BRAINS === '1';

async function boot(
  o: ServerOptions,
  db: Sqlite,
  log: ReturnType<typeof createLogger>,
  setRedactor: (r: Redact) => void,
): Promise<PasaBotServer> {
  // 1. discovery + entries (modules declare their migration dirs); test-only packages stay out of a normal server
  const allowTest = testPackagesAllowed();
  const packages = (o.root ? discoverPackages(o.root) : []).filter((p) => allowTest || !p.pasabot.testOnly);
  if (o.root && packages.length === 0)
    log.warn('discovery found no pasabot packages; set PASABOT_ROOT to the install or workspace root', {
      root: o.root,
    });
  const modules: PasaBotModule[] = [];
  const providerAdapters: ProviderAdapter[] = [...(o.providers ?? [])];
  const channelAdapters: ChannelAdapter<any>[] = [...(o.channels ?? [])];
  for (const p of packages) {
    const entry = await loadEntry<unknown>(p);
    if (p.pasabot.kind === 'module' || p.pasabot.kind === 'plugin') modules.push(entry as PasaBotModule);
    else if (p.pasabot.kind === 'provider') providerAdapters.push(entry as ProviderAdapter);
    else if (p.pasabot.kind === 'channel') channelAdapters.push(entry as ChannelAdapter<any>);
  }
  modules.push(...(o.modules ?? []));
  const ids = new Set<string>();
  for (const m of modules) {
    if (ids.has(m.id)) throw new Error(`duplicate module id "${m.id}"`);
    ids.add(m.id);
  }

  // 2. migrations: core first, then modules by id; a changed applied file throws and boot stops here
  const sets: MigrationSet[] = [{ module: 'core', dir: CORE_MIGRATIONS_DIR }];
  for (const m of modules) if (m.migrations) sets.push({ module: m.id, dir: m.migrations });
  runMigrations(db, sets, { backupDir: join(o.home, 'backups') });

  // 3. core services
  const kysely = createKysely<any>(db);
  const serverId = ensureServerId(db);
  const bootId = ulid();
  const events = new EventStore(db);
  events.prune();
  const bus = new Bus(events);
  const queue = new SqliteQueue(db, bus, { ...o.queue, log });
  // W31: the stored stop flag is read here, before anything can lease
  const killSwitch = new KillSwitch(db, queue, log);
  const tools = new ToolRegistryImpl();
  const blocks = new BlockKindRegistryImpl();
  const providers = new ProviderRegistryImpl();
  for (const p of providerAdapters) providers.register(p);
  const triggers = new TriggerRegistryImpl();
  const channels = new ChannelRegistryImpl();
  // the W33 export port (memory) and the W31 x W32 skill-manifest port answer the owner user or an explicit
  // asSystem(reason) only
  const ownerOrSystem = (actor: { kind?: unknown; id?: unknown } | null | undefined) =>
    actor?.kind === 'system' ||
    (actor?.kind === 'user' &&
      typeof actor.id === 'string' &&
      !!db
        .prepare("SELECT 1 FROM users WHERE id = ? AND kind = 'owner' AND disabled_at IS NULL")
        .get(actor.id));
  const memory = new MemoryRegistryImpl((actor) => {
    if (!ownerOrSystem(actor))
      throw new Error('only the owner (or the server itself) exports or imports agent memory');
  });
  const skillManifests = new SkillManifestRegistryImpl((actor) => {
    if (!ownerOrSystem(actor))
      throw new Error('only the owner (or the server itself) exports or imports skill manifests');
  });
  const prompt = new PromptContextRegistryImpl();
  for (const c of channelAdapters) channels.register(c);
  // W24: server-written text in each person's saved language (push, channels, stored messages)
  const locales = o.root ? loadLocaleDir(o.root) : workspaceLocaleFiles();
  const i18n = createServerI18n(db, locales);
  const notifier = new InAppNotifier(bus, i18n);
  const flows = new FlowRegistryImpl();
  const routines = new RoutineRegistryImpl();
  const browser = new ManagedBrowserRegistryImpl();
  const agents = new SqliteAgentReader(db);
  const runnerMode = o.runnerMode ?? defaultRunnerMode();
  let baseUrl = '';
  let sitesBaseUrl = '';
  const auth = createAuth({
    db,
    serverId,
    allowedHosts: o.allowedHosts,
    allowedOrigins: o.allowedOrigins,
    publicUrl: () => o.publicUrl ?? baseUrl,
    notifier,
    serverPort: () => (baseUrl ? Number(new URL(baseUrl).port) || null : null),
    // the sites origin serves untrusted HTML: never an allowed Origin, whatever the config says (8, "Exposure")
    deniedOrigins: () =>
      sitesBaseUrl
        ? [
            sitesBaseUrl,
            ...['localhost', '127.0.0.1', '[::1]'].map((h) => `http://${h}:${new URL(sitesBaseUrl).port}`),
          ]
        : [],
  });
  const resolveAuth = o.ports?.auth ?? auth.resolver;
  // what the owner should know about this computer: plain cards (notices.ts), never only a log line
  const platform = o.platform ?? process.platform;
  const notices: SystemNotice[] = [];
  const notice = (id: NoticeId) => {
    if (!notices.some((n) => n.id === id)) notices.push({ id });
  };
  if (platform === 'win32') {
    // chmod is a no-op on Windows: the data folder (db, vault key, run/, logs) gets an access list for this user only
    if (protectDataDir(o.home, { platform }) === 'failed') {
      notice('data-folder-open');
      log.warn('could not lock the data folder to this Windows user (access list)');
    }
    if (!canLinkFiles(join(o.home, 'run'))) notice('signin-links');
  }
  if (noOsSandbox(runnerMode) && platform === 'win32') {
    notice('windows-no-sandbox');
    // with no sandbox, new helpers start careful (asks before anything outside its folder) until the owner changes it
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('agents.defaultTrust', ?) ON CONFLICT(key) DO NOTHING",
    ).run(JSON.stringify('guarded'));
  }
  if (runnerMode === 'host' && platform === 'linux') {
    const problem = linuxSandboxProblem({ platform });
    if (problem) notice(`linux-sandbox-${problem}`);
  }
  let vault: SecretVault;
  let redact: Redact = (t) => t;
  if (o.ports?.vault) vault = o.ports.vault;
  else {
    try {
      const lv = await LocalVault.open({
        db,
        home: o.home,
        serverId,
        runnerMode,
        source: o.vault?.source,
        passphrase: o.vault?.passphrase ?? process.env.PASABOT_VAULT_PASSPHRASE,
        onNotice: (n) => notice(n),
      });
      vault = lv;
      redact = createRedactor(lv);
    } catch (e) {
      if (!(e instanceof VaultConfigError)) throw e;
      log.warn('vault unavailable', { reason: e.message });
      notice('vault-unavailable');
      vault = unavailablePort<SecretVault>('vault');
    }
  }
  setRedactor(redact);
  const approvals = new ApprovalServiceImpl({
    db,
    bus,
    notifier,
    defaultExpiresMs: o.approvalExpiresMs,
    i18n,
  });
  // W31: a stop expires every pending approval, so nothing can be approved into an action while stopped
  killSwitch.onStop(() =>
    approvals.expireAllPending().map((a) => ({
      kind: 'approval',
      id: a.id,
      label: a.summary.slice(0, 120),
      agentId: a.agentId,
      runId: a.runId,
      outcome: 'cancelled' as const,
    })),
  );
  const files = o.ports?.files ?? new FsBlobStore(db, join(o.home, 'blobs'));
  const net = o.ports?.net ?? createSafeNet();
  const sites = new SitesStore(join(o.home, 'sites'));
  blocks.register('core.interrupted', z.object({ queueItemId: z.string(), partial: z.string().optional() }));
  blocks.register(
    'core.approval',
    z.object({ id: z.string(), state: z.string(), tier: z.number() }).passthrough(),
  );

  // 4. crash recovery before anything can lease
  const onInterrupted = async (rows: QueueRow[]) => {
    for (const r of rows) {
      // the turn's reply message was still `streaming` (or closed as interrupted by a graceful stop): its partial text moves into the card (or stays as an
      // errored reply when there is no card), so no typing bubble outlives the run
      const orphans = db
        .prepare(
          "SELECT m.id, m.chat_id, m.body FROM messages m JOIN runs ru ON ru.id = m.run_id WHERE ru.queue_item_id = ? AND (m.status = 'streaming' OR (m.status = 'error' AND ru.state = 'interrupted'))",
        )
        .all(r.id) as { id: string; chat_id: string; body: string }[];
      const partial = orphans
        .map((o) => o.body)
        .join('\n')
        .trim();
      const spec = queue.kindSpec(r.kind);
      const chat = r.chat_id ? db.prepare('SELECT id FROM chats WHERE id = ?').get(r.chat_id) : undefined;
      if (spec?.blocksOnInterrupt && r.chat_id && chat) {
        for (const o of orphans) {
          db.prepare('DELETE FROM messages WHERE id = ?').run(o.id);
          bus.publish(`chat:${o.chat_id}`, 'message.deleted', { id: o.id, chatId: o.chat_id });
        }
        const id = ulid();
        const now = Date.now();
        const data = { queueItemId: r.id, ...(partial ? { partial } : {}) };
        const blocksJson = JSON.stringify([{ kind: 'core.interrupted', v: 1, data }]);
        db.prepare(
          "INSERT INTO messages (id, chat_id, author_kind, body, blocks, status, created_at) VALUES (?, ?, 'system', ?, ?, 'final', ?)",
        ).run(id, r.chat_id, 'interrupted', blocksJson, now);
        bus.publish(`chat:${r.chat_id}`, 'message.created', {
          id,
          chatId: r.chat_id,
          authorKind: 'system',
          authorId: null,
          replyTo: null,
          body: 'interrupted',
          blocks: [{ kind: 'core.interrupted', v: 1, data }],
          status: 'final',
          runId: null,
          createdAt: now,
          editedAt: null,
        });
      } else {
        for (const o of orphans)
          db.prepare("UPDATE messages SET status = 'error', edited_at = ? WHERE id = ?").run(
            Date.now(),
            o.id,
          );
        await notifier.notify({
          level: 'warn',
          title: 'Run interrupted by a server restart',
          body: `${r.kind} ${r.id}`,
          msg: {
            title: { key: 'core:server.interrupted' },
            body: { key: 'core:server.interruptedBody', params: { kind: r.kind, id: r.id } },
          },
        });
      }
    }
  };
  await onInterrupted(queue.recover(bootId).interrupted);

  // W40 cards: one card family in the chats; server notifications become cards (never toasts)
  const chatPort = createChatPort(db, bus, { blocks, redact: (t: string) => redact(t), i18n });
  blocks.register(CARD_KIND, cardDataSchema);
  const cards = new CardService({ db, bus, chats: chatPort, i18n, log: log.child({ part: 'cards' }) });
  notifier.setCardSink((n) => cards.fromNotification(n)?.id ?? null);
  const cardActions = registerCardActions(cards, { queue, notifier });

  // 5. modules
  const services = {
    db: kysely,
    raw: db,
    bus,
    tools,
    triggers,
    channels,
    providers,
    blocks,
    memory,
    prompt,
    skillManifests,
    vault,
    net,
    files,
    approvals: o.ports?.approvals ?? approvals.forModules(),
    flows,
    routines,
    browser,
    automation: automationPort(db),
    notifier,
    queue,
    // modules see the built-in team builder without its internal prompt (the runner keeps the plain reader)
    agents: new ModuleAgentReader(db),
    agentAdmin: createAgentAdmin({ db, bus, home: o.home, blocks, redact: (t: string) => redact(t), i18n }),
    chats: chatPort,
    cards: (id: string) => cards.forModule(id),
    killSwitch,
    people: createPeoplePort({ db, bus, auth, queue }),
    sessions: createSessionReader(db),
    runner: o.ports?.runner ?? noopRunnerLimits,
    log,
    config: (id: string) => moduleConfig(db, id),
    redact: (t: string) => redact(t),
    i18n,
    sites,
    home: o.home,
  };
  const mounted: (MountedModule & { seal(): void })[] = [];
  for (const m of [...modules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const { host, mounted: mm } = createModuleHost(m.id, services);
    await m.register(host);
    (mm as MountedModule & { seal(): void }).seal();
    mounted.push(mm as MountedModule & { seal(): void });
  }

  // 6. HTTP + WS
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  auth.registerGuards(app); // Host allowlist + Origin checks run before every route, WS included
  // Cards, approvals and every other owner-only part are the owner's (chat/view.ts, deny by default): whoever else a
  // response or a socket frame goes to (a member, a guest, a helper's token, a linked machine) gets it through the
  // one message serialiser, on every route (core and module) and every event, live and replayed
  const viewerOf = (p: Principal | null): MessageViewer =>
    p?.kind === 'session' ? { kind: p.userKind, userId: p.userId } : { kind: p?.kind ?? 'anonymous' };
  const viewDeps = { db, i18n };
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    if (!String(reply.getHeader('content-type') ?? '').includes('json')) return payload;
    const viewer = viewerOf(resolveAuth({ headers: req.headers, ip: req.ip }));
    if (viewer.kind === 'owner') return payload;
    try {
      const v = viewPayload(JSON.parse(payload), viewer, viewDeps);
      return JSON.stringify(v === DROP ? null : v);
    } catch {
      return 'null'; // fail closed: never the owner's cards unread
    }
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  registerWs(app, {
    view: (type, data, p) => {
      const v = viewEvent(type, data, viewerOf(p), viewDeps);
      return v === DROP ? 'drop' : { data: v };
    },
    bus,
    store: events,
    db,
    serverId,
    resolve: resolveAuth,
    heartbeatMs: o.ws?.heartbeatMs,
    maxBufferedBytes: o.ws?.maxBufferedBytes,
    maxReplay: o.ws?.maxReplay,
    recheckMs: o.ws?.recheckMs,
  });
  registerCoreRoutes(app, { queue, db, serverId, resolveAuth, cards });
  auth.registerRoutes(app);
  approvals.registerRoutes(app, resolveAuth, {
    reauthed: (sid) => auth.reauthedWithin(sid),
    freshReauth: (sid, approvalId) => auth.takeFreshReauth(sid, approvalId),
  });
  const orchestrator = new Orchestrator({
    db,
    bus,
    providers,
    agents,
    approvals,
    notifier,
    log,
    home: o.home,
    runnerMode,
    redact,
    baseUrl: () => baseUrl,
    files,
    queue,
    prompt,
    vault,
    cards,
  });
  providers.setProber((id, po) => orchestrator.probe(id, po));
  providers.setSignInChecker((id) => orchestrator.turnSignIn(id));
  registerChatRoutes(app, {
    db,
    bus,
    queue,
    providers,
    orchestrator,
    files,
    home: o.home,
    resolveAuth,
    redact,
    blocks,
    i18n,
    vault,
  });
  registerMcp(app, {
    db,
    tools,
    approvals,
    net,
    log,
    home: o.home,
    redact,
    vault,
    isStopped: () => killSwitch.isStopped(),
  });
  registerNoticeRoutes(app, { resolveAuth, notices: () => notices, platform, root: o.root ?? null });
  if (o.webDir) serveWebApp(app, o.webDir, () => (sites.baseUrl ? [new URL(sites.baseUrl).origin] : []));
  for (const m of mounted)
    for (const r of m.routes)
      mountAuthedRoute(app, `/api/m/${m.id}`, r, resolveAuth, {
        reauthed: (sid) => auth.reauthedWithin(sid),
      });
  await mountPublicRoutes(app, mounted);

  const sitesApp = Fastify({ logger: false });
  sites.register(sitesApp);

  const host = o.host ?? '127.0.0.1';
  const url = await app.listen({ host, port: o.port ?? 0 });
  baseUrl = url;
  const sitesUrl = await sitesApp.listen({ host, port: o.sitesPort ?? 0 });
  sites.baseUrl = sitesUrl;
  sitesBaseUrl = sitesUrl;

  // 7. dispatcher
  const executor = o.executor ?? orchestrator.executor();
  const dispatcher = new Dispatcher(queue, executor, {
    bootId,
    log,
    onRecovered: (res) => {
      onInterrupted(res.interrupted).catch((e) =>
        log.error('interrupted notice failed', { error: String(e) }),
      );
    },
    stop: { isStopped: () => killSwitch.isStopped(), whileStopped: () => void killSwitch.holdQueued() },
    ...o.dispatcher,
  });
  killSwitch.bindDispatcher(dispatcher);
  if (o.dispatcher?.autoStart !== false) dispatcher.start();

  // 7b. channel bindings (W4b): one connection per configured binding, inbound -> chats + queue, replies out
  const channelRuntime = new ChannelRuntime({
    db,
    bus,
    queue,
    channels,
    vault,
    approvals,
    agents,
    log: log.child({ part: 'channels' }),
    redact: (t) => redact(t),
    options: o.channelRuntime,
    i18n,
  });
  channelRuntime.start();
  // workflow output to a channel (W9) goes out through the binding runtime, to the owner's own DM
  if (ChannelRuntime.available(db)) notifier.addTransport(channelRuntime.transport());

  // 8. maintenance: keep the events ring bounded while up; checkpoint the WAL when idle (ARCHITECTURE 3.1, 6)
  const maintenance = setInterval(
    () => {
      try {
        events.prune();
        if (dispatcher.runningItems().length === 0) db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e) {
        log.warn('maintenance pass failed', { error: String(e) });
      }
    },
    o.maintenanceMs ?? 10 * 60_000,
  );
  maintenance.unref?.();

  log.info('pasabot server ready', { url, sitesUrl, runnerMode, modules: modules.map((m) => m.id) });
  const startupWarnings = [hostModeWarning(runnerMode)].filter((w): w is string => !!w);
  for (const w of startupWarnings) log.warn(w);
  // first run: mint a single-use setup token and print the link (4.1); `pasabot setup-link` mints another
  let setupLink: string | null = null;
  if (auth.needsSetup()) {
    setupLink = auth.setupLink(auth.issueSetupToken());
    if (o.printSetupLink ?? o.logLevel !== 'silent')
      process.stderr.write(
        `\npasabot: no owner yet. Open this link within 30 minutes to claim the server:\n  ${setupLink}\n\n`,
      );
  }
  let closed = false;
  return {
    url,
    sitesUrl,
    home: o.home,
    serverId,
    bootId,
    db,
    kysely,
    bus,
    events,
    queue,
    dispatcher,
    killSwitch,
    tools,
    blocks,
    providers,
    triggers,
    channels,
    memory,
    prompt,
    skillManifests,
    browser,
    notifier,
    cards,
    auth,
    approvals,
    vault,
    redact,
    orchestrator,
    channelRuntime,
    runnerMode,
    startupWarnings,
    setupLink,
    packages,
    modules: modules.map((m) => m.id).sort(),
    locales,
    i18n,
    app,
    sitesApp,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenance);
      await channelRuntime.close();
      await dispatcher.stop();
      cardActions.close();
      approvals.close();
      await Promise.allSettled([app.close(), sitesApp.close()]);
      await kysely.destroy().catch(() => {});
      if (db.open) db.close();
    },
  };
}

function ensureServerId(db: Sqlite): string {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'server.id'").get() as
    | { value: string }
    | undefined;
  if (r) return JSON.parse(r.value) as string;
  const id = ulid();
  db.prepare("INSERT INTO settings (key, value) VALUES ('server.id', ?)").run(JSON.stringify(id));
  return id;
}

/**
 * Core REST that W0a owns: health and queue controls (REST, never WS RPC). Queue controls check the principal:
 * the owner may do everything; any other user sees and acts only on items they sent themselves, in chats they
 * are still a member of (anything else is 404, no existence leak); pausing/resuming an agent's queue is owner-only.
 */
function registerCoreRoutes(
  app: FastifyInstance,
  d: { queue: SqliteQueue; db: Sqlite; serverId: string; resolveAuth: AuthResolver; cards: CardService },
) {
  app.get('/api/v1/health', async () => ({ ok: true, serverId: d.serverId, version: VERSION }));
  const base = '/api/v1';
  type Session = Extract<Principal, { kind: 'session' }>;
  const route = (
    method: 'GET' | 'POST',
    url: string,
    handler: (p: Record<string, string>, who: Session) => unknown,
  ) =>
    mountAuthedRoute(
      app,
      base,
      { method, url, auth: 'session', handler: (ctx) => handler(ctx.params, ctx.principal as Session) },
      d.resolveAuth,
    );
  const notFound = () => httpResponse(404, { error: 'not_found' });
  const ownerOnly = () => httpResponse(403, { error: 'owner_only' });
  /** a non-owner's own item in a chat they belong to */
  const mayTouch = (who: Session, row: QueueRow | null): row is QueueRow => {
    if (!row) return false;
    if (who.userKind === 'owner') return true;
    if (!row.chat_id) return false;
    const member = d.db
      .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
      .get(row.chat_id, who.userId);
    if (!member) return false;
    let sender: { kind?: string; id?: string | null } | undefined;
    try {
      sender = (JSON.parse(row.source ?? '{}') as { sender?: typeof sender }).sender;
    } catch {
      return false;
    }
    return sender?.id === who.userId && ['member', 'guest'].includes(sender.kind ?? '');
  };
  const act = (ok: boolean) => (ok ? { ok: true } : httpResponse(409, { error: 'invalid_state' }));
  route('GET', '/agents/:agentId/queue', (p, who) => {
    const items = d.queue.list(p.agentId!);
    return {
      items: who.userKind === 'owner' ? items : items.filter((i) => mayTouch(who, d.queue.getRow(i.id))),
      paused: d.queue.isPaused(p.agentId!),
    };
  });
  route('POST', '/agents/:agentId/queue/pause', (p, who) => {
    if (who.userKind !== 'owner') return ownerOnly();
    d.queue.pause(p.agentId!);
    return { ok: true };
  });
  route('POST', '/agents/:agentId/queue/resume', (p, who) => {
    if (who.userKind !== 'owner') return ownerOnly();
    d.queue.resume(p.agentId!);
    return { ok: true };
  });
  // W40 cards: the open cards that need an answer (the pinned decision bar) and the owner's tap on a card
  route('GET', '/cards', (_p, who) => {
    if (who.userKind !== 'owner') return ownerOnly();
    return { cards: d.cards.open({ kind: who.userKind, userId: who.userId }) };
  });
  // a card's technical words (an error's raw text): the owner's only, never in the block every reader gets
  route('GET', '/cards/:id/detail', (p, who) => {
    if (who.userKind !== 'owner') return ownerOnly();
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(p.id ?? '')) return notFound();
    return { detail: d.cards.detail(p.id!, { kind: who.userKind, userId: who.userId }) };
  });
  mountAuthedRoute(
    app,
    base,
    {
      method: 'POST',
      url: '/cards/:id/act',
      auth: 'session',
      body: z.object({ action: z.string().max(40) }),
      handler: async (ctx) => {
        const who = ctx.principal as Session;
        if (who.userKind !== 'owner') return ownerOnly();
        const id = ctx.params.id ?? '';
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return notFound();
        return { card: await d.cards.act(id, ctx.body.action, who.userId) };
      },
    },
    d.resolveAuth,
  );
  for (const verb of ['retry', 'skip', 'cancel'] as const) {
    route('POST', `/queue/:id/${verb}`, (p, who) => {
      if (!mayTouch(who, d.queue.getRow(p.id!))) return notFound();
      return act(d.queue[verb](p.id!));
    });
  }
}
