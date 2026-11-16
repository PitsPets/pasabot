/** Builds the ModuleHost each module's register() receives, and mounts what it registered onto Fastify. */
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import {
  AGENT_ADMIN_MODULES,
  type AgentAdmin,
  type AuthedCtx,
  type AutomationTokens,
  type BlockKindRegistry,
  HttpError,
  HttpResponse,
  type ModuleHost,
  type ModuleRouter,
  mayRegisterTool,
  type Notifier,
  PEOPLE_MODULE,
  PROVIDER_OVERRIDE_MODULES,
  type PublicRouteDef,
  type PublicRouter,
  type QueueService,
  type RouteDef,
  type SitesMount,
  type ToolRegistry,
  toolPrefix,
} from '@pasabot/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { deniedPeoplePort } from '../auth/people.js';
import type { AuthResolver } from '../core/services.js';

export interface MountedModule {
  id: string;
  routes: RouteDef<any>[];
  publicRoutes: PublicRouteDef<any>[];
}

export type HostServices = Omit<
  ModuleHost,
  'id' | 'http' | 'publicHttp' | 'sitesOrigin' | 'log' | 'config' | 'dataDir' | 'cards'
> & {
  log: ModuleHost['log'];
  /** W40: each module's own card port (it posts and handles only cards of its own source) */
  cards(id: string): ModuleHost['cards'];
  config(id: string): ModuleHost['config'];
  sites: SitesStore;
  home: string;
};

/** The one module allowed to reach `ModuleHost.automation` (W21). */
export const AUTOMATION_MODULE_ID = 'automation';
function deniedAutomationPort(id: string): AutomationTokens {
  const no = (): never => {
    throw new Error(`${id}: ModuleHost.automation is only for the ${AUTOMATION_MODULE_ID} module`);
  };
  return { issue: no, revoke: no, get: no, list: no, isActive: no, source: no, budget: no };
}

/** A module's notifier: every notice it sends is stamped with its own id (a notice card claims only its own source). */
export function moduleNotifier(n: Notifier, id: string): Notifier {
  return {
    notify: (x) => n.notify({ ...x, fromModule: id }),
    addTransport: (t) => n.addTransport(t),
  };
}

