/**
 * Local models (W34): owner-configured Ollama / OpenAI-compatible (LM Studio style) endpoints, each registered as a
 * runtime provider `local:<id>` that any agent (or a W3 fallback chain) can use. A provider package that is also a
 * module, because the endpoints are owner data: only an owner session can add, change or remove one (agents, run
 * tokens and automation tokens never reach these routes, and no tool exposes them), and safe-net reaches only the
 * origins stored here (ARCHITECTURE 12).
 *
 * Ollama and LM Studio on their default loopback ports are also registered by themselves (`local:ollama`,
 * `local:lmstudio`, see `FOUND_APPS`), so an installed app shows up without adding an endpoint.
 *
 * REST (`/api/m/local`, owner session): GET /endpoints, GET /detect (probes the usual loopback ports), POST /check
 * (classify + probe a URL without saving), POST /endpoints, PATCH /endpoints/:id, DELETE /endpoints/:id,
 * GET /endpoints/:id/models.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  type ModuleHost,
  type PasaBotModule,
  type ProviderStatus,
  ulid,
} from '@pasabot/core';
import { classifyLocalModelUrl } from '@pasabot/safe-net';
import { z } from 'zod';
import {
  isUnreachable,
  type LocalApi,
  type LocalEndpoint,
  type LocalHistoryStore,
  LocalModelAdapter,
  type LocalMsg,
} from './adapter.js';

export {
  isUnreachable,
  type LocalApi,
  type LocalEndpoint,
  LocalModelAdapter,
  readOllama,
  readOpenAi,
  TOOLS_OFF_NOTE,
} from './adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_ENDPOINTS = 20;
/** a Settings probe (list models, check a URL) answers within this, never the turn's 120 s */
const PROBE_TIMEOUT_MS = 5_000;
/** a native session's history is dropped after this long without a turn */
const HISTORY_IDLE_MS = 180 * 24 * 3600_000;
/** cap on one session's stored history (JSON characters); the oldest exchanges go first */
const HISTORY_MAX_CHARS = 2 * 1024 * 1024;

/** Where Ollama and LM Studio listen by default (loopback only; detection never scans the network). */
export const DEFAULT_CANDIDATES: { api: LocalApi; url: string; name: string }[] = [
  { api: 'ollama', url: 'http://127.0.0.1:11434', name: 'Ollama' },
  { api: 'openai', url: 'http://127.0.0.1:1234/v1', name: 'LM Studio' },
];

/**
 * A local model app PasaBot looks for on this computer by itself, with no endpoint to add: registered as the brain
 * `local:<id>` on its usual loopback address. `present` says whether the app or its command is installed (file
 * names only: nothing is read or run).
 */
export interface FoundApp {
  id: string;
  api: LocalApi;
  url: string;
  name: string;
  present(): boolean;
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
/** a command on PATH (or one of the usual install folders a GUI app's short PATH leaves out) */
export function commandInstalled(name: string, extra: string[] = []): boolean {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extra];
  return dirs.some((d) => d && existsSync(join(d, exe(name))));
}
/** a macOS app bundle in /Applications or ~/Applications */
export function macAppInstalled(bundle: string): boolean {
  if (process.platform !== 'darwin') return false;
  return [join('/', 'Applications'), join(homedir(), 'Applications')].some((d) =>
    existsSync(join(d, bundle)),
  );
}

/** Ollama and LM Studio, found on their default loopback ports (never a network scan). */
export const FOUND_APPS: FoundApp[] = [
  {
    id: 'ollama',
    api: 'ollama',
    url: 'http://127.0.0.1:11434',
    name: 'Ollama',
    present: () =>
      commandInstalled('ollama', ['/usr/local/bin', '/opt/homebrew/bin']) || macAppInstalled('Ollama.app'),
  },
  {
    id: 'lmstudio',
    api: 'openai',
    url: 'http://127.0.0.1:1234/v1',
    name: 'LM Studio',
    present: () =>
      commandInstalled('lms', [join(homedir(), '.lmstudio', 'bin')]) || macAppInstalled('LM Studio.app'),
  },
];

