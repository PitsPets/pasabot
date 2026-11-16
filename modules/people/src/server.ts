/**
 * People (W23): optional extra people on a single-owner server. The owner mints an invite link (member or guest,
 * the chats it opens, an expiry); the invitee accepts it on a signed-out page (`#/join`, through this module's
 * `publicHttp` hooks), picks a name and password and is signed in. The owner manages who is in which chat (member or
 * read-only observer), disables people, and chooses which agents members may use; a member opens a direct chat with
 * such an agent ("import" it into their own list). Guests only ever see the chats they were added to.
 *
 * Core rows (users, sessions, chat_members, chats) are written only through the core PeoplePort, which checks every
 * actor itself. This module keeps its own tables: invites (token hash only, single use, expiring) and shared agents.
 * Members and guests never gain owner trust: their turns run as their own sender kind (ARCHITECTURE 7.4).
 */
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type Principal,
  ulid,
} from '@pasabot/core';
import { z } from 'zod';

declare module '@pasabot/protocol' {
  interface EventMap {
    /** owner topic: a person was disabled (push drops their devices) */
    'people.disabled': { userId: string };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600_000;
const hashToken = (t: string) => createHash('sha256').update(`pasabot-invite:${t}`).digest('hex');

export interface InviteDTO {
  id: string;
  kind: 'member' | 'guest';
  chats: { chatId: string; role: 'member' | 'observer'; title: string }[];
  note: string;
  createdAt: number;
  expiresAt: number;
}

type InviteRow = {
  id: string;
  kind: 'member' | 'guest';
  chats: string;
  note: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
};

const chatRoleSchema = z.enum(['member', 'observer']);
const createInviteSchema = z
  .object({
    kind: z.enum(['member', 'guest']),
    chats: z.array(z.object({ chatId: z.string().min(1).max(64), role: chatRoleSchema })).max(50),
    note: z.string().max(80).optional(),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 14)
      .optional(),
  })
  .refine((v) => v.kind === 'member' || v.chats.length > 0, {
    message: 'a guest invite names at least one chat',
  });
const tokenSchema = z.string().min(20).max(100);

export interface PeopleOptions {
  now?: () => number;
}

export function createPeopleModule(o: PeopleOptions = {}): PasaBotModule {
  const now = o.now ?? Date.now;
  return defineModule({
    id: 'people',
    migrations: join(here, '..', 'migrations'),
    register(app: ModuleHost) {
      const db = app.raw;
      const owner = (ctx: AuthedCtx<unknown>): Extract<Principal, { kind: 'session' }> => {
        const p = ctx.principal;
        if (p.kind !== 'session' || p.userKind !== 'owner')
          throw new HttpError(403, 'owner only', 'owner_only');
        return p;
      };
      const chatTitle = (ownerId: string, chatId: string) =>
        app.chats.get({ kind: 'user', id: ownerId }, chatId)?.title ?? null;
      const toDTO = (r: InviteRow): InviteDTO => ({
        id: r.id,
        kind: r.kind,
        chats: (JSON.parse(r.chats) as { chatId: string; role: 'member' | 'observer' }[]).map((c) => ({
          ...c,
          title: chatTitle(r.created_by, c.chatId) ?? '',
        })),
        note: r.note,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      });
      const openInvite = (token: string): InviteRow | null =>
        (db
          .prepare(
            `SELECT * FROM people_invite WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL
             AND expires_at > ?`,
          )
          .get(hashToken(token), now()) as InviteRow | undefined) ?? null;
      const shared = () =>
        new Set(
          (db.prepare('SELECT agent_id FROM people_shared_agent').all() as { agent_id: string }[]).map(
            (r) => r.agent_id,
          ),
        );

      // ---------- people (owner) ----------
      app.http.route({
        method: 'GET',
        url: '/people',
        auth: 'session',
        handler: (ctx) => ({ people: app.people.list(ctx.principal) }),
      });
      for (const action of ['disable', 'enable'] as const)
        app.http.route({
          method: 'POST',
          url: `/people/:id/${action}`,
          auth: 'session',
          handler: (ctx) => {
            const p = owner(ctx);
            if (!app.people.setDisabled(p, ctx.params.id!, action === 'disable'))
              throw new HttpError(404, 'no such person', 'not_found');
            if (action === 'disable') app.bus.publish('owner', 'people.disabled', { userId: ctx.params.id! });
            return { ok: true };
          },
        });

      // ---------- invites (owner) ----------
      app.http.route({
        method: 'GET',
        url: '/invites',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const rows = db
            .prepare(
              `SELECT * FROM people_invite WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
               ORDER BY created_at DESC`,
            )
            .all(now()) as InviteRow[];
          return { invites: rows.map(toDTO) };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/invites',
        auth: 'session',
        body: createInviteSchema,
        handler: (ctx) => {
          const p = owner(ctx);
          const b = ctx.body;
          const seen = new Set<string>();
          for (const c of b.chats) {
            if (seen.has(c.chatId)) throw new HttpError(400, 'a chat is named twice', 'invalid_input');
            seen.add(c.chatId);
            const info = app.chats.get({ kind: 'user', id: p.userId }, c.chatId);
            if (!info || info.archivedAt) throw new HttpError(400, 'no such chat', 'unknown_chat');
          }
          const token = randomBytes(24).toString('base64url');
          const id = ulid();
          const at = now();
          const expiresAt = at + (b.expiresInHours ?? 72) * HOUR;
          db.prepare(
            `INSERT INTO people_invite (id, token_hash, kind, chats, note, created_by, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            hashToken(token),
            b.kind,
            JSON.stringify(b.chats),
            (b.note ?? '').trim(),
            p.userId,
            at,
            expiresAt,
          );
          app.log.info('people.invite_created', { id, kind: b.kind, chats: b.chats.length });
          // the raw token is returned once; the link carries it in the fragment, so it never reaches a server log
          return { id, token, path: `/#/join?invite=${token}`, expiresAt };
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/invites/:id',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const r = db
            .prepare(
              'UPDATE people_invite SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
            )
            .run(now(), ctx.params.id);
          if (r.changes !== 1) throw new HttpError(404, 'no open invite', 'not_found');
          return { ok: true };
        },
      });

      // ---------- chat membership ----------
      app.http.route({
        method: 'GET',
        url: '/chats/:chatId/people',
        auth: 'session',
        handler: (ctx) => ({ people: app.people.chatPeople(ctx.principal, ctx.params.chatId!) }),
      });
      app.http.route({
        method: 'PUT',
        url: '/chats/:chatId/people/:userId',
        auth: 'session',
        body: z.object({ role: chatRoleSchema }),
        handler: (ctx) => {
          app.people.setChatRole(owner(ctx), ctx.params.chatId!, ctx.params.userId!, ctx.body.role);
          return { ok: true };
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/chats/:chatId/people/:userId',
        auth: 'session',
        handler: (ctx) => {
          app.people.setChatRole(owner(ctx), ctx.params.chatId!, ctx.params.userId!, null);
          return { ok: true };
        },
      });

      // ---------- agents members may use ----------
      app.http.route({
        method: 'GET',
        url: '/agents',
        auth: 'session',
        handler: async (ctx) => {
          const p = ctx.principal;
          if (p.kind !== 'session' || p.userKind === 'guest')
            throw new HttpError(403, 'guests use only the chats they were added to', 'forbidden');
          const on = shared();
          const all = (await app.agents.list()).filter((a) => !a.archivedAt);
          const list = p.userKind === 'owner' ? all : all.filter((a) => on.has(a.id));
          return {
            agents: list.map((a) => ({
              id: a.id,
              name: a.name,
              avatarSalt: a.avatarSalt,
              shared: on.has(a.id),
              // members see only what they need to choose an agent, never its instructions or workspace
              ...(p.userKind === 'owner' ? { instructions: a.instructions } : {}),
            })),
          };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/agents/:agentId/share',
        auth: 'session',
        body: z.object({ shared: z.boolean() }),
        handler: async (ctx) => {
          const p = owner(ctx);
          const a = await app.agents.get(ctx.params.agentId!);
          if (!a || a.archivedAt) throw new HttpError(404, 'no such agent', 'not_found');
          if (ctx.body.shared)
            db.prepare(
              'INSERT OR IGNORE INTO people_shared_agent (agent_id, shared_by, shared_at) VALUES (?, ?, ?)',
            ).run(a.id, p.userId, now());
          else {
            db.prepare('DELETE FROM people_shared_agent WHERE agent_id = ?').run(a.id);
            // unsharing cuts members off: their direct chats with it are archived and they leave them (the owner
            // keeps the history), and their turns there stop; opening it again needs a new share
            const closed = app.people.closeDirects(p, a.id);
            return { ok: true, closed };
          }
          return { ok: true };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/agents/:agentId/open',
        auth: 'session',
        handler: (ctx) => {
          const p = ctx.principal;
          if (p.kind !== 'session' || p.userKind !== 'member')
            throw new HttpError(403, 'members only', 'forbidden');
          if (!shared().has(ctx.params.agentId!))
            throw new HttpError(404, 'not shared with members', 'not_found');
          return { chatId: app.people.openDirect(p, ctx.params.agentId!) };
        },
      });

      // ---------- invite accept page (signed out) ----------
      app.publicHttp.route({
        method: 'POST',
        url: '/invite',
        rateLimit: { max: 30, windowMs: 60_000 },
        bodyLimit: 1024,
        handler: (ctx) => {
          const b = z.object({ token: tokenSchema }).safeParse(parseJson(ctx.rawBody));
          const inv = b.success ? openInvite(b.data.token) : null;
          if (!inv) return httpResponse(404, { error: 'invite_invalid' });
          const owners = app.people.get(asSystem('people: invite preview'), inv.created_by);
          const dto = toDTO(inv);
          return {
            kind: inv.kind,
            invitedBy: owners?.displayName ?? '',
            chats: dto.chats.map((c) => ({ title: c.title, role: c.role })),
            expiresAt: inv.expires_at,
          };
        },
      });
      app.publicHttp.route({
        method: 'POST',
        url: '/accept',
        rateLimit: { max: 10, windowMs: 60_000 },
        bodyLimit: 4096,
        handler: async (ctx) => {
          const b = z
            .object({
              token: tokenSchema,
              displayName: z.string().trim().min(1).max(80),
              password: z.string().min(8).max(512),
            })
            .safeParse(parseJson(ctx.rawBody));
          if (!b.success) return httpResponse(400, { error: 'invalid_input' });
          // claim the invite atomically: single use, unexpired, not revoked
          const inv = openInvite(b.data.token);
          if (!inv) return httpResponse(404, { error: 'invite_invalid' });
          const claimed = db
            .prepare(
              `UPDATE people_invite SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
               AND expires_at > ?`,
            )
            .run(now(), inv.id, now());
          if (claimed.changes !== 1) return httpResponse(404, { error: 'invite_invalid' });
          const sys = asSystem(`people: invite ${inv.id} accepted`);
          let person: Awaited<ReturnType<typeof app.people.create>>;
          try {
            person = await app.people.create(sys, {
              kind: inv.kind,
              displayName: b.data.displayName,
              password: b.data.password,
              invitedBy: inv.created_by,
            });
          } catch {
            // a refused name gives the invite back, so the person can try again
            db.prepare('UPDATE people_invite SET used_at = NULL WHERE id = ?').run(inv.id);
            return httpResponse(400, { error: 'invalid_name' });
          }
          db.prepare('UPDATE people_invite SET used_by = ? WHERE id = ?').run(person.id, inv.id);
          for (const c of JSON.parse(inv.chats) as { chatId: string; role: 'member' | 'observer' }[]) {
            try {
              app.people.setChatRole(sys, c.chatId, person.id, c.role);
            } catch (e) {
              // a chat archived or gone since the invite was made is skipped
              app.log.warn('people.invite_chat_skipped', { invite: inv.id, error: (e as Error).message });
            }
          }
          const origin = ctx.headers.origin;
          const s = app.people.signIn(sys, person.id, {
            ip: ctx.ip,
            userAgent: String(ctx.headers['user-agent'] ?? ''),
            ...(typeof origin === 'string' ? { origin } : {}),
          });
          return httpResponse(
            200,
            {
              user: { id: person.id, kind: person.kind, displayName: person.displayName },
              ...(s.token ? { token: s.token } : {}),
            },
            { 'set-cookie': s.setCookie },
          );
        },
      });
    },
  });
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

export default createPeopleModule();
