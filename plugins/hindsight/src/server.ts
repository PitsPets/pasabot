/**
 * Hindsight plugin (W10): registers the `hindsight` MemoryBackend. The owner sets the server URL, bank prefix and
 * (optionally) the name of a vault secret holding the API key, then picks "hindsight" in Memory settings.
 * Outbound calls go through safe-net with the configured host allowlisted (Hindsight usually lives on the LAN).
 */
import { type AuthedCtx, defineModule, HttpError, type MemoryBackend } from '@pasabot/core';
import { z } from 'zod';
import { HindsightBackend } from './backend.js';

interface Config {
  url: string;
  bankPrefix: string;
  /** name of a secret in scope `module:hindsight` */
  apiKeySecret: string | null;
}
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** An API key may only travel in clear text to this machine; anywhere else it needs https. */
export const plainHttpWithKey = (c: { url: string; apiKeySecret: string | null }) => {
  const u = new URL(c.url);
  return c.apiKeySecret !== null && u.protocol === 'http:' && !LOOPBACK.has(u.hostname);
};
const configIn = z
  .object({
    url: z.url({ protocol: /^https?$/ }).max(500),
    bankPrefix: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .default('pasabot'),
    apiKeySecret: z.string().min(1).max(100).nullable().default(null),
  })
  .refine((c) => !plainHttpWithKey(c), {
    message: 'an API key needs an https URL (plain http is allowed only to this machine)',
    path: ['url'],
  });

function ownerOnly(ctx: AuthedCtx<unknown>) {
  if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
    throw new HttpError(403, 'only the owner configures Hindsight', 'forbidden');
}

export default defineModule({
  id: 'hindsight',
  register(app) {
    let cached: { key: string; backend: HindsightBackend } | null = null;
    const current = (): HindsightBackend => {
      const c = app.config.get<Config | null>('config', null);
      if (!c) throw new Error('Hindsight is not configured yet (Settings → Memory)');
      const key = JSON.stringify(c);
      if (cached?.key !== key) {
        const host = new URL(c.url).hostname;
        cached = {
          key,
          backend: new HindsightBackend({
            url: c.url,
            bankPrefix: c.bankPrefix,
            fetch: (u, init) => app.net.fetch(u, { ...init, allowHosts: [host] }),
            apiKey: async () => {
              if (!c.apiKeySecret) return undefined;
              const meta = (await app.vault.list('module:hindsight')).find((m) => m.name === c.apiKeySecret);
              if (!meta) throw new Error(`vault secret "${c.apiKeySecret}" not found`);
              return app.vault.get(meta, { actor: 'module:hindsight', purpose: 'hindsight api key' });
            },
          }),
        };
      }
      return cached.backend;
    };
    // a thin forwarder, so a config change takes effect on the next call without re-registering
    const backend: MemoryBackend = {
      id: 'hindsight',
      remember: async (m) => current().remember(m),
      search: async (q) => current().search(q),
      forget: async (id) => current().forget(id),
      list: async (f) => current().list(f),
    };
    app.memory.register(backend);

    app.http.route({
      method: 'GET',
      url: '/config',
      auth: 'session',
      handler: (ctx) => {
        ownerOnly(ctx);
        return { config: app.config.get<Config | null>('config', null) };
      },
    });
    app.http.route({
      method: 'PUT',
      url: '/config',
      auth: 'session',
      body: configIn,
      handler: (ctx) => {
        ownerOnly(ctx);
        app.config.set('config', ctx.body);
        return { config: ctx.body };
      },
    });
  },
});
