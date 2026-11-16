/**
 * What a message looks like to the person (or app) reading it: the ONE serialiser every path that lets a message
 * leave the server goes through (REST lists, search, the live socket, chat apps, module routes, linked machines).
 *
 * Deny by default: the owner gets everything; anyone else (a member, a guest, a helper's token, a chat app, a linked
 * machine) gets only the block kinds in `SHARED_BLOCK_KINDS` (conversation a helper shows the chat) and, on the
 * socket, only the event types in `SHARED_EVENT_TYPES`. Every other block kind is the owner's: cards (`core.card`),
 * approvals (`core.approval`: tool, arguments, previews, nonce, decider), budget alerts, screen helper cards, setup
 * guides, provider notices, a module's own kind that is not on the list. For anyone else:
 * - an approval's message: one neutral plain line, "<Helper> is waiting for the owner’s OK." and later "<Helper> got
 *   the OK." / "<Helper> was not allowed.", with no blocks, no tool, no arguments, no preview and no nonce;
 * - a helper's reply that failed (it carries a card, or the raw error before the card): one neutral plain line, "<Helper> couldn't finish this
 *   reply.", with no blocks, no buttons, no brain name and no details;
 * - a file a helper handed to the chat (a `result` card): its plain words only, never the card;
 * - a person's message: its words, without any owner-only block;
 * - any other message that carries an owner-only block and nothing shared (an owner notice): nothing at all;
 * - a request one helper gave another (collab `collab.thread` / `collab.task`) and everything in its thread: nothing
 *   at all (what helpers ask each other for the owner is the owner's); the server's own report card: its words only.
 * An approval itself (`ApprovalDTO`, wherever it sits in a payload) never reaches anyone but the owner.
 */
import type { ServerI18n } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { MessageBlock, MessageDTO } from '@pasabot/protocol';
import { isSharedBlockKind, sharedBlockKinds } from '../core/shared-blocks.js';

const CARD_KIND = 'core.card';
const APPROVAL_KIND = 'core.approval';
/** a helper's report of what other helpers answered (collab): its words are conversation, the answers the owner's */
const REPORT_KIND = 'collab.report';
/** a request one helper gave another (collab): who asked whom, and the task behind it; either marks a thread's root */
const THREAD_KINDS = new Set(['collab.thread', 'collab.task']);

export { SHARED_BLOCK_KINDS } from '../core/shared-blocks.js';

/**
 * The socket event types anyone but the owner may get (on the topics they may open: `global` and their chats'),
 * their data through `viewPayload`. Approvals (`approval.requested` / `approval.resolved`), notifications, runs,
 * cards, frames and any module event not listed are the owner's.
 */
export const SHARED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.created',
  'message.updated',
  'message.deleted',
  'message.delta',
  'chat.created',
  'agent.updated',
  'reaction.changed',
  'richchat.answered',
  'provider-ops.context',
]);
/** SQL (column `col`): the message carries no block outside `SHARED_BLOCK_KINDS` */
export const sharedBlocksOnlySql = (col = 'messages.blocks') =>
  `NOT EXISTS (SELECT 1 FROM json_each(${col}) j WHERE json_extract(j.value, '$.kind') NOT IN (${sharedBlockKinds()
    .map((k) => `'${k}'`)
    .join(', ')}))`;
/** SQL: the message carries no approval block (an approval is the owner's UI, never conversation a helper reads back) */
export const NO_APPROVAL = `NOT EXISTS (SELECT 1 FROM json_each(messages.blocks) j WHERE json_extract(j.value, '$.kind') = '${APPROVAL_KIND}')`;

/** Who reads: a signed-in person's kind (`owner` | `member` | `guest`), or anything else (an app, a token). */
export interface MessageViewer {
  kind: string;
  userId?: string | null;
}
export interface MessageViewDeps {
  db: Sqlite;
  i18n?: ServerI18n;
}

export const OWNER_VIEWER: MessageViewer = { kind: 'owner' };
export const viewerIsOwner = (v: MessageViewer | null | undefined): boolean => v?.kind === 'owner';

const isBlock = (b: unknown): b is { kind: string; data?: unknown } =>
  !!b && typeof b === 'object' && typeof (b as { kind?: unknown }).kind === 'string';
const isCard = (b: unknown) => isBlock(b) && b.kind === CARD_KIND;
const isShared = (b: unknown) => isBlock(b) && isSharedBlockKind(b.kind);

/** the message carries a card block */
export const hasCard = (m: { blocks?: unknown } | null | undefined): boolean =>
  !!m && Array.isArray(m.blocks) && m.blocks.some(isCard);

