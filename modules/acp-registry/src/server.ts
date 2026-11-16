/**
 * ACP agent registry module (W2): search a configurable registry index, install / remove ACP agents, show their
 * status. Each installed agent becomes a provider `acp:<id>` that agents can pick like any other brain. Owner only:
 * installing an agent puts a program on this machine that agents will run.
 */
import { type AuthedCtx, defineModule, HttpError, type PasaBotModule } from '@pasabot/core';
import { z } from 'zod';
import { AcpRegistry, agentIdSchema, RegistryError, validSource } from './registry.js';

export { AcpRegistry, indexSchema, RegistryError } from './registry.js';

export interface AcpRegistryOptions {
  /** command that runs npm (tests use a stand-in) */
  npmCommand?: string[];
}

function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
}
async function wrap<T>(f: () => Promise<T> | T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RegistryError) throw new HttpError(e.status, e.message, e.code);
    throw e;
  }
}

export function createAcpRegistryModule(
  o: AcpRegistryOptions = {},
): PasaBotModule & { registry(): AcpRegistry } {
  let reg: AcpRegistry | null = null;
  return {
    id: 'acp-registry',
    registry() {
      if (!reg) throw new Error('acp-registry not registered yet');
      return reg;
    },
    register(app) {
      const r = new AcpRegistry({
        dataDir: app.dataDir,
        fetch: (url) => app.net.fetch(url, { headers: { accept: 'application/json' } }),
        ...(o.npmCommand ? { npmCommand: o.npmCommand } : {}),
        register: (p) => app.providers.register(p),
        unregister: (id) => app.providers.unregister(id),
        hasProvider: (id) => !!app.providers.get(id),
      });
      reg = r;
      r.load((msg, meta) => app.log.warn(msg, meta as Record<string, unknown>));
      const source = () => app.config.get<string>('indexSource', process.env.PASABOT_ACP_INDEX ?? '');

      app.http.route({
        method: 'GET',
        url: '/settings',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return { indexSource: source() };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/settings',
        auth: 'session',
        body: z.object({ indexSource: z.string().trim().max(1000) }),
        handler: (ctx) => {
          owner(ctx);
          const s = ctx.body.indexSource;
          if (s && !validSource(s))
            throw new HttpError(
              400,
              'the index must be an absolute file path or an https URL',
              'bad_index_source',
            );
          app.config.set('indexSource', s);
          return { indexSource: s };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/index',
        auth: 'session',
        handler: (ctx) =>
          wrap(async () => {
            owner(ctx);
            const q = typeof ctx.query.q === 'string' ? ctx.query.q.slice(0, 200) : '';
            return { agents: await r.search(source(), q) };
          }),
      });
      app.http.route({
        method: 'GET',
        url: '/installed',
        auth: 'session',
        handler: (ctx) =>
          wrap(async () => {
            owner(ctx);
            const agents = r.list();
            const status = await Promise.all(agents.map((a) => r.status(a.id)));
            return { agents: agents.map((a, i) => ({ ...a, providerId: `acp:${a.id}`, status: status[i] })) };
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/installed',
        auth: 'session',
        body: z.object({ id: agentIdSchema }),
        handler: (ctx) =>
          wrap(async () => {
            owner(ctx);
            const a = await r.install(source(), ctx.body.id);
            app.log.info('acp agent installed', { id: a.id, version: a.version });
            return { agent: { ...a, providerId: `acp:${a.id}`, status: await r.status(a.id) } };
          }),
      });
      app.http.route({
        method: 'DELETE',
        url: '/installed/:id',
        auth: 'session',
        handler: (ctx) =>
          wrap(async () => {
            owner(ctx);
            const id = ctx.params.id ?? '';
            if (!agentIdSchema.safeParse(id).success)
              throw new HttpError(404, 'agent not installed', 'not_installed');
            const usedBy = (await app.agents.list())
              .filter(
                (a) =>
                  !a.archivedAt &&
                  (a.providerId === `acp:${id}` || a.fallback.some((f) => f.providerId === `acp:${id}`)),
              )
              .map((a) => a.name);
            r.remove(id, usedBy);
            app.log.info('acp agent removed', { id });
            return { ok: true };
          }),
      });
    },
  };
}

export default defineModule(createAcpRegistryModule());