export function createModuleHost(id: string, s: HostServices): { host: ModuleHost; mounted: MountedModule } {
  const mounted: MountedModule = { id, routes: [], publicRoutes: [] };
  let sealed = false;
  const guard = () => {
    if (sealed) throw new Error(`${id}: routes must be registered inside register()`);
  };
  const http: ModuleRouter = {
    route(def) {
      guard();
      const kinds = Array.isArray(def.auth) ? def.auth : [def.auth];
      if (kinds.length === 0 || kinds.some((k) => !['session', 'automation', 'run'].includes(k))) {
        throw new Error(
          `${id} ${def.method} ${def.url}: auth must be session | automation | run ('public' only on publicHttp)`,
        );
      }
      mounted.routes.push(def);
    },
  };
  const publicHttp: PublicRouter = {
    route(def) {
      guard();
      const rl = def.rateLimit;
      if (!rl || !(rl.max > 0) || !(rl.windowMs > 0))
        throw new Error(`${id} ${def.url}: public routes must set rateLimit`);
      if (!(def.bodyLimit > 0)) throw new Error(`${id} ${def.url}: public routes must set bodyLimit`);
      mounted.publicRoutes.push(def);
    },
  };
  const prefix = toolPrefix(id);
  const tools: ToolRegistry = {
    add(def) {
      if (!mayRegisterTool(id, def.name))
        throw new Error(`${id}: tool "${def.name}" must start with "${prefix}"`);
      // W24: the title a person reads comes from the module's own locale files
      def.titleKey ??= `${id}:tools.${def.name}`;
      s.tools.add(def);
    },
    get: (n) => s.tools.get(n),
    list: () => s.tools.list(),
    invoke: (n, i, c) => {
      // a tool that asks the owner every time (7.1 `noAlwaysAllow`) runs only through the /mcp gateway, which asks;
      // module code calling it directly would skip the ask
      if (s.tools.get(n)?.noAlwaysAllow === true)
        return Promise.reject(
          new Error(`${id}: tool "${n}" asks the owner every time; it runs only through the /mcp gateway`),
        );
      return s.tools.invoke(n, i, c);
    },
    addGuard: (g) => s.tools.addGuard(g),
    refusal: (c) => s.tools.refusal(c),
  };
  const blocks: BlockKindRegistry = {
    register(kind, schema, opts) {
      if (!kind.startsWith(`${id}.`)) throw new Error(`${id}: block kind "${kind}" must start with "${id}."`);
      s.blocks.register(kind, schema, opts);
    },
    get: (k) => s.blocks.get(k),
    list: () => s.blocks.list(),
    validate: (b) => s.blocks.validate(b),
  };
  // the AgentAdmin port reads every chat of an agent and creates agents: only the admin module holds it (5.5)
  const refuse = (): never => {
    throw new HttpError(
      403,
      `${id}: only the ${AGENT_ADMIN_MODULES.join(' and ')} modules may use agentAdmin`,
      'forbidden',
    );
  };
  const agentAdmin: AgentAdmin = AGENT_ADMIN_MODULES.includes(id)
    ? s.agentAdmin
    : { exportBundle: refuse, importBundle: refuse, setLimits: refuse, rename: refuse };
  const dataDir = join(s.home, 'modules', id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const host: ModuleHost = {
    ...s,
    // automation tokens are widening (7.4): only the automation module gets the working port
    automation: id === AUTOMATION_MODULE_ID ? s.automation : deniedAutomationPort(id),
    cards: s.cards(id),
    notifier: moduleNotifier(s.notifier, id),
    agentAdmin,
    // a payload's providerOverride is server-only: every module but collab's silent-lead backup has it dropped
    queue: PROVIDER_OVERRIDE_MODULES.includes(id) ? s.queue : queueWithoutOverride(s.queue),
    // member/guest accounts and chat membership (W23): only the people module gets the working port
    people: id === PEOPLE_MODULE ? s.people : deniedPeoplePort(id),
    id,
    http,
    publicHttp,
    sitesOrigin: s.sites.mount(id),
    tools,
    blocks,
    log: s.log.child({ module: id }),
    config: s.config(id),
    dataDir,
  };
  return {
    host,
    mounted: Object.assign(mounted, {
      seal: () => {
        sealed = true;
      },
    }),
  };
}

// ---------- mounting ----------
function sendResult(reply: FastifyReply, out: unknown) {
  if (out instanceof HttpResponse) {
    reply.code(out.status).headers(out.headers);
    return out.body === null || out.body === undefined ? reply.send() : reply.send(out.body);
  }
  return reply.send(out ?? null);
}
export function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.code, message: e.message });
  if (e instanceof ZodError) return reply.code(400).send({ error: 'invalid_input', message: e.message });
  const code = (e as { code?: string }).code;
  if (code === 'queue_full') return reply.code(503).send({ error: 'queue_full' });
  if (code === 'automation_forbidden') return reply.code(403).send({ error: 'automation_forbidden' });
  if (code === 'people_forbidden') return reply.code(403).send({ error: 'people_forbidden' });
  reply.log?.error?.(e);
  return reply.code(500).send({ error: 'internal' });
}

const reqCtx = (req: FastifyRequest) => ({
  params: (req.params ?? {}) as Record<string, string>,
  query: (req.query ?? {}) as Record<string, string>,
  headers: req.headers,
  ip: req.ip,
});

/**
 * Mount a session/automation/run route; requests whose principal kind is not accepted get 401. With `reauthed`, a
 * session principal carries `reauthed` (a fresh re-auth of that session, 2.4) for routes that need one.
 */
export function mountAuthedRoute(
  app: FastifyInstance,
  base: string,
  def: RouteDef<any>,
  resolveAuth: AuthResolver,
  opts: { reauthed?: (sessionId: string) => boolean } = {},
) {
  const kinds = Array.isArray(def.auth) ? def.auth : [def.auth];
  app.route({
    method: def.method,
    url: `${base}${def.url === '/' ? '' : def.url}`,
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    handler: async (req, reply) => {
      const resolved = resolveAuth({ headers: req.headers, ip: req.ip });
      if (!resolved || !kinds.includes(resolved.kind)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const principal =
        resolved.kind === 'session' && opts.reauthed
          ? { ...resolved, reauthed: opts.reauthed(resolved.sessionId) }
          : resolved;
      try {
        const body = def.body ? def.body.parse(req.body) : req.body;
        const ctx: AuthedCtx = { ...reqCtx(req), body, principal };
        return sendResult(reply, await def.handler(ctx));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  });
}

/** Fixed-window limiter keyed by route + client address. */
class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { n: 0, resetAt: now + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    h.n++;
    return h.n <= this.max
      ? { ok: true }
      : { ok: false, retryAfterS: Math.max(1, Math.ceil((h.resetAt - now) / 1000)) };
  }
}

/** Public hooks live in their own encapsulated context: raw-body parsing, per-route rate limit + body limit. */
export async function mountPublicRoutes(app: FastifyInstance, mods: MountedModule[]) {
  await app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    for (const m of mods) {
      for (const def of m.publicRoutes) {
        const limiter = new RateLimiter(def.rateLimit.max, def.rateLimit.windowMs);
        const url = `/hooks/${m.id}${def.url}`;
        inst.route({
          method: def.method,
          url,
          bodyLimit: def.bodyLimit,
          // limit before the body is read, so floods cost nothing
          onRequest: async (req, reply) => {
            const r = limiter.take(req.ip);
            if (!r.ok)
              return reply
                .code(429)
                .header('retry-after', String(r.retryAfterS))
                .send({ error: 'rate_limited' });
          },
          handler: async (req, reply) => {
            const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            let body: unknown = rawBody;
            if (String(req.headers['content-type'] ?? '').includes('json') && rawBody.length > 0) {
              try {
                body = JSON.parse(rawBody.toString('utf8'));
              } catch {
                return reply.code(400).send({ error: 'invalid_json' });
              }
            }
            try {
              return sendResult(reply, await def.handler({ ...reqCtx(req), body, rawBody }));
            } catch (e) {
              return sendError(reply, e);
            }
          },
        });
      }
    }
  });
}

