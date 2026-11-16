/**
 * Telegram channel (ARCHITECTURE 5.2) over the Bot HTTP API with long polling (`getUpdates`), so it needs no
 * public URL. The bot token lives in the vault (`secretFields`) and is never logged or put in an error,
 * a RemoteFile url or a place id.
 */
import type {
  ChannelAdapter,
  ChannelConnection,
  ChannelContext,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
  PlaceInfo,
  RemoteFile,
} from '@pasabot/core';
import { safeFetch } from '@pasabot/safe-net';
import { z } from 'zod';
import { AsyncQueue, backoff, chunkText, sleep } from './util.js';

export const telegramConfigSchema = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'not a Telegram bot token'),
  /** Bot API base; only change it for a self-hosted Bot API server */
  apiBase: z.url().default('https://api.telegram.org'),
  /** long-poll wait in seconds */
  pollTimeoutSec: z.number().int().min(0).max(50).default(25),
});
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<Response>;
export interface TelegramDeps {
  /** defaults to safeFetch (SSRF guard); tests inject fetch to reach a mock on 127.0.0.1 */
  fetch?: HttpFetch;
}

/** Telegram text limit per message. */
export const TELEGRAM_TEXT_MAX = 4096;

export class TelegramAuthError extends Error {
  constructor() {
    super('telegram: auth failed (bot token rejected)');
  }
}
class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`telegram: ${method} failed (${status}: ${description})`);
  }
}

