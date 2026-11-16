/**
 * WhatsApp `ChannelAdapter` (ARCHITECTURE 5.2) as a linked device on the owner's own account: the owner scans a QR
 * code (`pairing`), and the session keys are kept in the vault through `ctx.state`, never on disk or in config.
 * This is not an official API (no Business API): the account can be limited or banned, which Settings → Channels
 * says before linking starts. The socket is reached through the small `WaSocket` port, so tests use a mock and
 * the production client is loaded only when a binding connects.
 */
import type {
  ChannelAdapter,
  ChannelConnection,
  ChannelContext,
  ChannelStatus,
  InboundMessage,
  Logger,
  OutboundMessage,
  PlaceInfo,
} from '@pasabot/core';
import { z } from 'zod';
import type { WaMessage, WaSocket, WaSocketFactory } from './socket.js';
import { AsyncQueue, chunkText } from './util.js';

export const whatsappConfigSchema = z.object({
  /**
   * Own-number mode: PasaBot runs on the owner's personal number. The owner talks to the agent in their own
   * "message yourself" chat; their messages to other people are never turns. Off = a separate number for the agent.
   */
  ownNumber: z.boolean().default(false),
});
export type WhatsAppConfig = z.infer<typeof whatsappConfigSchema>;

export type { WaCloseInfo, WaMessage, WaSocket, WaSocketFactory } from './socket.js';

export interface WhatsAppDeps {
  /** defaults to the optional WhatsApp Web client (`baileys-bridge.ts`); tests pass a mock */
  socket?: WaSocketFactory;
}

/** Text per message; WhatsApp allows more, but long messages are hard to read and edits get slow. */
export const WHATSAPP_TEXT_MAX = 4096;

/** `123:4@s.whatsapp.net` → `123@s.whatsapp.net`; the immutable account id without the device part. */
export function normalizeJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0]!;
  return `${user}${jid.slice(at)}`;
}
export const isGroupJid = (jid: string) => jid.endsWith('@g.us');

/**
 * Map one message, or null when it is not a turn: our own replies, and in own-number mode everything outside the
 * owner's own "message yourself" chat (that chat is the owner's DM with the agent).
 */
export function mapWaMessage(
  m: WaMessage,
  me: string,
  cfg: WhatsAppConfig,
  sentIds: Set<string> = new Set(),
): InboundMessage | null {
  const self = normalizeJid(me);
  const chat = normalizeJid(m.chat);
  if (sentIds.has(m.id)) return null;
  if (cfg.ownNumber) {
    // own number: only what the owner writes in their own "message yourself" chat is a turn. Everything else on
    // the personal number (a friend's DM, a stranger, a group, a group mention of the owner as a person) is the
    // owner's private life: never a turn, never counted or audited as a dropped sender.
    if (chat !== self || !m.fromMe) return null;
  } else if (m.fromMe) {
    // a dedicated number: what it sends is the agent (or someone typing on that phone), never a turn
    return null;
  }
  const sender = m.fromMe ? self : normalizeJid(m.sender);
  const group = isGroupJid(chat);
  const mentioned = m.mentioned.map(normalizeJid);
  return {
    externalId: `${chat}:${m.id}`,
    placeId: chat,
    sender: { externalId: sender, name: m.pushName || sender.split('@')[0]!, isBot: !!m.isBot },
    text: m.text,
    attachments: [],
    ...(m.quotedId ? { replyToExternalId: `${chat}:${m.quotedId}` } : {}),
    mentionsBot:
      !group || mentioned.includes(self) || (!!m.quotedSender && normalizeJid(m.quotedSender) === self),
    at: m.at,
  };
}

async function defaultSocket(o: { state: string | null; log: Logger }): Promise<WaSocket> {
  const { createBaileysSocket } = await import('./baileys-bridge.js');
  return createBaileysSocket(o);
}

/**
 * How long session updates are coalesced into one vault write. The socket emits a new session on almost every
 * decrypted message; only the newest matters, and `flush` (close, done, logout) writes it at once.
 */
export const STATE_SAVE_DELAY_MS = 3000;

/**
 * Coalescing state writer: `write` keeps only the newest value and saves it at most once per `delayMs`; `flush`
 * saves the pending value now; `discard` drops it. Writes are serialised so a slow vault write never lands after
 * a newer one.
 */
function stateWriter(ctx: ChannelContext, delayMs = STATE_SAVE_DELAY_MS) {
  let chain = Promise.resolve();
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    stopTimer();
    if (pending !== null) {
      const v = pending;
      pending = null;
      chain = chain
        .then(() => ctx.state?.save(v))
        .catch((e) => ctx.log.warn('whatsapp state save failed', { error: String(e) }));
    }
    return chain;
  };
  const write = (s: string) => {
    pending = s;
    if (!timer) {
      timer = setTimeout(() => void flush(), delayMs);
      timer.unref?.();
    }
  };
  const discard = () => {
    stopTimer();
    pending = null;
  };
  return Object.assign(write, { flush, discard });
}

