/**
 * W22 templates module: the template catalogue (built-ins, a folder on the server, a static index), drafts from a
 * plain request, template bundles (publish = export, import), importers for other products' agent files, and the
 * onboarding free starter (consent → per-user OpenCode install → a first agent on a currently free model). Agents
 * are created by the owner's web session through the core agents API after review; this module only builds drafts,
 * installs the CLI with consent and keeps the free-tier gate (free-tier.ts) in front of the OpenCode adapter.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  type ModuleHost,
  type ProviderAdapter,
} from '@pasabot/core';
import type { AgentDTO, QueueItemDTO, RunDTO } from '@pasabot/protocol';
import { OpenCodeProvider } from '@pasabot/provider-opencode';
import { z } from 'zod';
import { BUSY_RE, busyMessage, FreeTierGate, RATE_LIMITED } from './free-tier.js';
import { InstallError, type Installer, type InstallSource, ReleaseInstaller } from './install/installer.js';
import {
  builtinTemplates,
  draftFromPrompt,
  exportBundle,
  importFile,
  parseTemplate,
  readTemplateFolder,
  type Template,
  TemplateError,
  templateFromAgent,
} from './templates.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG = join(here, '..', '..', '..', 'catalog', 'templates');

export const freeModelsSchema = z.object({
  checkedAt: z.string(),
  source: z.string(),
  provider: z.literal('opencode'),
  loginRequired: z.union([z.boolean(), z.literal('unverified')]),
  note: z.string().optional(),
  models: z.array(
    z.object({ id: z.string(), name: z.string(), free: z.boolean(), note: z.string().optional() }),
  ),
});
export type FreeModels = z.infer<typeof freeModelsSchema>;

export interface TemplatesModuleOptions {
  /** catalog/templates (built-in templates, free-models.json, opencode-install.json) */
  catalog?: string;
  /** where the OpenCode CLI is installed; default `$PASABOT_TOOLS_BIN` else `~/.local/bin` (the user's own bin dir) */
  binDir?: string;
  /** tests: a stub installer instead of the GitHub release installer */
  installer?: (app: ModuleHost, binDir: string) => Installer;
  /** the adapter used once the CLI is installed (default: OpenCode with the installed binary) */
  makeOpenCode?: (binPath: string) => ProviderAdapter;
  now?: () => number;
  cooldownMs?: number;
  /** consecutive auth / not-found failures before a free model is marked broken (default 3) */
  brokenAfter?: number;
}

function ownerOnly(ctx: AuthedCtx<unknown>): string {
  if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
    throw new HttpError(403, 'only the owner manages templates', 'forbidden');
  return ctx.principal.userId;
}
const asHttp = (e: unknown): never => {
  if (e instanceof TemplateError)
    throw new HttpError(e.code === 'not_found' ? 404 : e.code === 'exists' ? 409 : 400, e.message, e.code);
  if (e instanceof InstallError)
    throw new HttpError(e.code === 'no_consent' ? 400 : e.code === 'stopped' ? 409 : 502, e.message, e.code);
  throw e;
};
async function guard<T>(f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    return asHttp(e);
  }
}

const installIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal('index'), url: z.string().url().max(2000), id: z.string().min(1).max(40) }),
  z.object({
    kind: z.literal('file'),
    fileName: z.string().min(1).max(200),
    content: z.string().max(256_000),
  }),
]);

/** where the free starter's OpenCode goes: a per-user folder PasaBot's brain search covers (core cli-path) */
export function defaultBinDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  if (platform === 'win32')
    return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'PasaBot', 'bin');
  return join(home, '.local', 'bin');
}

