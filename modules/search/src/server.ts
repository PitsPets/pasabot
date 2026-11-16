/**
 * W7 search: message history search (FTS5 through the core ChatPort, membership-filtered) for people
 * (`GET /api/m/search/messages`) and agents (`search_messages`, tier 0: an agent finds only chats it is in, narrowed to what the run's sender, or for work
 * from another agent the sender that started the chain, can read).
 */
import { defineModule, HttpError } from '@pasabot/core';
import { z } from 'zod';

export function createSearchModule() {
  return defineModule({
    id: 'search',
    register(app) {
      app.http.route({
        method: 'GET',
        url: '/messages',
        auth: 'session',
        handler: (ctx) => {
          const p = ctx.principal;
          if (p.kind !== 'session') throw new HttpError(401, 'session required', 'unauthorized');
          const q = String(ctx.query.q ?? '').slice(0, 200);
          const chatId = typeof ctx.query.chatId === 'string' ? ctx.query.chatId : undefined;
          const limit = Math.min(Math.max(Number(ctx.query.limit ?? 30) || 30, 1), 100);
          if (!q.trim()) return { hits: [] };
          const hits = app.chats.search({
            text: q,
            reader: { kind: 'user', id: p.userId, userKind: p.userKind },
            ...(chatId ? { chatId } : {}),
            limit,
          });
          return { hits: hits.map((h) => ({ ...h, snippet: app.redact(h.snippet) })) };
        },
      });

      app.tools.add({
        name: 'search_messages',
        title: 'Search messages',
        description:
          'Searches the message history of the chats you are a member of that the person who started this run can also read (words, newest first). Use it to find what was said earlier.',
        input: z.object({
          query: z.string().min(1).max(200),
          chatId: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        tier: 0,
        handler: async (input, ctx) => {
          const search = (o: { chatId?: string; limit: number }) =>
            app.chats.search({
              text: input.query,
              reader: { kind: 'agent', id: ctx.agent.id },
              ...(o.chatId ? { chatId: o.chatId } : {}),
              limit: o.limit,
            });
          const limit = input.limit ?? 10;
          const who = ctx.sender;
          const originMayRead = (chatId: string) => {
            const o = app.queue.input(ctx.run.queueItemId)?.source.origin;
            if (!o || typeof o !== 'object') return false;
            if (o.kind === 'owner') return true;
            if ((o.kind === 'member' || o.kind === 'guest') && typeof o.id === 'string')
              return app.chats.canRead(chatId, { id: o.id, kind: o.kind });
            return false;
          };
          // a run never reads more than the person who started it could: non-owner senders never inherit the
          // owner's reach (ARCHITECTURE 7.1). Owner turns see every chat the agent is in; a member's or guest's turn
          // sees the chats both the agent and that person are in; anyone else (channel strangers, webhooks,
          // automations) only the run's own chat. Work from another agent reads its own chat only when the sender
          // that started the chain (`source.origin`) may read it, and nothing when that origin is unknown: a guest
          // can never reach the owner's chats through an agent it asked to delegate (8, "Cross-agent abuse").
          let hits: ReturnType<typeof search>;
          if (who.kind === 'owner')
            hits = search({ ...(input.chatId ? { chatId: input.chatId } : {}), limit });
          else if ((who.kind === 'member' || who.kind === 'guest') && who.id) {
            const user = { id: who.id, kind: who.kind };
            hits = search({ ...(input.chatId ? { chatId: input.chatId } : {}), limit: 100 })
              .filter((h) => app.chats.canRead(h.chatId, user))
              .slice(0, limit);
          } else {
            const own = app.chats.runChat(ctx.run.id);
            const allowed =
              !!own &&
              (!input.chatId || input.chatId === own) &&
              (who.kind !== 'agent' || originMayRead(own));
            hits = allowed && own ? search({ chatId: own, limit }) : [];
          }
          return {
            // results are other people's words: data, never instructions (8, "Injection via tools")
            untrusted: true,
            hits: hits.map((h) => ({
              chatId: h.chatId,
              chatTitle: h.chatTitle,
              author: h.authorKind,
              at: new Date(h.createdAt).toISOString(),
              text: app.redact(h.snippet),
            })),
          };
        },
      });
    },
  });
}
export default createSearchModule();
