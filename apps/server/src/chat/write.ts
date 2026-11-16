/** Who may act in a chat (post a message, answer a card): one rule for the core routes and the ChatPort. */
import type { Sqlite } from '@pasabot/db';

export type ChatActor = { userId: string; userKind: 'owner' | 'member' | 'guest' };

/** Owners see every chat; everyone else only chats where they are a member. */
export function canReadChatAs(db: Sqlite, u: ChatActor, chatId: string): boolean {
  if (u.userKind === 'owner') return !!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId);
  return !!db
    .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
    .get(chatId, u.userId);
}

/**
 * Readers who may also write: owners always; anyone else needs a `chat_members` row whose role is not `observer`
 * (observers are read-only; modules may refuse guests on top).
 */
export function canWriteChat(db: Sqlite, u: ChatActor, chatId: string): boolean {
  if (!canReadChatAs(db, u, chatId)) return false;
  if (u.userKind === 'owner') return true;
  const role = db
    .prepare("SELECT role FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
    .get(chatId, u.userId) as { role: string } | undefined;
  return !!role && role.role !== 'observer';
}
