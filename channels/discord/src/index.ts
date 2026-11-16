/**
 * Discord channel (ARCHITECTURE 5.2): the Gateway WebSocket for inbound, the REST API for sending.
 * The bot token lives in the vault (`secretFields`); it is sent only in the Authorization header and the
 * Identify/Resume payloads, and never logged or put in an error.
 */
import type {
  ChannelAdapter,
  ChannelConnection,
  ChannelContext,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
  PlaceInfo,
} from '@pasabot/core';
import { safeFetch } from '@pasabot/safe-net';
import { z } from 'zod';
import { AsyncQueue, backoff, chunkText, sleep } from './util.js';

export const discordConfigSchema = z.object({
  botToken: z.string().min(50, 'not a Discord bot token').max(120),
  apiBase: z.url().default('https://discord.com/api/v10'),
  gatewayUrl: z.url().default('wss://gateway.discord.gg/?v=10&encoding=json'),
});
export type DiscordConfig = z.infer<typeof discordConfigSchema>;

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
/** The slice of the WHATWG WebSocket the adapter uses. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (e: any) => void): void;
}
export interface DiscordDeps {
  /** defaults to safeFetch (SSRF guard); tests inject fetch to reach a mock on 127.0.0.1 */
  fetch?: HttpFetch;
  /** defaults to the global WebSocket */
  socket?: (url: string) => GatewaySocket;
}

export const DISCORD_TEXT_MAX = 2000;
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged; enable it for the bot) */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
/** close codes after which reconnecting cannot help */
const FATAL_CLOSE = new Map<number, string>([
  [4004, 'authentication failed'],
  [4010, 'invalid shard'],
  [4011, 'sharding required'],
  [4012, 'invalid API version'],
  [4013, 'invalid intents'],
  [4014, 'disallowed intents (enable Message Content for the bot)'],
]);

export class DiscordAuthError extends Error {
  constructor(why = 'bot token rejected') {
    super(`discord: auth failed (${why})`);
  }
}
class DiscordApiError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
  ) {
    super(`discord: ${route} failed (${status})`);
  }
}

// ---------- API shapes (only what we read) ----------
interface DUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
export interface DMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DUser;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  mentions?: { id: string }[];
  attachments?: { url: string; filename: string; content_type?: string; size?: number }[];
  message_reference?: { message_id?: string };
  referenced_message?: { author?: { id: string } } | null;
}
interface DChannel {
  id: string;
  type: number;
  name?: string;
  recipients?: DUser[];
}

const displayName = (m: DMessage) => m.member?.nick || m.author.global_name || m.author.username;
// 1 = DM, 3 = group DM; guild text (0), announcement (5) and threads (10-12) are group conversations
const placeKind = (type: number): PlaceInfo['kind'] => (type === 1 ? 'dm' : 'group');
const TEXT_TYPES = new Set([0, 1, 3, 5, 10, 11, 12]);

/** Map one MESSAGE_CREATE payload to an InboundMessage (exported for unit tests). */
export function mapDiscordMessage(m: DMessage, botId: string): InboundMessage {
  const dm = !m.guild_id;
  const mentioned = (m.mentions ?? []).some((u) => u.id === botId);
  const repliedToBot = m.referenced_message?.author?.id === botId;
  return {
    externalId: m.id, // snowflakes are globally unique
    placeId: m.channel_id,
    sender: { externalId: m.author.id, name: displayName(m), isBot: Boolean(m.author.bot) },
    text: m.content,
    attachments: (m.attachments ?? []).map((a) => ({
      url: a.url,
      name: a.filename,
      ...(a.content_type ? { mime: a.content_type } : {}),
      ...(a.size !== undefined ? { size: a.size } : {}),
    })),
    ...(m.message_reference?.message_id ? { replyToExternalId: m.message_reference.message_id } : {}),
    mentionsBot: dm || mentioned || repliedToBot,
    at: Date.parse(m.timestamp) || Date.now(),
  };
}

export function createDiscordAdapter(deps: DiscordDeps = {}): ChannelAdapter<DiscordConfig> {
  const http: HttpFetch = deps.fetch ?? ((url, init) => safeFetch(url, init));
  const socket = deps.socket ?? ((url: string) => new WebSocket(url) as unknown as GatewaySocket);
  return {
    kind: 'discord',
    configSchema: discordConfigSchema,
    secretFields: ['botToken'],
    async connect(cfg, ctx) {
      return connectDiscord(cfg, ctx, http, socket);
    },
  };
}