/** a helper's reply (a run's message) that carries the owner's card: the failed reply */
export const isCardReply = (m: Pick<MessageDTO, 'authorKind' | 'runId' | 'blocks'>): boolean =>
  m.authorKind === 'agent' && !!m.runId && hasCard(m);
/**
 * A helper's reply that failed: it carries the owner's card, or it is the error itself (the raw reason is in its
 * body for a moment, until the card replaces it). Only the owner reads why.
 */
export const isFailedReply = (m: Pick<MessageDTO, 'authorKind' | 'runId' | 'blocks' | 'status'>): boolean =>
  m.authorKind === 'agent' && !!m.runId && (m.status === 'error' || hasCard(m));
/** the message carries a block only the owner may get */
const hasOwnerBlock = (m: { blocks?: unknown }) =>
  Array.isArray(m.blocks) && m.blocks.some((b) => !isShared(b));
/** the message reads differently to the owner and to anyone else */
export const ownerOnlyParts = (m: Pick<MessageDTO, 'authorKind' | 'runId' | 'blocks' | 'status'>): boolean =>
  hasOwnerBlock(m) || isFailedReply(m);

const cardOf = (m: { blocks: unknown[] }) =>
  (m.blocks.find(isCard) as { data?: { variant?: string } } | undefined)?.data;
const approvalOf = (m: { blocks: unknown[] }) =>
  (
    m.blocks.find((b) => isBlock(b) && b.kind === APPROVAL_KIND) as
      | { data?: { agentId?: unknown; state?: unknown } }
      | undefined
  )?.data;

const agentName = (d: MessageViewDeps, id: unknown): string => {
  const r =
    typeof id === 'string' && id
      ? (d.db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined)
      : undefined;
  return r?.name || 'The helper';
};
const languageOf = (viewer: MessageViewer, d: MessageViewDeps) =>
  viewer.userId && d.i18n ? d.i18n.language(viewer.userId) : undefined;

/** the neutral line a non-owner sees for a failed reply, in the reader's language */
function failedLine(m: MessageDTO, viewer: MessageViewer, d: MessageViewDeps): string {
  const name = agentName(d, m.authorId);
  if (!d.i18n) return `${name} couldn’t finish this reply.`;
  return d.i18n.t('core:card.member.failed', { name }, languageOf(viewer, d));
}

const APPROVAL_LINES = {
  waiting: (name: string) => `${name} is waiting for the owner’s OK.`,
  approved: (name: string) => `${name} got the OK.`,
  refused: (name: string) => `${name} was not allowed.`,
};
/**
 * The neutral line anyone but the owner sees for an approval, in the reader's language: who waits, and later
 * whether it went ahead; never what for.
 */
export function approvalLine(
  a: { agentId?: unknown; state?: unknown },
  viewer: MessageViewer,
  d: MessageViewDeps,
): string {
  const name = agentName(d, a.agentId);
  const which = a.state === 'approved' ? 'approved' : a.state === 'pending' ? 'waiting' : 'refused';
  if (!d.i18n) return APPROVAL_LINES[which](name);
  const key = { waiting: 'approvalWaiting', approved: 'approvalApproved', refused: 'approvalRefused' }[which];
  return d.i18n.t(`core:card.member.${key}`, { name }, languageOf(viewer, d));
}

/**
 * The message as `viewer` may see it, or null when they may not see it at all (an owner notice). The owner gets the
 * message unchanged; a message with shared blocks only (or none) is the same for every reader.
 */
export function viewMessage(m: MessageDTO, viewer: MessageViewer, d: MessageViewDeps): MessageDTO | null {
  if (viewerIsOwner(viewer)) return m;
  // a request one helper gave another, and everything said in its thread, is the owner's (requests go to a chat
  // only the owner reads; this keeps them the owner's when the owner shares that chat with people later)
  if (isThreadRequest(m) || inRequestThread(m, d)) return null;
  if (!ownerOnlyParts(m)) return m;
  if (isFailedReply(m)) return { ...m, body: failedLine(m, viewer, d), blocks: [] };
  const apv = approvalOf(m);
  if (apv) return { ...m, body: approvalLine(apv, viewer, d), blocks: [] };
  const kept = (m.blocks as MessageBlock[]).filter(isShared);
  // a helper's file (a `result` card), a person's own words, a helper's report of other helpers' answers (its words,
  // never the full answers: `collab.report` is the owner's), or a helper's reply with something shared: without the
  // owner's blocks
  if (
    cardOf(m)?.variant === 'result' ||
    m.authorKind === 'user' ||
    m.authorKind === 'external' ||
    ((m.authorKind === 'agent' || m.authorKind === 'system') &&
      (m.blocks as MessageBlock[]).some((b) => isBlock(b) && b.kind === REPORT_KIND)) ||
    kept.length
  )
    return { ...m, blocks: kept };
  return null;
}

