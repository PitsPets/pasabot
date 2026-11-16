/**
 * Slack `ChannelAdapter` (ARCHITECTURE 5.2) over the Events API (HTTP push) and the Web API. Inbound events reach
 * the binding at `/hooks/channels/<bindingId>/events`; every request is checked against the app's signing secret
 * (HMAC-SHA256 over `v0:<timestamp>:<raw body>`, 5-minute window) before anything is read from it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelConnection,
  ChannelContext,
  ChannelHttpRequest,
  ChannelHttpResponse,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
  PlaceInfo,
} from '@pasabot/core';
import { safeFetch } from '@pasabot/safe-net';
import { z } from 'zod';
import { AsyncQueue, sleep } from './util.js';

export const slackConfigSchema = z.object({
  /** bot user OAuth token */
  botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,}$/, 'not a Slack bot token (xoxb-…)'),
  /** the app's signing secret (Basic Information → App Credentials) */
  signingSecret: z.string().regex(/^[A-Za-z0-9]{16,128}$/, 'not a Slack signing secret'),
  /** Web API base; only change it for tests */
  apiBase: z.url().default('https://slack.com/api'),
});
export type SlackConfig = z.infer<typeof slackConfigSchema>;

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;
export interface SlackDeps {
  /** defaults to safeFetch (SSRF guard); tests inject fetch to reach a mock on 127.0.0.1 */
  fetch?: HttpFetch;
  /** clock for the signature window (tests) */
  now?: () => number;
  /** observer for new connections (tests deliver signed events through it) */
  onConnection?(bindingId: string, conn: ChannelConnection): void;
}

/** Slack's recommended max text per message. */
export const SLACK_TEXT_MAX = 4000;

/**
 * Slack reads `<!channel>`, `<!here>`, `<@U…>` and `<url|label>` in message text as live mentions and masked
 * links. An agent's text (which may quote injected input) is sent as plain text: `&`, `<` and `>` are escaped,
 * so it never pings a channel or a person and never shows a link under a spoofed label.
 */
export const escapeSlackText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Escaped chunks of at most `max` characters; a cut never splits an `&amp;` / `&lt;` / `&gt;` entity. */
export function slackTextParts(text: string, max = SLACK_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = escapeSlackText(text.length ? text : '…');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) {
      cut = max;
      const amp = rest.lastIndexOf('&', cut - 1);
      if (amp >= 0 && rest.indexOf(';', amp) >= cut) cut = amp;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}
/** Requests older (or newer) than this are refused, so a captured request cannot be replayed later. */
export const SLACK_SIGNATURE_WINDOW_SEC = 300;
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
]);

const header = (h: ChannelHttpRequest['headers'], name: string) => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** True when the request carries a valid, fresh Slack signature for these exact bytes. */
export function verifySlackSignature(
  signingSecret: string,
  headers: ChannelHttpRequest['headers'],
  rawBody: Buffer,
  nowMs = Date.now(),
): boolean {
  const ts = header(headers, 'x-slack-request-timestamp');
  const sig = header(headers, 'x-slack-signature');
  if (!ts || !sig || !/^\d{1,12}$/.test(ts) || !sig.startsWith('v0=')) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > SLACK_SIGNATURE_WINDOW_SEC) return false;
  const mac = createHmac('sha256', signingSecret).update(`v0:${ts}:`).update(rawBody).digest('hex');
  const a = Buffer.from(`v0=${mac}`);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface SlackEvent {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  files?: { id: string; name?: string; mimetype?: string; size?: number }[];
}
/** Message subtypes that are a person (or bot) saying something; edits, deletes, joins etc. are not turns. */
const TURN_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'bot_message']);

export const slackPlaceKind = (channelType?: string): PlaceInfo['kind'] =>
  channelType === 'im' ? 'dm' : channelType === 'channel' ? 'channel' : 'group';

/**
 * Map one Events API event to an InboundMessage, or null when it is not a turn (our own message, an edit, a
 * join). `sender.externalId` is `<team>:<user>`: Slack user ids are only unique inside one workspace.
 */