async function connectDiscord(
  cfg: DiscordConfig,
  ctx: ChannelContext,
  http: HttpFetch,
  openSocket: (url: string) => GatewaySocket,
): Promise<ChannelConnection> {
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const api = cfg.apiBase.replace(/\/+$/, '');

  async function rest<T>(method: string, route: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await http(api + route, {
        method,
        headers: {
          authorization: `Bot ${cfg.botToken}`,
          'content-type': 'application/json',
          'user-agent': 'DiscordBot (https://pasabot.invalid, 0.0.0)',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: stop.signal,
        timeoutMs: 30_000,
      });
      if (res.status === 401) throw new DiscordAuthError();
      if (res.status === 429 && attempt < 3) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.min(j.retry_after ?? 1, 60) * 1000, stop.signal);
        continue;
      }
      if (!res.ok) throw new DiscordApiError(`${method} ${route.replace(/\d{15,}/g, ':id')}`, res.status);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  const me = await rest<DUser>('GET', '/users/@me'); // throws DiscordAuthError on a rejected token
  const log = ctx.log.child({ channel: 'discord', binding: ctx.bindingId, bot: me.username });
  let status: ChannelStatus = 'reconnecting';
  const queue = new AsyncQueue<InboundMessage>();
  const places = new Map<string, PlaceInfo>();

  let ws: GatewaySocket | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let failures = 0;

  const stopHeartbeat = () => {
    clearTimeout(heartbeat);
    clearInterval(heartbeat);
  };
  const finish = (s: ChannelStatus) => {
    if (status === 'stopped' || status === 'auth_failed') return;
    status = s;
    stopHeartbeat();
    ws?.close(1000);
    ws = null;
    stop.abort();
    queue.end();
    ctx.signal.removeEventListener('abort', onAbort);
  };
  stop.signal.addEventListener('abort', () => finish('stopped'), { once: true });

  const send = (op: number, d: unknown) => ws?.send(JSON.stringify({ op, d }));
  const identify = () =>
    send(2, {
      token: cfg.botToken,
      intents: DISCORD_INTENTS,
      properties: { os: process.platform, browser: 'pasabot', device: 'pasabot' },
    });

  function onDispatch(t: string, d: any) {
    if (t === 'READY') {
      sessionId = d.session_id;
      // only follow a resume URL on the same scheme as the configured gateway
      const r = typeof d.resume_gateway_url === 'string' ? d.resume_gateway_url : null;
      resumeUrl = r && new URL(r).protocol === new URL(cfg.gatewayUrl).protocol ? r : null;
      for (const c of (d.private_channels ?? []) as DChannel[]) rememberChannel(c);
      status = 'connected';
      failures = 0;
    } else if (t === 'RESUMED') {
      status = 'connected';
      failures = 0;
    } else if (t === 'GUILD_CREATE') {
      for (const c of (d.channels ?? []) as DChannel[]) rememberChannel(c);
      for (const c of (d.threads ?? []) as DChannel[]) rememberChannel(c);
    } else if (t === 'CHANNEL_CREATE' || t === 'THREAD_CREATE') {
      rememberChannel(d);
    } else if (t === 'MESSAGE_CREATE') {
      const m = d as DMessage;
      if (m.author.id === me.id) return; // our own sends echo back on the gateway
      if (!places.has(m.channel_id))
        places.set(m.channel_id, {
          id: m.channel_id,
          title: m.guild_id ? m.channel_id : displayName(m),
          kind: m.guild_id ? 'group' : 'dm',
        });
      queue.push(mapDiscordMessage(m, me.id));
    }
  }
  function rememberChannel(c: DChannel) {
    if (!TEXT_TYPES.has(c.type)) return;
    const title = c.name ?? c.recipients?.map((u) => u.global_name || u.username).join(', ') ?? c.id;
    places.set(c.id, { id: c.id, title, kind: placeKind(c.type) });
  }

  /** Forget a socket and schedule a resume; never waits for a close event a dead link may never deliver. */
  function reconnect(sock: GatewaySocket) {
    if (ws !== sock) return;
    ws = null;
    stopHeartbeat();
    if (stop.signal.aborted) return;
    status = 'reconnecting';
    failures++;
    sleep(failures === 1 ? 250 : backoff(failures - 1), stop.signal).then(open, () => {});
  }

  function open() {
    if (stop.signal.aborted) return;
    const resuming = Boolean(sessionId && resumeUrl);
    const url = resuming
      ? `${resumeUrl}${resumeUrl!.includes('?') ? '' : '/?v=10&encoding=json'}`
      : cfg.gatewayUrl;
    const sock = openSocket(url);
    ws = sock;
    // false while a heartbeat we sent has had no ACK (op 11); a second beat without one = zombied link
    let acked = true;
    sock.addEventListener('message', (ev) => {
      if (ws !== sock) return;
      let f: { op: number; d: any; s?: number | null; t?: string | null };
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof f.s === 'number') seq = f.s;
      switch (f.op) {
        case 10: {
          const every: number = f.d.heartbeat_interval;
          const beat = () => {
            if (ws !== sock) return;
            if (!acked) {
              log.warn('gateway heartbeat not acknowledged; reconnecting');
              // 4000 (not 1000/1001) keeps the session resumable
              try {
                sock.close(4000);
              } catch {}
              reconnect(sock);
              return;
            }
            acked = false;
            send(1, seq);
          };
          stopHeartbeat();
          acked = true;
          // first beat after interval * jitter, as the gateway docs ask, then every interval
          heartbeat = setTimeout(() => {
            beat();
            if (ws === sock) heartbeat = setInterval(beat, every);
          }, every * Math.random());
          if (resuming) send(6, { token: cfg.botToken, session_id: sessionId, seq });
          else identify();
          break;
        }
        case 1:
          send(1, seq);
          break;
        case 11:
          acked = true;
          break;
        case 0:
          if (f.t) onDispatch(f.t, f.d);
          break;
        case 7: // server asks us to reconnect (and resume)
          sock.close(4000);
          break;
        case 9: // invalid session: d = resumable?
          if (!f.d) {
            sessionId = null;
            seq = null;
          }
          sock.close(4000);
          break;
      }
    });
    sock.addEventListener('close', (ev) => {
      if (ws !== sock) return;
      const fatal = FATAL_CLOSE.get(ev.code);
      if (fatal && !stop.signal.aborted) {
        ws = null;
        stopHeartbeat();
        log.error('gateway refused the bot; channel stopped', { code: ev.code, reason: fatal });
        finish('auth_failed');
        return;
      }
      reconnect(sock);
    });
    sock.addEventListener('error', () => {
      log.warn('gateway socket error', { failures });
    });
  }
  open();

  const msgPath = (placeId: string, id?: string) =>
    `/channels/${encodeURIComponent(placeId)}/messages${id ? `/${encodeURIComponent(id)}` : ''}`;
  const sendPart = async (placeId: string, content: string, replyTo: string | undefined) => {
    const sent = await rest<{ id: string }>('POST', msgPath(placeId), {
      content,
      // an agent's text never pings @everyone, roles or users
      allowed_mentions: { parse: [] },
      ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    });
    return sent.id;
  };
  const editPart = (placeId: string, id: string, content: string) =>
    rest('PATCH', msgPath(placeId, id), { content, allowed_mentions: { parse: [] } });
  // a reply edited into a placeholder may run past the limit: the rest goes out as follow-ups, remembered
  // per placeholder so a later edit (streaming, retry) updates them instead of posting duplicates
  const followUps = new Map<string, string[]>();

  return {
    inbound: queue,
    async send(placeId: string, msg: OutboundMessage) {
      if (msg.attachments?.length) log.warn('discord: outbound attachments are not sent yet (W7)');
      let first: string | undefined;
      for (const [i, content] of chunkText(msg.text, DISCORD_TEXT_MAX).entries()) {
        const id = await sendPart(placeId, content, i === 0 ? msg.replyToExternalId : undefined);
        first ??= id;
      }
      return { externalId: first! };
    },
    async edit(placeId: string, externalId: string, msg: OutboundMessage) {
      const [head, ...more] = chunkText(msg.text, DISCORD_TEXT_MAX);
      await editPart(placeId, externalId, head!);
      const prev = followUps.get(externalId) ?? [];
      const next: string[] = [];
      let complete = false;
      try {
        for (const [i, content] of more.entries()) {
          const id = prev[i];
          if (id) {
            await editPart(placeId, id, content);
            next.push(id);
          } else next.push(await sendPart(placeId, content, externalId));
        }
        // the reply got shorter: remove follow-ups it no longer needs
        for (const id of prev.slice(more.length))
          await rest('DELETE', msgPath(placeId, id)).catch((e) =>
            log.warn('discord: could not delete a stale follow-up', { error: String(e) }),
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
      await rest(
        'PUT',
        `/channels/${encodeURIComponent(placeId)}/messages/${encodeURIComponent(externalId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      );
    },
    // guild channels from GUILD_CREATE, DMs from READY and from inbound messages
    async listPlaces() {
      return [...places.values()];
    },
    status: () => status,
    async close() {
      finish('stopped');
    },
  };
}

export default createDiscordAdapter();
