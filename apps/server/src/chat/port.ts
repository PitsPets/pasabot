/** The ChatPort modules receive (ModuleHost.chats): core chat rows are created and read here, never by modules. */
import {
  type BlockKindRegistry,
  ChatAccessError,
  type ChatActor,
  type ChatPort,
  type EventBus,
  type MessageSearchHit,
  type ServerI18n,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { MessageBlock, MessageDTO } from '@pasabot/protocol';
import { NO_CARD } from '../core/cards.js';
import { toMessageDTO } from './dto.js';
import { inRequestThread, NO_APPROVAL, sharedBlocksOnlySql, viewMessage } from './view.js';
import { canWriteChat } from './write.js';

/** FTS5 query from free text: every word quoted (no operators from users or agents), prefix match on the last. */
export function ftsQuery(text: string): string | null {
  const words = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((w, i) => `"${w.replace(/"/g, '')}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

const snippetOf = (body: string, text: string) => {
  const first = text.split(/\s+/).find(Boolean)?.toLowerCase() ?? '';
  const at = first ? body.toLowerCase().indexOf(first) : -1;
  const start = Math.max(0, Math.max(0, at) - 60);
  const out = body.slice(start, start + 200);
  return (start > 0 ? '…' : '') + out + (start + 200 < body.length ? '…' : '');
};

export function createChatPort(
  db: Sqlite,
  bus?: EventBus,
  o: { blocks?: BlockKindRegistry; redact?: (t: string) => string; i18n?: ServerI18n } = {},
): ChatPort {
  const checkBlocks = (blocks: MessageBlock[]) => {
    for (const b of blocks) {
      const r = o.blocks?.validate(b);
      if (!r?.ok) throw new Error(`invalid block ${b.kind}: ${r ? r.reason : 'no block registry'}`);
    }
  };
  const messageById = (id: string): MessageDTO | null => {
    const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? toMessageDTO(r) : null;
  };
  const chatExists = (chatId: string) => !!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId);
  /** The actor's user kind from the database (never the caller's claim), or null for a missing/disabled user. */
  const userKind = (id: string) =>
    (
      db.prepare('SELECT kind FROM users WHERE id = ? AND disabled_at IS NULL').get(id) as
        | { kind: 'owner' | 'member' | 'guest' }
        | undefined
    )?.kind ?? null;
  const agentRole = (chatId: string, agentId: string) =>
    (
      db
        .prepare(
          "SELECT role FROM chat_members WHERE chat_id = ? AND member_kind = 'agent' AND member_id = ?",
        )
        .get(chatId, agentId) as { role: string } | undefined
    )?.role ?? null;
  const isOwnerUser = (a: ChatActor) => a.kind === 'user' && userKind(a.id) === 'owner';
  /** ARCHITECTURE 5.5: owners read every chat, other users and agents only chats they are members of. */
  const mayRead = (a: ChatActor, chatId: string): boolean => {
    if (!chatExists(chatId)) return false;
    if (a.kind === 'system') return true;
    if (a.kind === 'agent') return agentRole(chatId, a.id) !== null;
    const kind = userKind(a.id);
    if (!kind) return false;
    if (kind === 'owner') return true;
    return !!db
      .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
      .get(chatId, a.id);
  };
  /** Reading and not an observer (owners always). */
  const mayWrite = (a: ChatActor, chatId: string): boolean => {
    if (!chatExists(chatId)) return false;
    if (a.kind === 'system') return true;
    if (a.kind === 'agent') {
      const role = agentRole(chatId, a.id);
      return role !== null && role !== 'observer';
    }
    const kind = userKind(a.id);
    return !!kind && canWriteChat(db, { userId: a.id, userKind: kind }, chatId);
  };
  // typed on the declaration so a call narrows like a throw
  const deny: (what: string) => never = (what) => {
    throw new ChatAccessError(`not allowed to ${what} in this chat`);
  };
  const messageChat = (id: string) =>
    (db.prepare('SELECT chat_id, author_kind, author_id FROM messages WHERE id = ?').get(id) as
      | { chat_id: string; author_kind: string; author_id: string | null }
      | undefined) ?? null;
  const owners = () =>
    (
      db.prepare("SELECT id FROM users WHERE kind = 'owner' AND disabled_at IS NULL").all() as {
        id: string;
      }[]
    ).map((u) => u.id);
  const open = (agentId: string, title: string, settings: Record<string, unknown>) => {
    const id = ulid();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO chats (id, kind, title, task_owner_agent_id, settings, created_at) VALUES (?, 'direct', ?, ?, ?, ?)",
      ).run(id, title, agentId, JSON.stringify(settings), Date.now());
      for (const u of owners())
        db.prepare(
          "INSERT OR IGNORE INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'owner')",
        ).run(id, u);
      db.prepare(
        "INSERT OR IGNORE INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'agent', ?, 'member')",
      ).run(id, agentId);
    })();
    // id only on the global topic: each client refetches its own membership-filtered chat list
    bus?.publish('global', 'chat.created', { id });
    return id;
  };
  return {
    ownChat(agentId, opts = {}) {
      const r = db
        .prepare(
          `SELECT c.id FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.member_kind = 'agent' AND m.member_id = ?
           WHERE c.kind = 'direct' AND c.archived_at IS NULL
             AND json_extract(c.settings, '$.moduleChat') IS NULL
             AND json_extract(c.settings, '$.peopleDirect') IS NULL
             AND (SELECT count(*) FROM chat_members x WHERE x.chat_id = c.id AND x.member_kind = 'agent') = 1
           ORDER BY c.created_at LIMIT 1`,
        )
        .get(agentId) as { id: string } | undefined;
      if (r || !opts.create) return r?.id ?? null;
      const a = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as
        | { name: string }
        | undefined;
      if (!a) throw new Error('agent not found');
      return open(agentId, a.name, {});
    },
    openDirect(o) {
      if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(o.agentId)) throw new Error('agent not found');
      return open(o.agentId, o.title, { ...o.settings, moduleChat: true });
    },
    recent(actor, chatId, limit) {
      if (!mayRead(actor, chatId)) deny('read');
      return (
        db
          .prepare(
            // a card (W40) or an approval is the owner's UI, not the conversation: its words never read back to a
            // helper (who may be answering someone else in the chat)
            `SELECT author_kind, body, created_at FROM messages WHERE chat_id = ? AND status = 'final' AND ${NO_CARD} AND ${NO_APPROVAL} ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(chatId, Math.max(0, Math.min(200, limit))) as {
          author_kind: string;
          body: string;
          created_at: number;
        }[]
      ).map((m) => ({ authorKind: m.author_kind, body: m.body, createdAt: m.created_at }));
    },
    runReply(actor, runId) {
      const r = db
        .prepare(
          `SELECT body, chat_id FROM messages WHERE run_id = ? AND author_kind = 'agent' AND status = 'final' AND ${NO_CARD} ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(runId) as { body: string; chat_id: string } | undefined;
      if (!r || !mayRead(actor, r.chat_id)) return null;
      return r.body;
    },
    isMember(chatId, member) {
      return !!db
        .prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = ? AND member_id = ?')
        .get(chatId, member.kind, member.id);
    },
    get(actor, chatId) {
      if (!mayRead(actor, chatId)) return null;
      const c = db
        .prepare('SELECT id, kind, title, task_owner_agent_id, archived_at FROM chats WHERE id = ?')
        .get(chatId) as
        | {
            id: string;
            kind: 'direct' | 'channel';
            title: string;
            task_owner_agent_id: string | null;
            archived_at: number | null;
          }
        | undefined;
      if (!c) return null;
      const members = db
        .prepare('SELECT member_kind, member_id, role FROM chat_members WHERE chat_id = ? ORDER BY rowid')
        .all(chatId) as { member_kind: 'user' | 'agent'; member_id: string; role: string }[];
      return {
        id: c.id,
        kind: c.kind,
        title: c.title,
        taskOwnerAgentId: c.task_owner_agent_id,
        archivedAt: c.archived_at,
        members: members.map((m) => ({ kind: m.member_kind, id: m.member_id, role: m.role })),
      };
    },
    setTaskOwner(actor, chatId, agentId) {
      if (!chatExists(chatId)) throw new Error('chat not found');
      // the owner, the system, or the agent that leads the chat now (handing it on); never another member
      const lead = (
        db.prepare('SELECT task_owner_agent_id FROM chats WHERE id = ?').get(chatId) as {
          task_owner_agent_id: string | null;
        }
      ).task_owner_agent_id;
      const allowed =
        actor.kind === 'system' ||
        isOwnerUser(actor) ||
        (actor.kind === 'agent' && actor.id === lead && mayWrite(actor, chatId));
      if (!allowed) deny('change the lead');
      if (
        !db
          .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'agent' AND member_id = ?")
          .get(chatId, agentId)
      )
        throw new Error('agent is not a member of this chat');
      db.prepare('UPDATE chats SET task_owner_agent_id = ? WHERE id = ?').run(agentId, chatId);
      bus?.publish('global', 'chat.created', { id: chatId });
    },
    setArchived(actor, chatId, archived) {
      if (!(actor.kind === 'system' || isOwnerUser(actor)) || !chatExists(chatId)) deny('archive');
      db.prepare('UPDATE chats SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, chatId);
      bus?.publish('global', 'chat.created', { id: chatId });
    },
    react(actor, chatId, messageId, emoji, on) {
      if (actor.kind === 'system' || !mayWrite(actor, chatId)) deny('react');
      if (!db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId))
        return false;
      if (on)
        db.prepare(
          'INSERT OR IGNORE INTO reactions (message_id, actor_kind, actor_id, emoji) VALUES (?, ?, ?, ?)',
        ).run(messageId, actor.kind, actor.id, emoji);
      else
        db.prepare(
          'DELETE FROM reactions WHERE message_id = ? AND actor_kind = ? AND actor_id = ? AND emoji = ?',
        ).run(messageId, actor.kind, actor.id, emoji);
      bus?.publish(`chat:${chatId}`, 'reaction.changed', { chatId, messageId });
      return true;
    },
    reactions(actor, chatId) {
      if (!mayRead(actor, chatId)) deny('read');
      return (
        db
          .prepare(
            'SELECT r.message_id, r.emoji, r.actor_kind, r.actor_id FROM reactions r JOIN messages m ON m.id = r.message_id WHERE m.chat_id = ? ORDER BY m.created_at, r.emoji',
          )
          .all(chatId) as { message_id: string; emoji: string; actor_kind: string; actor_id: string }[]
      ).map((r) => ({
        messageId: r.message_id,
        emoji: r.emoji,
        actorKind: r.actor_kind,
        actorId: r.actor_id,
      }));
    },
    post(actor, m) {
      const blocks = m.blocks ?? [];
      checkBlocks(blocks);
      if (!chatExists(m.chatId)) throw new Error('chat not found');
      if (actor.kind === 'user') deny('post through the port'); // people post through the message route
      if (actor.kind === 'agent') {
        // an agent posts only as itself, where it may write, and only for its own run
        if (m.authorKind !== 'agent' || m.authorId !== actor.id || !mayWrite(actor, m.chatId)) deny('post');
        if (m.runId) {
          const run = db.prepare('SELECT agent_id FROM runs WHERE id = ?').get(m.runId) as
            | { agent_id: string }
            | undefined;
          if (run?.agent_id !== actor.id) deny('post for another run');
        }
      }
      // a thread points into this same chat only
      if (
        m.replyTo &&
        !db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(m.replyTo, m.chatId)
      )
        throw new Error('replyTo is not a message of this chat');
      if (m.createdAt !== undefined && actor.kind !== 'system') deny('post with a time');
      const at = m.createdAt ?? Date.now();
      const id = ulid(at);
      db.prepare(
        "INSERT INTO messages (id, chat_id, author_kind, author_id, reply_to, body, blocks, status, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'final', ?, ?)",
      ).run(
        id,
        m.chatId,
        m.authorKind,
        m.authorId,
        m.replyTo ?? null,
        o.redact ? o.redact(m.body) : m.body,
        JSON.stringify(blocks),
        m.runId ?? null,
        at,
      );
      const msg = messageById(id)!;
      bus?.publish(`chat:${m.chatId}`, 'message.created', msg);
      return msg;
    },
    messages(actor, chatId, q = {}) {
      if (!mayRead(actor, chatId)) deny('read');
      const limit = Math.max(1, Math.min(500, q.limit ?? 200));
      const rows = (
        q.runId
          ? db
              .prepare(
                'SELECT * FROM messages WHERE chat_id = ? AND run_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
              )
              .all(chatId, q.runId, limit)
          : db
              .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
              .all(chatId, limit)
      ) as Record<string, any>[];
      const list = rows.reverse().map(toMessageDTO);
      if (actor.kind !== 'user') return list;
      const viewer = { kind: userKind(actor.id) ?? 'guest', userId: actor.id };
      return list.flatMap((m) => viewMessage(m, viewer, { db, i18n: o.i18n }) ?? []);
    },
    move(actor, mv) {
      if (actor.kind !== 'system') deny('move messages');
      if (!chatExists(mv.toChatId)) throw new Error('chat not found');
      if (
        mv.replyTo &&
        !db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(mv.replyTo, mv.toChatId)
      )
        throw new Error('replyTo is not a message of that chat');
      const moved: { id: string; from: string }[] = [];
      db.transaction(() => {
        for (const id of mv.messageIds) {
          const at = messageChat(id);
          if (!at || id === mv.replyTo) continue;
          if (mv.replyTo === undefined)
            db.prepare('UPDATE messages SET chat_id = ? WHERE id = ?').run(mv.toChatId, id);
          else
            db.prepare('UPDATE messages SET chat_id = ?, reply_to = ? WHERE id = ?').run(
              mv.toChatId,
              mv.replyTo,
              id,
            );
          moved.push({ id, from: at.chat_id });
        }
      })();
      for (const m of moved) {
        if (m.from !== mv.toChatId)
          bus?.publish(`chat:${m.from}`, 'message.deleted', { id: m.id, chatId: m.from });
        const msg = messageById(m.id);
        if (msg)
          bus?.publish(
            `chat:${mv.toChatId}`,
            m.from === mv.toChatId ? 'message.updated' : 'message.created',
            msg,
          );
      }
      return moved.length;
    },
    updateBlocks(actor, messageId, blocks) {
      checkBlocks(blocks);
      const at = messageChat(messageId);
      if (!at) return null;
      if (
        actor.kind !== 'system' &&
        (at.author_kind !== actor.kind || at.author_id !== actor.id || !mayWrite(actor, at.chat_id))
      )
        deny('edit that message');
      const r = db
        .prepare('UPDATE messages SET blocks = ?, edited_at = ? WHERE id = ?')
        .run(JSON.stringify(blocks), Date.now(), messageId);
      if (r.changes !== 1) return null;
      const msg = messageById(messageId)!;
      bus?.publish(`chat:${msg.chatId}`, 'message.updated', msg);
      return msg;
    },
    message(actor, messageId) {
      const at = messageChat(messageId);
      if (!at || !mayRead(actor, at.chat_id)) return null;
      const m = messageById(messageId);
      // a person who is not the owner never gets the owner's cards (chat/view.ts)
      if (!m || actor.kind !== 'user') return m;
      return viewMessage(m, { kind: userKind(actor.id) ?? 'guest', userId: actor.id }, { db, i18n: o.i18n });
    },
    runChat(runId) {
      const r = db
        .prepare('SELECT q.chat_id FROM runs r JOIN queue_items q ON q.id = r.queue_item_id WHERE r.id = ?')
        .get(runId) as { chat_id: string | null } | undefined;
      return r?.chat_id ?? null;
    },
    canRead(chatId, user) {
      if (user.kind === 'owner') return !!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId);
      return !!db
        .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
        .get(chatId, user.id);
    },
    canWrite(chatId, user) {
      return canWriteChat(db, { userId: user.id, userKind: user.kind }, chatId);
    },
    search(q) {
      const match = ftsQuery(q.text);
      if (!match) return [];
      const limit = Math.max(1, Math.min(100, q.limit ?? 20));
      const everyChat = q.reader.kind === 'user' && q.reader.userKind === 'owner';
      const args: unknown[] = [match];
      let where = '';
      if (!everyChat) {
        // only the owner finds the owner's cards, approvals and notices (chat/view.ts): anyone else searches the
        // conversation only
        where += ` AND ${sharedBlocksOnlySql('m.blocks')}`;
        where +=
          ' AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.member_kind = ? AND cm.member_id = ?)';
        args.push(q.reader.kind, q.reader.id);
      }
      if (q.chatId) {
        where += ' AND m.chat_id = ?';
        args.push(q.chatId);
      }
      args.push(limit);
      const rows = db
        .prepare(
          `SELECT m.id, m.chat_id, m.author_kind, m.author_id, m.reply_to, m.body, m.created_at, c.title
           FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN chats c ON c.id = m.chat_id
           WHERE messages_fts MATCH ? AND m.status = 'final'${where}
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
        )
        .all(...args) as {
        id: string;
        chat_id: string;
        author_kind: string;
        author_id: string | null;
        reply_to: string | null;
        body: string;
        created_at: number;
        title: string | null;
      }[];
      // what helpers asked each other for the owner (a request's thread) is the owner's too (chat/view.ts)
      return (everyChat ? rows : rows.filter((r) => !inRequestThread({ replyTo: r.reply_to }, { db }))).map(
        (r): MessageSearchHit => ({
          messageId: r.id,
          chatId: r.chat_id,
          chatTitle: r.title ?? '',
          authorKind: r.author_kind,
          authorId: r.author_id,
          snippet: snippetOf(r.body, q.text),
          createdAt: r.created_at,
        }),
      );
    },
  };
}