/**
 * A found app's brain: "Ready" once its local API answers with at least one model; installed but not answering is
 * "not running", answering with no model is "needs a model", and neither app nor answer is "not installed".
 */
export class FoundLocalAdapter extends LocalModelAdapter {
  constructor(
    ep: LocalEndpoint,
    private readonly present: () => boolean,
    opts: ConstructorParameters<typeof LocalModelAdapter>[1] = {},
  ) {
    super(ep, opts);
  }
  override async detect(): Promise<ProviderStatus> {
    const name = this.endpoint.name;
    let count: number;
    try {
      count = (await this.models({ timeoutMs: PROBE_TIMEOUT_MS })).length;
    } catch {
      let installed = false;
      try {
        installed = this.present();
      } catch {
        installed = false;
      }
      if (!installed) return { installed: false, signedIn: false, hint: `${name} is not on this computer` };
      return {
        installed: true,
        signedIn: 'unknown',
        reachable: false,
        notReady: 'not_running',
        hint: `${name} is installed but not running`,
      };
    }
    if (count === 0)
      return { installed: true, signedIn: true, notReady: 'needs_model', hint: `${name} has no model yet` };
    return { installed: true, signedIn: true, version: `${count} model${count === 1 ? '' : 's'}` };
  }
}

export interface LocalModuleOptions {
  /** loopback addresses `GET /detect` probes (tests point these at stub servers) */
  candidates?: { api: LocalApi; url: string; name: string }[];
  /**
   * Local model apps registered as brains without an endpoint (default: none; the app's own module passes
   * `FOUND_APPS`). An app the owner added as an endpoint on the same address is not registered twice.
   */
  found?: FoundApp[] | (() => FoundApp[]);
  /** per-request idle timeout for the endpoints (tests shorten it) */
  timeoutMs?: number;
}

interface Row {
  id: string;
  name: string;
  api: LocalApi;
  base_url: string;
  origin: string;
  scope: 'loopback' | 'lan';
  tools: 'auto' | 'off';
  created_at: number;
}
const toEndpoint = (r: Row): LocalEndpoint => ({
  id: r.id,
  name: r.name,
  api: r.api,
  baseUrl: r.base_url,
  origin: r.origin,
  scope: r.scope,
  tools: r.tools,
});

/** Only the owner's own web/CLI session; members, agents (run bearer) and automation tokens are refused. */
function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return p;
}

/** Normalise and vet an owner-typed URL; an OpenAI-compatible base without a path gets `/v1`. */
export function normaliseUrl(api: LocalApi, raw: string) {
  const c = classifyLocalModelUrl(raw.trim());
  if (!c.ok) throw new HttpError(400, c.reason, 'bad_url');
  const base = api === 'openai' && c.baseUrl === c.origin ? `${c.origin}/v1` : c.baseUrl;
  return { ...c, baseUrl: base };
}

const apiSchema = z.enum(['ollama', 'openai']);
const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  api: apiSchema,
  url: z.string().trim().min(1).max(300),
  tools: z.enum(['auto', 'off']).default('auto'),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  tools: z.enum(['auto', 'off']).optional(),
});
const checkBody = z.object({ api: apiSchema, url: z.string().trim().min(1).max(300) });