const isThreadRequest = (m: { blocks?: unknown }) =>
  Array.isArray(m.blocks) && m.blocks.some((b) => isBlock(b) && THREAD_KINDS.has(b.kind));
/** the message answers (directly, or a few replies down) a request of a helper thread */
export function inRequestThread(m: Pick<MessageDTO, 'replyTo'>, d: Pick<MessageViewDeps, 'db'>): boolean {
  const q = d.db.prepare(
    `SELECT reply_to, EXISTS (SELECT 1 FROM json_each(blocks) j WHERE json_extract(j.value, '$.kind') IN (${[
      ...THREAD_KINDS,
    ]
      .map((k) => `'${k}'`)
      .join(', ')})) AS req
     FROM messages WHERE id = ?`,
  );
  let at = m.replyTo;
  for (let n = 0; at && n < 8; n++) {
    const r = q.get(at) as { reply_to: string | null; req: number } | undefined;
    if (!r) return false;
    if (r.req) return true;
    at = r.reply_to;
  }
  return false;
}

/** `viewMessage` over a list (owner notices left out) */
export function viewMessages(ms: MessageDTO[], viewer: MessageViewer, d: MessageViewDeps): MessageDTO[] {
  if (viewerIsOwner(viewer)) return ms;
  const out: MessageDTO[] = [];
  for (const m of ms) {
    const v = viewMessage(m, viewer, d);
    if (v) out.push(v);
  }
  return out;
}

const looksLikeMessage = (x: Record<string, unknown>): x is MessageDTO & Record<string, unknown> =>
  typeof x.id === 'string' &&
  typeof x.chatId === 'string' &&
  typeof x.authorKind === 'string' &&
  Array.isArray(x.blocks);
/** an approval (`ApprovalDTO`): the tool, its arguments, the card's nonce, who decided */
const looksLikeApproval = (x: Record<string, unknown>): boolean =>
  typeof x.id === 'string' &&
  typeof x.tier === 'number' &&
  typeof x.state === 'string' &&
  typeof x.expiresAt === 'number' &&
  'action' in x;

/** `DROP`: the value must not reach the viewer at all */
export const DROP: unique symbol = Symbol('drop');

/**
 * Any payload (a REST body, a socket event's data) as `viewer` may see it: every message inside goes through
 * `viewMessage` (left out of lists, `null` as a field), an approval anywhere is left out the same way, and any other
 * `blocks` list keeps only shared blocks. The payload itself is DROP when it is a message the viewer may not see or
 * an approval. The owner gets the payload unchanged.
 */
export function viewPayload(value: unknown, viewer: MessageViewer, d: MessageViewDeps): unknown {
  if (viewerIsOwner(viewer)) return value;
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 64) return DROP; // fail closed: never an unread owner part
    if (!x || typeof x !== 'object') return x;
    if (Array.isArray(x)) {
      const out: unknown[] = [];
      for (const it of x) {
        const v = walk(it, depth + 1);
        if (v !== DROP) out.push(v);
      }
      return out;
    }
    const o = x as Record<string, unknown>;
    if (looksLikeApproval(o)) return DROP;
    if (looksLikeMessage(o)) {
      const v = viewMessage(o, viewer, d);
      return v ? walkFields(v as unknown as Record<string, unknown>, depth) : DROP;
    }
    return walkFields(o, depth);
  };
  const walkFields = (o: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'blocks' && Array.isArray(v)) {
        out[k] = v.filter((b) => !isBlock(b) || isShared(b)).map((b) => walk(b, depth + 1));
        continue;
      }
      const w = walk(v, depth + 1);
      out[k] = w === DROP ? null : w;
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * A socket event as `viewer` may see it: the owner gets every event; anyone else only `SHARED_EVENT_TYPES`, their
 * data through `viewPayload`. DROP when it must not reach them.
 */
export function viewEvent(type: string, data: unknown, viewer: MessageViewer, d: MessageViewDeps): unknown {
  if (viewerIsOwner(viewer)) return data;
  if (!SHARED_EVENT_TYPES.has(type)) return DROP;
  return viewPayload(data, viewer, d);
}