// ---------- Bot API shapes (only what we read) ----------
interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}
interface TgFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: { message_id: number; from?: TgUser };
  photo?: (TgFile & { width: number })[];
  document?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
  video?: TgFile;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const userName = (u: { first_name?: string; last_name?: string; username?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
const placeKind = (t: TgChat['type']): PlaceInfo['kind'] =>
  t === 'private' ? 'dm' : t === 'channel' ? 'channel' : 'group';

/** `externalId` is `<chatId>:<messageId>`: Telegram message ids are only unique inside one chat. */
export const tgExternalId = (chatId: number | string, messageId: number) => `${chatId}:${messageId}`;
function parseExternalId(externalId: string): { chatId: string; messageId: number } {
  const i = externalId.lastIndexOf(':');
  const messageId = Number(externalId.slice(i + 1));
  if (i <= 0 || !Number.isInteger(messageId)) throw new Error('telegram: bad message id');
  return { chatId: externalId.slice(0, i), messageId };
}

function attachments(m: TgMessage): RemoteFile[] {
  // a file reference, never the token-bearing download URL; fetching needs getFile (W7 attachments)
  const ref = (f: TgFile, name: string): RemoteFile => ({
    url: `telegram-file:${f.file_id}`,
    name: f.file_name ?? name,
    ...(f.mime_type ? { mime: f.mime_type } : {}),
    ...(f.file_size ? { size: f.file_size } : {}),
  });
  const out: RemoteFile[] = [];
  if (m.photo?.length) {
    const big = [...m.photo].sort((a, b) => b.width - a.width)[0]!;
    out.push({ ...ref(big, 'photo.jpg'), mime: 'image/jpeg' });
  }
  if (m.document) out.push(ref(m.document, 'file'));
  if (m.audio) out.push(ref(m.audio, 'audio'));
  if (m.voice) out.push(ref(m.voice, 'voice.ogg'));
  if (m.video) out.push(ref(m.video, 'video.mp4'));
  return out;
}

/** Map one Bot API message to an InboundMessage (exported for unit tests). */
export function mapTelegramMessage(
  m: TgMessage,
  bot: { id: number; username: string },
): InboundMessage | null {
  if (!m.from) return null; // anonymous group admins / channel posts carry no immutable user id
  const text = m.text ?? m.caption ?? '';
  const entities = m.entities ?? m.caption_entities ?? [];
  const handle = `@${bot.username}`.toLowerCase();
  const mentioned = entities.some((e) => {
    // Bot API offsets are UTF-16 code units, the same as JS string indexes
    const s = text.slice(e.offset, e.offset + e.length);
    if (e.type === 'mention') return s.toLowerCase() === handle;
    if (e.type === 'text_mention') return e.user?.id === bot.id;
    if (e.type === 'bot_command') return s.toLowerCase().endsWith(handle);
    return false;
  });
  const repliedToBot = m.reply_to_message?.from?.id === bot.id;
  return {
    externalId: tgExternalId(m.chat.id, m.message_id),
    placeId: String(m.chat.id),
    sender: { externalId: String(m.from.id), name: userName(m.from), isBot: m.from.is_bot },
    text,
    attachments: attachments(m),
    ...(m.reply_to_message
      ? { replyToExternalId: tgExternalId(m.chat.id, m.reply_to_message.message_id) }
      : {}),
    mentionsBot: m.chat.type === 'private' || mentioned || repliedToBot,
    at: m.date * 1000,
  };
}

export function createTelegramAdapter(deps: TelegramDeps = {}): ChannelAdapter<TelegramConfig> {
  const http: HttpFetch = deps.fetch ?? ((url, init) => safeFetch(url, init));
  return {
    kind: 'telegram',
    configSchema: telegramConfigSchema,
    secretFields: ['botToken'],
    async connect(cfg, ctx) {
      return connectTelegram(cfg, ctx, http);
    },
  };
}

async function connectTelegram(
  cfg: TelegramConfig,
  ctx: ChannelContext,
  http: HttpFetch,
): Promise<ChannelConnection> {
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const base = `${cfg.apiBase.replace(/\/+$/, '')}/bot${cfg.botToken}/`;

  async function call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await http(base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: stop.signal,
        timeoutMs,
      });
      if (res.status === 401 || res.status === 404) throw new TelegramAuthError();
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: T;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (body.ok) return body.result as T;
      const retryAfter = body.parameters?.retry_after;
      if (res.status === 429 && retryAfter !== undefined && attempt < 3) {
        await sleep(Math.min(retryAfter, 60) * 1000, stop.signal);
        continue;
      }
      throw new TelegramApiError(method, res.status, body.description ?? 'error', retryAfter);
    }
  }

  const me = await call<TgUser>('getMe'); // throws TelegramAuthError on a rejected token
  if (!me.username) throw new Error('telegram: bot account has no username');
  const bot = { id: me.id, username: me.username };
  const log = ctx.log.child({ channel: 'telegram', binding: ctx.bindingId, bot: bot.username });
  let status: ChannelStatus = 'connected';
  const queue = new AsyncQueue<InboundMessage>();
  const places = new Map<string, PlaceInfo>();

  const finish = (s: ChannelStatus) => {
    if (status === 'stopped' || status === 'auth_failed') return;
    status = s;
    stop.abort();
    queue.end();
    ctx.signal.removeEventListener('abort', onAbort);
  };
  stop.signal.addEventListener('abort', () => finish('stopped'), { once: true });

  // long-poll loop; unconfirmed updates are redelivered after a restart and dedupe on the queue idem key
  void (async () => {
    let offset: number | undefined;
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const updates = await call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: cfg.pollTimeoutSec, allowed_updates: ['message'] },
          (cfg.pollTimeoutSec + 15) * 1000,
        );
        if (status === 'reconnecting') status = 'connected';
        failures = 0;
        for (const u of updates) {
          offset = u.update_id + 1;
          if (!u.message) continue;
          const c = u.message.chat;
          places.set(String(c.id), {
            id: String(c.id),
            title: c.title ?? userName(c),
            kind: placeKind(c.type),
          });
          const m = mapTelegramMessage(u.message, bot);
          if (m) queue.push(m);
        }
      } catch (e) {
        if (stop.signal.aborted) break;
        if (e instanceof TelegramAuthError) {
          log.error('bot token rejected; channel stopped');
          finish('auth_failed');
          break;
        }
        status = 'reconnecting';
        failures++;
        // 409 = a webhook is set or another poller holds the bot; keep retrying slowly
        log.warn('telegram poll failed', { error: e instanceof Error ? e.message : String(e), failures });
        await sleep(backoff(failures), stop.signal).catch(() => {});
      }
    }
  })();

  // a reply edited into a placeholder may run past the limit: the rest goes out as follow-ups, remembered
  // per placeholder so a later edit (streaming, retry) updates them instead of posting duplicates
  const followUps = new Map<string, string[]>();
  const sendPart = async (placeId: string, text: string, replyTo: { messageId: number } | null) => {
    const sent = await call<TgMessage>('sendMessage', {
      chat_id: placeId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyTo
        ? { reply_parameters: { message_id: replyTo.messageId, allow_sending_without_reply: true } }
        : {}),
    });
    return tgExternalId(sent.chat.id, sent.message_id);
  };
  const editPart = async (placeId: string, externalId: string, text: string) => {
    try {
      await call('editMessageText', {
        chat_id: placeId,
        message_id: parseExternalId(externalId).messageId,
        text,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      if (e instanceof TelegramApiError && /not modified/i.test(e.description)) return;
      throw e;
    }
  };

  return {
    inbound: queue,
    async send(placeId: string, msg: OutboundMessage) {
      if (msg.attachments?.length) log.warn('telegram: outbound attachments are not sent yet (W7)');
      const parts = chunkText(msg.text, TELEGRAM_TEXT_MAX);
      let first: string | undefined;
      for (const [i, text] of parts.entries()) {
        const reply = i === 0 && msg.replyToExternalId ? parseExternalId(msg.replyToExternalId) : null;
        const id = await sendPart(placeId, text, reply);
        first ??= id;
      }
      return { externalId: first! };
    },
    async edit(placeId: string, externalId: string, msg: OutboundMessage) {
      const anchor = parseExternalId(externalId);
      const [head, ...rest] = chunkText(msg.text, TELEGRAM_TEXT_MAX);
      await editPart(placeId, externalId, head!);
      const prev = followUps.get(externalId) ?? [];
      const next: string[] = [];
      let complete = false;
      try {
        for (const [i, text] of rest.entries()) {
          const id = prev[i];
          if (id) {
            await editPart(placeId, id, text);
            next.push(id);
          } else next.push(await sendPart(placeId, text, anchor));
        }
        // the reply got shorter: remove follow-ups it no longer needs
        for (const id of prev.slice(rest.length))
          await call('deleteMessage', { chat_id: placeId, message_id: parseExternalId(id).messageId }).catch(
            (e) => log.warn('telegram: could not delete a stale follow-up', { error: String(e) }),
          );
        complete = true;
      } finally {
        // on a failure keep the follow-ups not reached yet, so a retry edits them instead of duplicating
        const keep = complete ? next : [...next, ...prev.slice(next.length)];
        followUps.delete(externalId);
        if (keep.length) {
          followUps.set(externalId, keep);
          if (followUps.size > 500) followUps.delete(followUps.keys().next().value!);
        }
      }
    },
    async react(placeId: string, externalId: string, emoji: string) {
      const { messageId } = parseExternalId(externalId);
      await call('setMessageReaction', {
        chat_id: placeId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      });
    },
    // the Bot API cannot list chats; these are the places the bot has seen since connecting
    async listPlaces() {
      return [...places.values()];
    },
    status: () => status,
    async close() {
      finish('stopped');
    },
  };
}

export default createTelegramAdapter();