export function mapSlackEvent(
  ev: SlackEvent,
  bot: { userId: string; teamId: string; botId?: string },
  names: Map<string, string> = new Map(),
): InboundMessage | null {
  if (ev.type !== 'message' && ev.type !== 'app_mention') return null;
  if (!TURN_SUBTYPES.has(ev.subtype) || !ev.channel || !ev.ts) return null;
  if (ev.user === bot.userId || (bot.botId && ev.bot_id === bot.botId)) return null;
  const isBot = !!ev.bot_id || ev.subtype === 'bot_message';
  const who = ev.user ?? ev.bot_id;
  if (!who) return null;
  const team = ev.team ?? bot.teamId;
  const text = ev.text ?? '';
  const kind = slackPlaceKind(ev.channel_type);
  return {
    externalId: `${ev.channel}:${ev.ts}`,
    placeId: ev.channel,
    sender: { externalId: `${team}:${who}`, name: names.get(who) ?? who, isBot },
    text,
    attachments: (ev.files ?? []).map((f) => ({
      url: `slack-file:${f.id}`,
      name: f.name ?? f.id,
      ...(f.mimetype ? { mime: f.mimetype } : {}),
      ...(f.size ? { size: f.size } : {}),
    })),
    ...(ev.thread_ts && ev.thread_ts !== ev.ts ? { replyToExternalId: `${ev.channel}:${ev.thread_ts}` } : {}),
    mentionsBot: kind === 'dm' || ev.type === 'app_mention' || text.includes(`<@${bot.userId}>`),
    at: Math.round(Number(ev.ts) * 1000),
  };
}

const splitId = (externalId: string) => {
  const i = externalId.lastIndexOf(':');
  return { channel: externalId.slice(0, i), ts: externalId.slice(i + 1) };
};