export function createLocalModule(o: LocalModuleOptions = {}): PasaBotModule {
  return {
    id: 'local',
    migrations: join(here, '..', 'migrations'),
    register(app: ModuleHost) {
      const adapters = new Map<string, LocalModelAdapter>();
      // native session histories survive a restart (the orchestrator sends no reseed when it resumes a ref)
      const history: LocalHistoryStore = {
        get(ref) {
          const r = app.raw.prepare('SELECT history FROM local_session WHERE ref = ?').get(ref) as
            | { history: string }
            | undefined;
          if (!r) return undefined;
          try {
            const h = JSON.parse(r.history);
            return Array.isArray(h) ? (h as LocalMsg[]) : undefined;
          } catch {
            return undefined;
          }
        },
        set(ref, endpointId, h) {
          let msgs = h;
          let json = JSON.stringify(msgs);
          while (json.length > HISTORY_MAX_CHARS && msgs.length > 1) {
            const next = msgs.findIndex((m, i) => i > 0 && m.role === 'user');
            msgs = next > 0 ? msgs.slice(next) : msgs.slice(-1);
            json = JSON.stringify(msgs);
          }
          const now = Date.now();
          app.raw
            .prepare(
              'INSERT INTO local_session (ref, endpoint_id, history, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at',
            )
            .run(ref, endpointId, json, now);
          app.raw.prepare('DELETE FROM local_session WHERE updated_at < ?').run(now - HISTORY_IDLE_MS);
        },
      };
      const rows = () =>
        app.raw.prepare('SELECT * FROM local_endpoint ORDER BY created_at, id').all() as Row[];
      const row = (id: string) =>
        app.raw.prepare('SELECT * FROM local_endpoint WHERE id = ?').get(id) as Row | undefined;
      const mount = (r: Row) => {
        const ep = toEndpoint(r);
        const cur = adapters.get(r.id);
        if (cur) cur.update(ep);
        else {
          const a = new LocalModelAdapter(ep, {
            ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
            history,
          });
          adapters.set(r.id, a);
          app.providers.register(a);
        }
      };
      for (const r of rows()) mount(r);
      // the local model apps found on this computer, unless the owner added that same address as an endpoint
      const foundApps = (typeof o.found === 'function' ? o.found() : o.found) ?? [];
      const foundOn = new Map<string, FoundLocalAdapter>();
      const syncFound = () => {
        const taken = new Set(rows().map((r) => r.base_url));
        for (const f of foundApps) {
          const n = normaliseUrl(f.api, f.url);
          if (n.scope !== 'loopback') continue;
          const cur = foundOn.get(f.id);
          if (taken.has(n.baseUrl)) {
            if (cur) {
              foundOn.delete(f.id);
              app.providers.unregister(cur.id);
            }
          } else if (!cur) {
            const a = new FoundLocalAdapter(
              {
                id: f.id,
                name: f.name,
                api: f.api,
                baseUrl: n.baseUrl,
                origin: n.origin,
                scope: 'loopback',
                tools: 'auto',
              },
              f.present,
              { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), history },
            );
            foundOn.set(f.id, a);
            app.providers.register(a);
          }
        }
      };
      syncFound();

      const probe = async (ep: LocalEndpoint) => {
        const a = adapters.get(ep.id) ?? new LocalModelAdapter(ep);
        try {
          // the registered adapter's turn timeout (120 s) is not the probe's: Settings answers within 5 s
          return {
            reachable: true as const,
            models: await a.models({
              timeoutMs: Math.min(o.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
            }),
          };
        } catch (e) {
          return {
            reachable: false as const,
            models: [],
            error: isUnreachable(e) ? 'not answering' : (e as Error).message.slice(0, 200),
          };
        }
      };
      const dto = (r: Row) => ({
        id: r.id,
        providerId: `local:${r.id}`,
        name: r.name,
        api: r.api,
        url: r.base_url,
        scope: r.scope,
        tools: r.tools,
        ...(r.scope === 'lan' ? { warning: 'lan' as const } : {}),
      });

      app.http.route({
        method: 'GET',
        url: '/endpoints',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return { endpoints: rows().map(dto) };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/endpoints/:id/models',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const r = row(ctx.params.id!);
          if (!r) throw new HttpError(404, 'endpoint not found', 'not_found');
          return probe(toEndpoint(r));
        },
      });
      // the usual loopback ports, probed only when the owner opens the page (never a network scan)
      app.http.route({
        method: 'GET',
        url: '/detect',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          const known = new Set(rows().map((r) => r.base_url));
          const found = [];
          for (const c of o.candidates ?? DEFAULT_CANDIDATES) {
            const n = normaliseUrl(c.api, c.url);
            if (known.has(n.baseUrl)) continue;
            const p = await probe({
              id: 'probe',
              name: c.name,
              api: c.api,
              baseUrl: n.baseUrl,
              origin: n.origin,
              scope: n.scope,
              tools: 'auto',
            });
            if (p.reachable)
              found.push({ name: c.name, api: c.api, url: n.baseUrl, models: p.models.length });
          }
          return { found };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/check',
        auth: 'session',
        body: checkBody,
        handler: async (ctx) => {
          owner(ctx);
          const b = ctx.body as z.infer<typeof checkBody>;
          const n = normaliseUrl(b.api, b.url);
          const p = await probe({
            id: 'check',
            name: n.baseUrl,
            api: b.api,
            baseUrl: n.baseUrl,
            origin: n.origin,
            scope: n.scope,
            tools: 'auto',
          });
          return { url: n.baseUrl, scope: n.scope, ...(n.warning ? { warning: 'lan' } : {}), ...p };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/endpoints',
        auth: 'session',
        body: createBody,
        handler: (ctx) => {
          const p = owner(ctx);
          const b = ctx.body as z.infer<typeof createBody>;
          const n = normaliseUrl(b.api, b.url);
          if (rows().length >= MAX_ENDPOINTS)
            throw new HttpError(409, `at most ${MAX_ENDPOINTS} local model endpoints`, 'limit');
          if (rows().some((r) => r.base_url === n.baseUrl))
            throw new HttpError(409, 'this address is already added', 'duplicate');
          const now = Date.now();
          const id = ulid(now).toLowerCase();
          app.raw
            .prepare(
              `INSERT INTO local_endpoint (id, name, api, base_url, origin, scope, tools, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(id, b.name, b.api, n.baseUrl, n.origin, n.scope, b.tools, `user:${p.userId}`, now, now);
          const r = row(id)!;
          mount(r);
          syncFound();
          app.log.info('local model endpoint added', { id, scope: n.scope });
          return { endpoint: dto(r) };
        },
      });
      app.http.route({
        method: 'PATCH',
        url: '/endpoints/:id',
        auth: 'session',
        body: patchBody,
        handler: (ctx) => {
          owner(ctx);
          const r = row(ctx.params.id!);
          if (!r) throw new HttpError(404, 'endpoint not found', 'not_found');
          const b = ctx.body as z.infer<typeof patchBody>;
          app.raw
            .prepare('UPDATE local_endpoint SET name = ?, tools = ?, updated_at = ? WHERE id = ?')
            .run(b.name ?? r.name, b.tools ?? r.tools, Date.now(), r.id);
          const next = row(r.id)!;
          mount(next);
          return { endpoint: dto(next) };
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/endpoints/:id',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const r = row(ctx.params.id!);
          if (!r) throw new HttpError(404, 'endpoint not found', 'not_found');
          app.raw.prepare('DELETE FROM local_endpoint WHERE id = ?').run(r.id);
          app.raw.prepare('DELETE FROM local_session WHERE endpoint_id = ?').run(r.id);
          adapters.delete(r.id);
          app.providers.unregister(`local:${r.id}`);
          syncFound();
          return { ok: true };
        },
      });
    },
  };
}

// the app finds Ollama and LM Studio by itself; PASABOT_LOCAL_FIND=0 turns that off (hermetic e2e servers)
export default defineModule(
  createLocalModule({ found: () => (process.env.PASABOT_LOCAL_FIND === '0' ? [] : FOUND_APPS) }),
);
