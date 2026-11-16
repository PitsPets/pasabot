/**
 * The PeoplePort (W23, ModuleHost.people): extra member/guest accounts and per-chat membership for the people module.
 * Core user, session and chat_members rows are written here, never by a module. Every call checks its actor itself
 * (a live owner session, `asSystem` for an invite the module already verified, or a member for `openDirect`).
 */
import {
  type ChatPerson,
  type EventBus,
  PeopleAccessError,
  type PeoplePort,
  type PersonInfo,
  type Principal,
  type QueueService,
  type SessionReader,
  type SystemActor,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { Auth } from './index.js';
import { hashPassword } from './password.js';

type Actor = Principal | SystemActor;
type Row = {
  id: string;
  kind: PersonInfo['kind'];
  display_name: string;
  created_at: number;
  disabled_at: number | null;
};
const toPerson = (r: Row): PersonInfo => ({
  id: r.id,
  kind: r.kind,
  displayName: r.display_name,
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});
/** printable display names only: no control, bidi-override or zero-width characters (same rule as pairing) */
const BAD_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** queue items a person's turn may still be in (running ones are aborted through `QueueService.cancel`) */
const ACTIVE_ITEMS = "state IN ('queued','held','leased','running')";
/** a member/guest who asked for the item, directly or further up the chain */
const BY_PERSON = `((json_extract(source, '$.sender.id') = :uid AND json_extract(source, '$.sender.kind') IN ('member','guest'))
  OR (json_extract(source, '$.origin.id') = :uid AND json_extract(source, '$.origin.kind') IN ('member','guest')))`;

export function createPeoplePort(d: {
  db: Sqlite;
  bus: EventBus;
  auth: Pick<Auth, 'startSession' | 'sessionCookie'>;
  /** cancels a disabled person's turns; without it (unit tests) the dispatch-time check still refuses them */
  queue?: Pick<QueueService, 'cancel'>;
}): PeoplePort {
  const { db } = d;
  const isSystem = (a: Actor): a is SystemActor => a.kind === 'system';
  /** the session must be live (sessions + users rows), not just shaped like one */
  const liveUser = (a: Actor) => {
    if (a.kind !== 'session') return null;
    return (
      (db
        .prepare(
          `SELECT u.id, u.kind FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
        )
        .get(a.sessionId, a.userId, Date.now()) as { id: string; kind: PersonInfo['kind'] } | undefined) ??
      null
    );
  };
  const requireOwner = (a: Actor) => {
    const u = liveUser(a);
    if (u?.kind !== 'owner') throw new PeopleAccessError('owner only');
    return u;
  };
  const audit = (a: Actor, action: string, target: string, data: unknown = {}) =>
    db
      .prepare(
        'INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target, ip, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        ulid(),
        Date.now(),
        a.kind === 'session' ? 'user' : 'system',
        a.kind === 'session' ? a.userId : null,
        action,
        target,
        '',
        JSON.stringify(a.kind === 'system' ? { ...(data as object), reason: a.reason } : data),
      );
  const row = (id: string) =>
    (db.prepare('SELECT id, kind, display_name, created_at, disabled_at FROM users WHERE id = ?').get(id) as
      | Row
      | undefined) ?? null;
  const cancelItems = (where: string, params: Record<string, unknown>) => {
    if (!d.queue) return 0;
    let n = 0;
    for (const r of db
      .prepare(`SELECT id FROM queue_items WHERE ${ACTIVE_ITEMS} AND ${where}`)
      .all(params) as { id: string }[])
      if (d.queue.cancel(r.id)) n++;
    return n;
  };
  const chatExists = (chatId: string) =>
    !!db.prepare('SELECT 1 FROM chats WHERE id = ? AND archived_at IS NULL').get(chatId);

  return {
    list(actor) {
      requireOwner(actor);
      return (
        db
          .prepare(
            "SELECT id, kind, display_name, created_at, disabled_at FROM users ORDER BY kind = 'owner' DESC, created_at",
          )
          .all() as Row[]
      ).map(toPerson);
    },
    get(actor, userId) {
      if (!isSystem(actor)) {
        const u = liveUser(actor);
        if (!u || (u.kind !== 'owner' && u.id !== userId)) throw new PeopleAccessError();
      }
      const r = row(userId);
      return r ? toPerson(r) : null;
    },
    async create(actor, o) {
      if (!isSystem(actor)) throw new PeopleAccessError('accounts are created by accepting an invite');
      if (o.kind !== 'member' && o.kind !== 'guest') throw new PeopleAccessError('members and guests only');
      const name = o.displayName.trim();
      if (!name || name.length > 80 || BAD_NAME.test(name)) throw new Error('invalid display name');
      if (o.password.length < 8 || o.password.length > 512) throw new Error('invalid password');
      const id = ulid();
      const now = Date.now();
      db.prepare(
        'INSERT INTO users (id, kind, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, o.kind, name, await hashPassword(o.password), now);
      audit(actor, 'people.joined', id, { kind: o.kind, invitedBy: o.invitedBy });
      return toPerson(row(id)!);
    },
    setDisabled(actor, userId, disabled) {
      requireOwner(actor);
      const r = row(userId);
      if (!r || r.kind === 'owner') return false;
      if (disabled) {
        db.transaction(() => {
          db.prepare('UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL').run(
            Date.now(),
            userId,
          );
          // every session ends now; live sockets drop on their next membership/session re-check
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        })();
        // their queued and running turns stop too (the queue's dispatch check refuses any that slip past)
        const cancelled = cancelItems(BY_PERSON, { uid: userId });
        audit(actor, 'people.disabled', userId, { cancelled });
        return true;
      }
      db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(userId);
      audit(actor, 'people.enabled', userId);
      return true;
    },
    signIn(actor, userId, req) {
      if (!isSystem(actor)) throw new PeopleAccessError();
      const r = row(userId);
      if (!r || r.kind === 'owner' || r.disabled_at) throw new PeopleAccessError('no such person');
      const token = d.auth.startSession(userId, { ip: req.ip, userAgent: req.userAgent });
      audit(actor, 'people.signed_in', userId);
      return { setCookie: d.auth.sessionCookie(token), ...(req.origin === undefined ? { token } : {}) };
    },
    chatPeople(actor, chatId) {
      const u = liveUser(actor);
      if (!u) throw new PeopleAccessError();
      if (
        u.kind !== 'owner' &&
        !db
          .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
          .get(chatId, u.id)
      )
        throw new PeopleAccessError();
      return (
        db
          .prepare(
            `SELECT u.id AS userId, u.kind, u.display_name AS displayName, m.role FROM chat_members m
             JOIN users u ON u.id = m.member_id
             WHERE m.chat_id = ? AND m.member_kind = 'user' AND u.disabled_at IS NULL
             ORDER BY u.kind = 'owner' DESC, u.display_name`,
          )
          .all(chatId) as ChatPerson[]
      ).map((p) => ({ ...p }));
    },
    setChatRole(actor, chatId, userId, role) {
      if (!isSystem(actor)) requireOwner(actor);
      const r = row(userId);
      if (!r || r.kind === 'owner') throw new PeopleAccessError('the owner is in every chat');
      if (!chatExists(chatId)) throw new PeopleAccessError('no such chat');
      if (role !== null && role !== 'member' && role !== 'observer') throw new PeopleAccessError('bad role');
      const had = !!db
        .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
        .get(chatId, userId);
      if (role === null)
        db.prepare(
          "DELETE FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?",
        ).run(chatId, userId);
      else
        db.prepare(
          `INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, ?)
           ON CONFLICT DO UPDATE SET role = excluded.role`,
        ).run(chatId, userId, role);
      audit(actor, role ? 'people.chat_role' : 'people.chat_removed', chatId, { userId, role });
      // id only on `global`: every client refetches its own membership-filtered chat list (the new person sees it,
      // a removed one loses it; their live socket stops getting `chat:<id>` on the next re-check)
      if (!had || role === null) d.bus.publish('global', 'chat.created', { id: chatId });
    },
    openDirect(actor, agentId) {
      const u = liveUser(actor);
      if (u?.kind !== 'member') throw new PeopleAccessError('members only');
      const agent = db.prepare('SELECT name FROM agents WHERE id = ? AND archived_at IS NULL').get(agentId) as
        | { name: string }
        | undefined;
      if (!agent) throw new PeopleAccessError('no such agent');
      const existing = db
        .prepare(
          `SELECT c.id FROM chats c
           JOIN chat_members a ON a.chat_id = c.id AND a.member_kind = 'agent' AND a.member_id = ?
           JOIN chat_members m ON m.chat_id = c.id AND m.member_kind = 'user' AND m.member_id = ?
           WHERE c.kind = 'direct' AND c.archived_at IS NULL AND json_extract(c.settings, '$.peopleDirect') = ?
           LIMIT 1`,
        )
        .get(agentId, u.id, u.id) as { id: string } | undefined;
      if (existing) return existing.id;
      const id = ulid();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO chats (id, kind, title, task_owner_agent_id, settings, created_at) VALUES (?, 'direct', ?, ?, ?, ?)",
        ).run(id, agent.name, agentId, JSON.stringify({ peopleDirect: u.id, moduleChat: true }), Date.now());
        for (const o of db.prepare("SELECT id FROM users WHERE kind = 'owner'").all() as { id: string }[])
          db.prepare(
            "INSERT OR IGNORE INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'owner')",
          ).run(id, o.id);
        db.prepare(
          "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'member')",
        ).run(id, u.id);
        db.prepare(
          "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'agent', ?, 'member')",
        ).run(id, agentId);
      })();
      audit(actor, 'people.direct_opened', id, { agentId });
      d.bus.publish('global', 'chat.created', { id });
      return id;
    },
    closeDirects(actor, agentId) {
      requireOwner(actor);
      const chats = db
        .prepare(
          `SELECT c.id FROM chats c
           JOIN chat_members a ON a.chat_id = c.id AND a.member_kind = 'agent' AND a.member_id = ?
           WHERE c.kind = 'direct' AND json_extract(c.settings, '$.peopleDirect') IS NOT NULL`,
        )
        .all(agentId) as { id: string }[];
      const at = Date.now();
      const closed: string[] = [];
      for (const c of chats) {
        const people = (
          db
            .prepare(
              `SELECT m.member_id AS id FROM chat_members m JOIN users u ON u.id = m.member_id
               WHERE m.chat_id = ? AND m.member_kind = 'user' AND u.kind != 'owner'`,
            )
            .all(c.id) as { id: string }[]
        ).map((r) => r.id);
        if (!people.length) continue; // already closed
        db.transaction(() => {
          db.prepare('UPDATE chats SET archived_at = coalesce(archived_at, ?) WHERE id = ?').run(at, c.id);
          db.prepare(
            `DELETE FROM chat_members WHERE chat_id = ? AND member_kind = 'user'
             AND member_id IN (SELECT id FROM users WHERE kind != 'owner')`,
          ).run(c.id);
        })();
        for (const uid of people) cancelItems(`chat_id = :chat AND ${BY_PERSON}`, { chat: c.id, uid });
        audit(actor, 'people.direct_closed', c.id, { agentId, people });
        closed.push(c.id);
        // id only: every client refetches its membership-filtered list (the member loses the chat at once)
        d.bus.publish('global', 'chat.created', { id: c.id });
      }
      return closed.length;
    },
  };
}

/** `ModuleHost.sessions`: is a session still signed in (not logged out, revoked, expired, or its user disabled). */
export function createSessionReader(db: Sqlite): SessionReader {
  return {
    live(actor, sessionId) {
      if (actor?.kind !== 'system') throw new PeopleAccessError('sessions.live is server work only');
      return (
        (db
          .prepare(
            `SELECT u.id AS userId, u.kind AS userKind FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
          )
          .get(sessionId, Date.now()) as { userId: string; userKind: PersonInfo['kind'] } | undefined) ?? null
      );
    },
  };
}

/** Every module but `people` gets this copy: each call refuses (403). */
export function deniedPeoplePort(id: string): PeoplePort {
  const no = (): never => {
    throw new PeopleAccessError(`${id}: ModuleHost.people is only for the people module`);
  };
  return {
    list: no,
    get: no,
    create: async () => no(),
    setDisabled: no,
    signIn: no,
    chatPeople: no,
    setChatRole: no,
    openDirect: no,
    closeDirects: no,
  };
}
