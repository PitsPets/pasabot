/** The reference module: fills every server slot of the Module SDK once (see README.md). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineModule, httpResponse, ulid } from '@pasabot/core';
import { z } from 'zod';

// New domain events are added by augmentation, never by editing @pasabot/protocol.
declare module '@pasabot/protocol' {
  interface EventMap {
    'example.pinged': { from: string; at: number };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const noteBody = z.object({ text: z.string().min(1).max(500) });

export default defineModule({
  id: '_example',
  migrations: join(here, '..', 'migrations'),
  async register(app) {
    // one route per auth kind
    for (const kind of ['session', 'automation', 'run'] as const) {
      app.http.route({
        method: 'GET',
        url: `/whoami/${kind}`,
        auth: kind,
        handler: (ctx) => ({ kind: ctx.principal.kind }),
      });
    }

    // the module's own table
    app.http.route({
      method: 'POST',
      url: '/notes',
      auth: 'session',
      body: noteBody,
      handler: async (ctx) => {
        const row = {
          id: ulid(),
          text: ctx.body.text,
          created_by: ctx.principal.kind === 'session' ? ctx.principal.userId : 'unknown',
          created_at: Date.now(),
        };
        await app.db.insertInto('_example_note').values(row).execute();
        return httpResponse(201, { id: row.id });
      },
    });
    app.http.route({
      method: 'GET',
      url: '/notes',
      auth: ['session', 'automation'],
      handler: async () => ({
        notes: await app.db.selectFrom('_example_note').selectAll().orderBy('id').execute(),
      }),
    });

    // an event, published on the module's topic
    app.http.route({
      method: 'POST',
      url: '/ping',
      auth: 'session',
      handler: () => {
        const seq = app.bus.publish('module:_example', 'example.pinged', { from: 'http', at: Date.now() });
        return { seq };
      },
    });

    // a public hook: rate limit and body limit are mandatory
    app.publicHttp.route({
      method: 'POST',
      url: '/ping',
      rateLimit: { max: 3, windowMs: 60_000 },
      bodyLimit: 1024,
      handler: (ctx) => httpResponse(202, { received: ctx.rawBody.length }),
    });

    // a file on the separate sites origin
    await app.sitesOrigin.put(
      'hello.html',
      '<!doctype html><h1>hello from _example</h1>',
      'text/html; charset=utf-8',
    );

    // a tool agents can call
    app.tools.add({
      name: 'example_echo',
      title: 'Echo',
      description: 'Returns the text it was given.',
      input: z.object({ text: z.string() }),
      output: z.object({ echo: z.string() }),
      tier: 0,
      handler: async ({ text }) => ({ echo: text }),
    });

    // a message block kind (the web renderer uses the same key)
    app.blocks.register('_example.note', z.object({ text: z.string() }));
  },
});