export function createTemplatesModule(opts: TemplatesModuleOptions = {}) {
  return defineModule({
    id: 'templates',
    migrations: join(here, '..', 'migrations'),
    register(app: ModuleHost) {
      const catalog = opts.catalog ?? DEFAULT_CATALOG;
      // per user, no admin: ~/.local/bin; Windows %LOCALAPPDATA%\PasaBot\bin (PasaBot searches both for brains)
      const binDir = opts.binDir ?? process.env.PASABOT_TOOLS_BIN ?? defaultBinDir();
      const now = opts.now ?? Date.now;
      const state = {
        get: (k: string) =>
          (
            app.raw.prepare('SELECT value FROM templates_starter_state WHERE key = ?').get(k) as
              | { value: string }
              | undefined
          )?.value,
        set: (k: string, v: string) =>
          app.raw
            .prepare(
              'INSERT INTO templates_starter_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            )
            .run(k, v),
      };
      const freeModels = (): FreeModels | null => {
        try {
          return freeModelsSchema.parse(JSON.parse(readFileSync(join(catalog, 'free-models.json'), 'utf8')));
        } catch {
          return null;
        }
      };
      const freeIds = () => new Set((freeModels()?.models ?? []).filter((m) => m.free).map((m) => m.id));
      const starterModels = () =>
        new Set(
          (app.raw.prepare('SELECT model FROM templates_starter_agent').all() as { model: string }[]).map(
            (r) => r.model,
          ),
        );
      /**
       * A broken mark holds the free list's `checkedAt` it was made under: a refreshed list (new checkedAt) clears it,
       * as do a later successful turn on that model and the owner's re-check.
       */
      const brokenReason = (model: string): string | undefined => {
        const raw = state.get(`broken:${model}`);
        if (!raw) return undefined;
        try {
          const v = JSON.parse(raw) as { reason?: unknown; checkedAt?: unknown };
          if (typeof v.reason === 'string' && v.checkedAt === (freeModels()?.checkedAt ?? null))
            return v.reason;
        } catch {}
        return undefined;
      };
      const clearBroken = (model: string) =>
        app.raw.prepare('DELETE FROM templates_starter_state WHERE key = ?').run(`broken:${model}`);
      /** the agent still exists and still runs on that free model through OpenCode */
      const stillOn = (a: AgentDTO | null, model: string) =>
        !!a && !a.archivedAt && a.providerId === 'opencode' && a.model === model;
      const dropStarter = (agentId: string) =>
        app.raw.prepare('DELETE FROM templates_starter_agent WHERE agent_id = ?').run(agentId);
      const starterRow = (agentId: string) =>
        app.raw.prepare('SELECT model FROM templates_starter_agent WHERE agent_id = ?').get(agentId) as
          | { model: string }
          | undefined;
      /** a starter agent that moved to another brain, or was deleted, leaves the free starter's books */
      const pruneIfMoved = async (agentId: string) => {
        const row = starterRow(agentId);
        if (!row) return;
        if (!stillOn(await app.agents.get(agentId), row.model)) dropStarter(agentId);
      };

      // ---------- free-tier gate in front of the OpenCode adapter ----------
      const makeOpenCode = opts.makeOpenCode ?? ((bin: string) => new OpenCodeProvider({ command: [bin] }));
      const existing = app.providers.get('opencode');
      const gate = new FreeTierGate({
        inner: existing ?? null,
        // the free list, plus any model a starter agent already runs on (so a model that stops being free keeps
        // the one-at-a-time rule and its notice)
        isFree: (m) => !!m && (freeIds().has(m) || starterModels().has(m)),
        onBroken: (model, reason) => {
          if (brokenReason(model)) return;
          state.set(
            `broken:${model}`,
            JSON.stringify({ reason, checkedAt: freeModels()?.checkedAt ?? null }),
          );
          void app.notifier
            .notify({
              level: 'warn',
              title: 'The free model stopped working',
              body: `${model} ${reason}. Pick another brain for your agent.`,
              msg: {
                title: { key: 'templates:notice.title' },
                body: {
                  key:
                    reason === 'needs a key or login now'
                      ? 'templates:notice.needs_key'
                      : 'templates:notice.unavailable',
                  params: { name: model },
                },
              },
              href: '/starter',
            })
            .catch(() => {});
        },
        onWorking: (model) => {
          if (state.get(`broken:${model}`)) clearBroken(model);
        },
        now,
        ...(opts.cooldownMs ? { cooldownMs: opts.cooldownMs } : {}),
        ...(opts.brokenAfter ? { brokenAfter: opts.brokenAfter } : {}),
      });
      const cli = (): { binPath: string; version: string } | null => {
        const v = state.get('cli');
        return v ? (JSON.parse(v) as { binPath: string; version: string }) : null;
      };
      const switchToBinary = (binPath: string) => {
        gate.setInner(makeOpenCode(binPath));
        if (app.providers.get('opencode') !== gate) {
          app.providers.unregister('opencode');
          app.providers.register(gate);
        }
      };
      if (existing) {
        app.providers.unregister('opencode');
        app.providers.register(gate);
      }

      // ---------- free-model routines: skip and report, never stack (W22) ----------
      // each agent as configured (the queue gate is synchronous, so it reads this map, kept fresh from the agents
      // port: at boot and on every agent change). Never from a run: a run may have used a fallback or an override.
      const brains = new Map<string, AgentDTO>();
      const remember = (a: AgentDTO) => brains.set(a.id, a);
      const refreshBrains = async () => {
        for (const a of await app.agents.list()) remember(a);
      };
      refreshBrains().catch((e) => app.log.warn('free starter: agent list failed', { error: String(e) }));
      /**
       * Would this item run on the free model right now? Asked of the provider policy, exactly as the orchestrator
       * asks it a moment later at dispatch: with a fallback chain (provider-ops), a free model that is limited is
       * passed over for the next usable brain, so only a fire with nothing else to run on is refused here.
       */
      const onFreeModel = (agentId: string, payload: unknown) => {
        const agent = brains.get(agentId);
        if (!agent) return false;
        const override = (payload as { providerOverride?: { providerId?: unknown; model?: unknown } } | null)
          ?.providerOverride;
        let pick: { providerId: string; model?: string | undefined } | null;
        if (override && typeof override.providerId === 'string') {
          pick = {
            providerId: override.providerId,
            model:
              typeof override.model === 'string'
                ? override.model
                : override.providerId === agent.providerId
                  ? (agent.model ?? undefined)
                  : undefined,
          };
        } else {
          try {
            pick = app.providers.policy().choose(agent);
          } catch (e) {
            app.log.warn('free starter: policy choice failed', { error: String(e) });
            pick = null;
          }
          pick ??= { providerId: agent.providerId, model: agent.model ?? undefined };
          pick = { ...pick, model: pick.model ?? agent.model ?? undefined };
        }
        return pick.providerId === 'opencode' && !!pick.model && gate.isFreeModel(pick.model);
      };
      /** routine items the free model refused mid-turn (held by the core): released at once, then refused here */
      const refusedMidTurn = new Map<string, string>();
      let reportedWindow = '';
      const reportSkip = (window: string, why: string) => {
        if (reportedWindow === window) return; // one report per busy window, however many fires it skipped
        reportedWindow = window;
        void app.notifier
          .notify({
            level: 'warn',
            category: 'alert',
            tag: 'templates:free-rate-limit',
            title: 'A routine was skipped: the free model is rate limited',
            body: `${why} Routines on the free model skip their runs until then; the next fire runs as usual.`,
            msg: {
              title: { key: 'templates:server.skippedTitle' },
              body: { key: 'templates:server.skippedBody' },
            },
            href: '/routines',
          })
          .catch(() => {});
      };
      app.queue.addGate((item) => {
        if (item.kind !== 'routine') return null;
        const midTurn = refusedMidTurn.get(item.id);
        refusedMidTurn.delete(item.id);
        const until = gate.blocked();
        if (!midTurn && !(until && onFreeModel(item.agentId, item.payload))) return null;
        const why = until ? busyMessage(until) : midTurn!;
        reportSkip(until ? `until:${until}` : `item:${item.id}`, why);
        return { refuse: `${RATE_LIMITED}: ${why}` };
      });
      // a routine item the core held because the free model answered busy (only this gate writes that message):
      // release it at once so the queue gate above refuses it, and the fire ends `skipped` instead of waiting
      app.bus.subscribe((ev) => {
        if (ev.type === 'run.started' && ev.topic.startsWith('agent:')) {
          // the run's own brain may be a fallback or an override: only an agent this map has not seen yet (made by a
          // path that publishes no agent.updated) is looked up, and then as configured
          const run = ev.data as RunDTO;
          if (run?.agentId && !brains.has(run.agentId))
            app.agents
              .get(run.agentId)
              .then((a) => {
                if (a && !brains.has(a.id)) remember(a);
              })
              .catch((e) => app.log.warn('free starter: agent lookup failed', { error: String(e) }));
          return;
        }
        if (ev.type !== 'queue.changed' || !ev.topic.startsWith('agent:')) return;
        const items = (ev.data as { items?: QueueItemDTO[] } | null)?.items ?? [];
        for (const item of items) {
          if (item.kind !== 'routine' || item.state !== 'held' || refusedMidTurn.has(item.id)) continue;
          if (!BUSY_RE.test(item.error ?? '')) continue;
          const why = (item.error ?? '').replace(/^[a-z_]+: /, '');
          refusedMidTurn.set(item.id, why);
          queueMicrotask(() => {
            try {
              if (app.raw.open) app.queue.hold(item.id, Date.now(), item.error ?? undefined);
            } catch (e) {
              refusedMidTurn.delete(item.id);
              app.log.warn('free starter: routine skip failed', { error: String(e) });
            }
          });
        }
      });
      const installed = cli();
      if (installed && existsSync(installed.binPath)) switchToBinary(installed.binPath);

      // installs in flight: the global stop (W31) aborts them and names them in its report
      const installs = new Set<AbortController>();
      app.killSwitch.onStop(() => {
        const out = [...installs].map(() => ({
          kind: 'install',
          id: 'templates.opencode',
          label: 'OpenCode install (free starter)',
          outcome: 'cancelled' as const,
        }));
        for (const ac of installs) ac.abort();
        return out;
      });
      const installer = (): Installer => {
        if (opts.installer) return opts.installer(app, binDir);
        const source = JSON.parse(
          readFileSync(join(catalog, 'opencode-install.json'), 'utf8'),
        ) as InstallSource;
        return new ReleaseInstaller({ source, binDir, fetch: (u, i) => app.net.fetch(u, i) });
      };

      // ---------- catalogue ----------
      const installedTemplates = () =>
        (
          app.raw
            .prepare('SELECT id, source, version, manifest FROM templates_installed ORDER BY id')
            .all() as {
            id: string;
            source: string;
            version: string;
            manifest: string;
          }[]
        ).map((r) => ({ ...parseTemplate(JSON.parse(r.manifest)), source: r.source }));
      const all = (): (Template & { source: string })[] => {
        const mine = installedTemplates();
        const ids = new Set(mine.map((t) => t.id));
        return [
          ...builtinTemplates(catalog)
            .filter((t) => !ids.has(t.id))
            .map((t) => ({ ...t, source: 'builtin' })),
          ...mine,
        ];
      };
      const store = (t: Template, source: string) => {
        if (all().some((x) => x.id === t.id && x.source === 'builtin'))
          throw new TemplateError('exists', `a built-in template is already called ${t.id}`);
        app.raw
          .prepare(
            'INSERT INTO templates_installed (id, source, version, manifest) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source = excluded.source, version = excluded.version, manifest = excluded.manifest',
          )
          .run(t.id, source, t.version, JSON.stringify(t));
        return t;
      };

      app.http.route({
        method: 'GET',
        url: '/catalog',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          return { templates: all() };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/catalog',
        auth: 'session',
        body: installIn,
        bodyLimit: 300_000,
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const b = ctx.body;
            if (b.kind === 'folder') {
              if (!isAbsolute(b.path)) throw new TemplateError('invalid', 'give the full path of the folder');
              return { template: store(readTemplateFolder(b.path), `local:${b.path}`) };
            }
            if (b.kind === 'file') {
              const { template, format } = importFile(b.fileName, b.content);
              return { template: store(template, `import:${b.fileName}`), format };
            }
            // a static index: { templates: Template[] } as JSON over safe-net
            let raw: unknown;
            try {
              const r = await app.net.fetch(b.url);
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const text = await r.text();
              if (text.length > 1_000_000) throw new Error('index too large');
              raw = JSON.parse(text);
            } catch (e) {
              throw new TemplateError('invalid', `could not read the index: ${(e as Error).message}`);
            }
            const list = z.object({ templates: z.array(z.unknown()).max(500) }).safeParse(raw);
            if (!list.success) throw new TemplateError('invalid', 'the index has no templates list');
            const hit = list.data.templates
              .map((t) => templateSafe(t))
              .find((t): t is Template => t?.id === b.id);
            if (!hit) throw new TemplateError('not_found', `the index has no template ${b.id}`);
            return { template: store(hit, `index:${b.url}`) };
          }),
      });
      app.http.route({
        method: 'DELETE',
        url: '/catalog/:id',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          const r = app.raw.prepare('DELETE FROM templates_installed WHERE id = ?').run(ctx.params.id!);
          if (!r.changes) throw new HttpError(404, 'no such installed template', 'not_found');
          return { ok: true };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/catalog/:id/export',
        auth: 'session',
        handler: (ctx) =>
          guard(() => {
            ownerOnly(ctx);
            const t = all().find((x) => x.id === ctx.params.id);
            if (!t) throw new TemplateError('not_found', 'no such template');
            const { source: _s, ...tpl } = t;
            return exportBundle(tpl);
          }),
      });
      // publish = export: an agent as a template bundle (name, instructions, brain hint; never secrets or trust)
      app.http.route({
        method: 'GET',
        url: '/agents/:id/export',
        auth: 'session',
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const a = await app.agents.get(ctx.params.id!);
            if (!a) throw new TemplateError('not_found', 'no such agent');
            // the built-in team builder runs on PasaBot's own internal prompt: it is not a template
            if (a.builtIn)
              throw new HttpError(
                409,
                'the team builder is part of PasaBot and is not exported',
                'builtin_agent',
              );
            return exportBundle(templateFromAgent(a));
          }),
      });

      // ---------- drafts ----------
      app.http.route({
        method: 'POST',
        url: '/draft',
        auth: 'session',
        body: z.object({ prompt: z.string().min(1).max(2000) }),
        handler: (ctx) =>
          guard(() => {
            ownerOnly(ctx);
            return { draft: draftFromPrompt(ctx.body.prompt, all()) };
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/import',
        auth: 'session',
        body: z.object({ fileName: z.string().min(1).max(200), content: z.string().max(256_000) }),
        bodyLimit: 300_000,
        handler: (ctx) =>
          guard(() => {
            ownerOnly(ctx);
            const { template, format } = importFile(ctx.body.fileName, ctx.body.content);
            return {
              format,
              template,
              draft: {
                name: template.name,
                instructions: template.instructions,
                templateId: template.id,
                ...(template.model ? { model: template.model } : {}),
              },
            };
          }),
      });

      // ---------- free starter ----------
      app.bus.subscribe((ev) => {
        if (ev.type !== 'agent.updated') return;
        const upd = ev.data as AgentDTO | null;
        if (upd?.id && typeof upd.providerId === 'string') remember(upd);
        const id = upd?.id as unknown;
        if (typeof id === 'string' && starterRow(id))
          pruneIfMoved(id).catch((e) => app.log.warn('free starter: prune failed', { error: String(e) }));
      });
      const notice = async () => {
        const free = freeIds();
        const list = freeModels();
        const rows = app.raw
          .prepare('SELECT agent_id, model FROM templates_starter_agent ORDER BY created_at')
          .all() as { agent_id: string; model: string }[];
        for (const { agent_id: agentId, model } of rows) {
          // only agents that still run on that model count (and a stale row is dropped)
          if (!stillOn(await app.agents.get(agentId), model)) {
            dropStarter(agentId);
            continue;
          }
          // the owner reads the model's name from the list (a model dropped from the list keeps its id)
          const name = list?.models.find((m) => m.id === model)?.name ?? model;
          const broken = brokenReason(model);
          if (broken)
            return {
              model,
              name,
              kind: broken === 'needs a key or login now' ? ('needs_key' as const) : ('unavailable' as const),
              reason: broken,
              agentId,
            };
          if (list && !free.has(model)) {
            // the "no longer free" notice also reaches the owner once as a notification (per model and list date)
            const key = `notified:not_free:${model}:${list.checkedAt}`;
            if (!state.get(key)) {
              state.set(key, String(now()));
              void app.notifier
                .notify({
                  level: 'warn',
                  category: 'alert',
                  title: 'The free model is no longer free',
                  body: `${name} is no longer free. Pick another brain for your agent.`,
                  msg: {
                    title: { key: 'templates:notice.notFreeTitle' },
                    body: { key: 'templates:notice.not_free', params: { name } },
                  },
                  href: '/starter',
                })
                .catch(() => {});
            }
            return { model, name, kind: 'not_free' as const, reason: 'is no longer free', agentId };
          }
        }
        return null;
      };
      // a shipped list that dropped a starter model is noticed at boot, not only when the owner opens a page
      setTimeout(() => {
        if (app.raw.open)
          notice().catch((e) => app.log.warn('free starter: notice check failed', { error: String(e) }));
      }, 0);
      app.http.route({
        method: 'GET',
        url: '/starter',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const list = freeModels();
          const usable = (list?.models ?? []).filter((m) => m.free && !brokenReason(m.id));
          let consent: { what: string; where: string; from: string } | null = null;
          try {
            consent = installer().describe();
          } catch {
            consent = null;
          }
          return {
            available: usable.length > 0 && consent !== null,
            checkedAt: list?.checkedAt ?? null,
            loginRequired: list?.loginRequired ?? 'unverified',
            models: usable.map((m) => ({ id: m.id, name: m.name })),
            consent,
            installed: cli(),
            busyUntil: gate.blocked() || null,
            notice: await notice(),
          };
        },
      });
      // the owner's "check again": forget a broken mark and its failure count; the next turn decides afresh
      app.http.route({
        method: 'POST',
        url: '/starter/recheck',
        auth: 'session',
        body: z.object({ model: z.string().min(1).max(100) }),
        handler: async (ctx) => {
          ownerOnly(ctx);
          clearBroken(ctx.body.model);
          gate.resetFailures(ctx.body.model);
          return { ok: true, notice: await notice() };
        },
      });
      /** the owner agreed: install (checksum-verified by the installer), record the version, switch to the binary */
      const installOpenCode = async (consent: boolean) => {
        if (consent !== true) throw new InstallError('no_consent', 'the owner has not agreed to the install');
        // work outside the queue (W31): refused while stopped, and a stop aborts it in flight
        if (app.killSwitch.isStopped())
          throw new InstallError('stopped', 'everything is stopped; resume before installing');
        const ac = new AbortController();
        installs.add(ac);
        let r: Awaited<ReturnType<Installer['install']>>;
        try {
          r = await installer().install({ consent: true, signal: ac.signal });
        } finally {
          installs.delete(ac);
        }
        state.set('cli', JSON.stringify(r));
        switchToBinary(r.binPath);
        app.log.info('OpenCode installed', { version: r.version });
        return r;
      };
      app.http.route({
        method: 'POST',
        url: '/starter/install',
        auth: 'session',
        body: z.object({ consent: z.boolean() }),
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            return { installed: await installOpenCode(ctx.body.consent) };
          }),
      });

      // ---------- `pasabot providers install <id>` (the CLI verb is W22's): the brains this server can install ----------
      const installable = () => {
        let d: { what: string; where: string; from: string } | null = null;
        try {
          d = installer().describe();
        } catch {
          d = null;
        }
        return d ? [{ id: 'opencode', ...d, checksum: 'sha256' as const, installed: cli() }] : [];
      };
      app.http.route({
        method: 'GET',
        url: '/providers/installable',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          return { providers: installable() };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/providers/:id/install',
        auth: 'session',
        body: z.object({ consent: z.boolean() }),
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const id = ctx.params.id!.slice(0, 40);
            if (!installable().some((p) => p.id === id))
              throw new HttpError(
                404,
                `no installer for "${id}" (installable: ${installable()
                  .map((p) => p.id)
                  .join(', ')})`,
                'not_found',
              );
            return { installed: await installOpenCode(ctx.body.consent) };
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/starter/agents',
        auth: 'session',
        body: z.object({ agentId: z.string().min(1).max(40), model: z.string().min(1).max(100) }),
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const a = await app.agents.get(ctx.body.agentId);
            if (!a) throw new TemplateError('not_found', 'no such agent');
            if (!freeIds().has(ctx.body.model))
              throw new TemplateError('invalid', 'that model is not on the free list');
            app.raw
              .prepare(
                'INSERT INTO templates_starter_agent (agent_id, model, created_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET model = excluded.model',
              )
              .run(a.id, ctx.body.model, now());
            return { ok: true };
          }),
      });
    },
  });
}

function templateSafe(t: unknown): Template | null {
  try {
    return parseTemplate(t);
  } catch {
    return null;
  }
}

export default createTemplatesModule();
