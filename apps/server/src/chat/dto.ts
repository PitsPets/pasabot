/** Row -> DTO mapping for core messages (shared by the chat routes and the ChatPort). */
import type { CoreDatabase } from '@pasabot/db';
import type { MessageDTO } from '@pasabot/protocol';

export const toMessageDTO = (r: CoreDatabase['messages'] | Record<string, any>): MessageDTO => ({
  id: r.id,
  chatId: r.chat_id,
  authorKind: r.author_kind,
  authorId: r.author_id,
  replyTo: r.reply_to,
  body: r.body,
  blocks: JSON.parse(r.blocks),
  status: r.status,
  runId: r.run_id,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});