// ---------- sites origin ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
export const SITES_CSP = 'sandbox allow-scripts';
/** A module id as it may appear as the first sites URL segment: never `.`, `..` or anything with a separator. */
const SITE_MODULE_RE = /^[a-z0-9_-]+$/;

/** Files under $PASABOT_HOME/sites/<module>/..., served only by the separate sites listener. */
export class SitesStore {
  private types = new Map<string, string>();
  baseUrl = '';
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  /**
   * Absolute file path for `<mod>/<path>`. The module id must be a plain id (never `.`/`..`), no path segment may
   * be `.`/`..`/empty-with-backslash tricks, and the result must stay inside `<dir>/<mod>/`.
   */
  private abs(mod: string, path: string) {
    if (!SITE_MODULE_RE.test(mod)) throw new Error(`invalid site module id "${mod}"`);
    const segs = path.split(/[/\\]+/).filter((x) => x !== '');
    if (segs.some((x) => x === '.' || x === '..' || x.includes('\0'))) throw new Error('invalid site path');
    const base = resolve(this.dir);
    const root = resolve(base, mod);
    if (!root.startsWith(base + sep)) throw new Error('path escapes the sites dir');
    const p = resolve(root, normalize(segs.join('/')));
    if (p !== root && !p.startsWith(root + sep)) throw new Error('path escapes the site root');
    return p;
  }
  mount(mod: string): SitesMount {
    if (!SITE_MODULE_RE.test(mod)) throw new Error(`invalid site module id "${mod}"`);
    return {
      put: async (path, data, contentType) => {
        const p = this.abs(mod, path);
        await mkdir(dirname(p), { recursive: true, mode: 0o700 });
        await writeFile(p, data, { mode: 0o600 });
        this.types.set(p, contentType);
      },
      remove: async (path) => {
        const p = this.abs(mod, path);
        this.types.delete(p);
        await rm(p, { force: true, recursive: true });
      },
      url: (path) => `${this.baseUrl}/${mod}/${path.replace(/^\/+/, '')}`,
    };
  }
  async read(urlPath: string): Promise<{ body: Buffer; type: string } | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    const [mod, ...rest] = decoded.replace(/^[/\\]+/, '').split(/[/\\]/);
    if (!mod || !SITE_MODULE_RE.test(mod) || rest.length === 0) return null;
    let p: string;
    try {
      p = this.abs(mod, rest.join('/'));
    } catch {
      return null;
    }
    try {
      const body = await readFile(p);
      return { body, type: this.types.get(p) ?? MIME[extname(p)] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
  /** Routes for the sites listener. Every response carries `CSP: sandbox allow-scripts`. */
  register(app: FastifyInstance) {
    app.addHook('onSend', async (_req, reply, payload) => {
      reply.header('content-security-policy', SITES_CSP);
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });
    app.get('/*', async (req, reply) => {
      const f = await this.read(req.url.split('?')[0]!);
      if (!f) return reply.code(404).type('text/plain').send('not found');
      return reply.type(f.type).send(f.body);
    });
  }
}

/** The payload without `providerOverride` (any other value is passed through untouched). */
export function withoutProviderOverride(payload: unknown): unknown {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, 'providerOverride')
  )
    return payload;
  const { providerOverride: _drop, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/** The queue port as every module but `PROVIDER_OVERRIDE_MODULES` sees it: `enqueue` drops `providerOverride`. */
function queueWithoutOverride(q: QueueService): QueueService {
  if (!q) return q; // a bare host (SDK registration tests) has no queue to guard
  return new Proxy(q, {
    get(target, key) {
      if (key === 'enqueue')
        return (input: Parameters<QueueService['enqueue']>[0]) =>
          target.enqueue(
            input.payload === undefined
              ? input
              : { ...input, payload: withoutProviderOverride(input.payload) },
          );
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