export function createWhatsAppAdapter(deps: WhatsAppDeps = {}): ChannelAdapter<WhatsAppConfig> {
  const open = deps.socket ?? defaultSocket;
  return {
    kind: 'whatsapp',
    configSchema: whatsappConfigSchema,
    secretFields: [],
    options: { ownNumber: 'boolean' },

    async *pairing(ctx: ChannelContext) {
      if (!ctx.state) throw new Error('pairing needs a state store');
      const save = stateWriter(ctx);
      const steps = new AsyncQueue<{ qr?: string; done?: true; error?: string }>();
      const sock = await open({ state: null, log: ctx.log });
      let saved = false;
      sock.on('qr', (qr) => steps.push({ qr }));
      sock.on('state', (s) => {
        saved = true;
        void save(s);
      });
      sock.on('open', () => steps.push({ done: true }));
      sock.on('close', (c) => {
        // right after a scan the platform asks for a fresh connection: the keys are saved, linking is done
        if (c.restartRequired && saved) steps.push({ done: true });
        else steps.push({ error: c.loggedOut ? 'logged_out' : (c.reason ?? 'closed') });
      });
      const stop = () => steps.end();
      ctx.signal.addEventListener('abort', stop, { once: true });
      try {
        for await (const s of steps) {
          if (s.error) throw new Error(`whatsapp pairing ended: ${s.error}`);
          if (s.qr) yield { qr: s.qr };
          if (s.done) {
            // the session keys are in the vault before the runtime reconnects with them
            await save.flush();
            yield { done: true as const };
            return;
          }
        }
      } finally {
        ctx.signal.removeEventListener('abort', stop);
        sock.end();
        // not linked (aborted, expired, failed): a half-made session is not written; the host owns cleanup
        save.discard();
      }
    },

    async connect(cfg: WhatsAppConfig, ctx: ChannelContext): Promise<ChannelConnection> {
      const inbound = new AsyncQueue<InboundMessage>();
      const places = new Map<string, PlaceInfo>();
      const sentIds = new Set<string>();
      const followUps = new Map<string, string[]>();
      let status: ChannelStatus = 'reconnecting';
      let me = '';
      let sock: WaSocket | null = null;
      let ended = false;
      const save = stateWriter(ctx);
      const finish = (s: ChannelStatus) => {
        status = s;
        if (ended) return;
        ended = true;
        inbound.end();
        sock?.end();
        sock = null;
        // the newest session (or the cleared one) reaches the vault before the runtime reconnects
        void save.flush();
      };
      const state = await ctx.state?.load();
      const conn: ChannelConnection = {
        inbound,
        async send(placeId: string, msg: OutboundMessage) {
          if (!sock) throw new Error('whatsapp: not connected');
          const parts = chunkText(msg.text, WHATSAPP_TEXT_MAX);
          const quotedId = msg.replyToExternalId?.slice(msg.replyToExternalId.lastIndexOf(':') + 1);
          let first = '';
          for (const [i, p] of parts.entries()) {
            const r = await sock.sendText(placeId, p, i === 0 && quotedId ? { quotedId } : undefined);
            remember(r.id);
            if (i === 0) first = r.id;
          }
          return { externalId: `${placeId}:${first}` };
        },
        async edit(placeId: string, externalId: string, msg: OutboundMessage) {
          if (!sock) throw new Error('whatsapp: not connected');
          const parts = chunkText(msg.text, WHATSAPP_TEXT_MAX);
          const id = externalId.slice(externalId.lastIndexOf(':') + 1);
          await sock.editText(placeId, id, parts[0]!);
          const prev = followUps.get(externalId) ?? [];
          const next: string[] = [];
          for (const [i, p] of parts.slice(1).entries()) {
            const old = prev[i];
            if (old) {
              await sock.editText(placeId, old, p);
              next.push(old);
            } else {
              const r = await sock.sendText(placeId, p);
              remember(r.id);
              next.push(r.id);
            }
          }
          if (next.length) followUps.set(externalId, next);
          else followUps.delete(externalId);
          if (followUps.size > 500) followUps.delete(followUps.keys().next().value!);
        },
        async listPlaces() {
          return [...places.values()];
        },
        status: () => status,
        async close() {
          finish('stopped');
        },
      };
      const remember = (id: string) => {
        sentIds.add(id);
        if (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value!);
      };
      // not linked yet: the runtime marks the binding auth_failed and Settings → Channels shows the QR flow
      if (!state) throw new Error('whatsapp: not linked yet (auth): scan the QR code in Settings → Channels');
      sock = await open({ state, log: ctx.log });
      ctx.signal.addEventListener('abort', () => finish('stopped'), { once: true });
      sock.on('state', (s) => {
        if (!ended) save(s);
      });
      sock.on('qr', () => {
        // a stored session that asks for a new QR code is no longer linked: forget it, so the next connect fails
        // fast as "not linked yet" and opens no socket instead of asking WhatsApp for a QR login again and again
        if (ended) return;
        save('');
        finish('auth_failed');
      });
      sock.on('open', (who) => {
        me = normalizeJid(who.jid);
        status = 'connected';
      });
      sock.on('close', (c) => {
        if (ended) return;
        if (c.loggedOut) {
          // the owner removed the linked device: forget the dead session
          save('');
          finish('auth_failed');
        } else finish('reconnecting');
      });
      sock.on('message', (m) => {
        if (status !== 'connected' || !me) return;
        const msg = mapWaMessage(m, me, cfg, sentIds);
        if (!msg) return;
        if (!places.has(msg.placeId)) {
          const group = isGroupJid(msg.placeId);
          places.set(msg.placeId, {
            id: msg.placeId,
            title: group ? msg.placeId : msg.placeId === me ? 'You' : msg.sender.name,
            kind: group ? 'group' : 'dm',
          });
          if (group && sock?.groupName)
            sock
              .groupName(msg.placeId)
              .then((t) => {
                const p = places.get(msg.placeId);
                if (p && t) p.title = t;
              })
              .catch(() => {});
        }
        inbound.push(msg);
      });
      return conn;
    },
  };
}

export default createWhatsAppAdapter();