export function createSlackAdapter(deps: SlackDeps = {}): ChannelAdapter<SlackConfig> {
  const http: HttpFetch = deps.fetch ?? ((url, init) => safeFetch(url, init));
  const now = deps.now ?? Date.now;
  return {
    kind: 'slack',
    configSchema: slackConfigSchema,
    secretFields: ['botToken', 'signingSecret'],
    inboundHttp: true,
    async connect(cfg: SlackConfig, ctx: ChannelContext): Promise<ChannelConnection> {
      let status: ChannelStatus = 'reconnecting';
      const inbound = new AsyncQueue<InboundMessage>();
      const places = new Map<string, PlaceInfo>();
      const names = new Map<string, string>();
      const seen = new Set<string>();
      const followUps = new Map<string, string[]>();
      let bot = { userId: '', teamId: '', botId: undefined as string | undefined };

      const call = async <T extends Record<string, unknown>>(
        method: string,
        body: Record<string, unknown>,
      ): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          const res = await http(`${cfg.apiBase}/${method}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${cfg.botToken}`,
              'content-type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify(body),
            signal: ctx.signal,
          });
          if (res.status === 429 && attempt < 3) {
            await sleep(Math.min(30, Number(res.headers.get('retry-after') ?? 1)) * 1000, ctx.signal);
            continue;
          }
          const j = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T & {
            ok: boolean;
            error?: string;
          };
          if (!j.ok) {
            const err = String(j.error ?? 'unknown_error');
            if (AUTH_ERRORS.has(err)) status = 'auth_failed';
            // the error code only: never the token or the request body
            throw new Error(`slack ${method}: ${err}`);
          }
          return j;
        }
      };

      const finish = (s: ChannelStatus) => {
        status = s;
        inbound.end();
      };
      ctx.signal.addEventListener('abort', () => finish('stopped'), { once: true });

      try {
        const who = await call<{ user_id: string; team_id: string; bot_id?: string }>('auth.test', {});
        bot = { userId: who.user_id, teamId: who.team_id, botId: who.bot_id };
        status = 'connected';
      } catch (e) {
        // `call` sets auth_failed on a rejected token (TS cannot see that through the closure)
        if ((status as ChannelStatus) !== 'auth_failed') throw e;
        inbound.end();
      }

      const nameOf = async (user: string) => {
        if (names.has(user)) return;
        try {
          const u = await call<{
            user: { real_name?: string; name?: string; profile?: { display_name?: string } };
          }>('users.info', { user });
          names.set(user, u.user.profile?.display_name || u.user.real_name || u.user.name || user);
        } catch {
          names.set(user, user);
        }
      };

      const post = async (channel: string, text: string, threadTs?: string) => {
        const r = await call<{ ts: string }>('chat.postMessage', {
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        return `${channel}:${r.ts}`;
      };

      const conn: ChannelConnection = {
        inbound,
        async handleHttp(req: ChannelHttpRequest): Promise<ChannelHttpResponse> {
          if (!verifySlackSignature(cfg.signingSecret, req.headers, req.rawBody, now()))
            return { status: 401, body: { error: 'bad_signature' } };
          let body: { type?: string; challenge?: string; team_id?: string; event?: SlackEvent };
          try {
            body = JSON.parse(req.rawBody.toString('utf8'));
          } catch {
            return { status: 400, body: { error: 'bad_json' } };
          }
          if (body.type === 'url_verification') return { status: 200, body: { challenge: body.challenge } };
          if (body.type !== 'event_callback' || !body.event) return { status: 200, body: { ok: true } };
          // another workspace's event (a shared app) is not this binding's
          if (body.team_id && bot.teamId && body.team_id !== bot.teamId)
            return { status: 200, body: { ok: true } };
          const ev = body.event;
          if (status !== 'connected') return { status: 200, body: { ok: true } };
          if (ev.user) await nameOf(ev.user);
          const msg = mapSlackEvent(ev, bot, names);
          // `message` and `app_mention` both arrive for one mention, and Slack retries slow answers: once only
          if (msg && !seen.has(msg.externalId)) {
            seen.add(msg.externalId);
            if (seen.size > 2000) seen.delete(seen.values().next().value!);
            const kind = slackPlaceKind(ev.channel_type);
            if (!places.has(msg.placeId))
              places.set(msg.placeId, {
                id: msg.placeId,
                title: kind === 'dm' ? msg.sender.name : `#${msg.placeId}`,
                kind,
              });
            inbound.push(msg);
          }
          return { status: 200, body: { ok: true } };
        },
        async send(placeId: string, msg: OutboundMessage) {
          const parts = slackTextParts(msg.text);
          const thread = msg.replyToExternalId ? splitId(msg.replyToExternalId) : null;
          const threadTs = thread && thread.channel === placeId ? thread.ts : undefined;
          const first = await post(placeId, parts[0]!, threadTs);
          for (const p of parts.slice(1)) await post(placeId, p, threadTs);
          return { externalId: first };
        },
        async edit(placeId: string, externalId: string, msg: OutboundMessage) {
          const parts = slackTextParts(msg.text);
          const { ts } = splitId(externalId);
          await call('chat.update', { channel: placeId, ts, text: parts[0] });
          const prev = followUps.get(externalId) ?? [];
          const next: string[] = [];
          for (const [i, p] of parts.slice(1).entries()) {
            const old = prev[i];
            if (old) {
              await call('chat.update', { channel: placeId, ts: splitId(old).ts, text: p });
              next.push(old);
            } else next.push(await post(placeId, p));
          }
          if (next.length) followUps.set(externalId, next);
          else followUps.delete(externalId);
          if (followUps.size > 500) followUps.delete(followUps.keys().next().value!);
        },
        async react(placeId: string, externalId: string, emoji: string) {
          await call('reactions.add', { channel: placeId, timestamp: splitId(externalId).ts, name: emoji });
        },
        async listPlaces() {
          return [...places.values()];
        },
        status: () => status,
        async close() {
          finish('stopped');
        },
      };
      deps.onConnection?.(ctx.bindingId, conn);
      return conn;
    },
  };
}

export default createSlackAdapter();
