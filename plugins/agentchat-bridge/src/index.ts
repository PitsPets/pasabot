/**
 * Agent-chat board bridge (W25): mirrors the owner's agent message board into a PasaBot channel and back, as a
 * `ChannelAdapter` (ARCHITECTURE 5.2) run by the W4b binding runtime.
 *
 * Trust: every board author is another AI agent, never the owner. So no place is ever reported as a `dm`: an owner
 * link command is never honoured from the board (one posted there is burned + audited by the runtime), and a board
 * message only becomes a turn when the owner listed its author's board id as an allowed sender, which runs it as an
 * `external` sender one trust level below the owner's channel cap (`decideChannelInbound`).
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
import { z } from 'zod';
import {
  type BoardAgent,
  BoardAuthError,
  type BoardClient,
  type BoardMessage,
  BoardPageError,
  type HttpFetch,
  httpBoardClient,
  INBOX_PAGE_LIMIT,
} from './board.js';
import { AckQueue, backoff, chunkText, sleep } from './util.js';

export * from './board.js';

export const AGENTCHAT_KIND = 'agentchat';
/** text per board message; a longer reply goes out as several messages, nothing is cut */
export const BOARD_TEXT_MAX = 8000;
/** inbound text above this is cut with a marker (a board message is data, not a document upload) */
export const BOARD_INBOUND_MAX = 32_000;
/**
 * Loop guard: two agents answering each other forever would burn the owner's usage. At most this many messages
 * per board author per window that would become turns (a direct message, or a room post that mentions the bridge)
 * are passed on; the rest are skipped, logged, and the owner gets one audit note per author per window
 * (`channel.agentchat.loop_guard`). Room chatter that mentions nobody is never counted.
 */
export const LOOP_GUARD = { max: 30, windowMs: 10 * 60_000 };

export const agentchatConfigSchema = z.object({
  /** board address, e.g. http://127.0.0.1:4100 or a tailnet host; set by the owner only */
  boardUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .refine((u) => !new URL(u).username && !new URL(u).password, 'no credentials in the address'),
  /** the bridge's board token (vault) */
  token: z.string().min(8).max(4096),
  pollIntervalSec: z.number().min(0.05).max(300).default(5),
});
export type AgentchatConfig = z.infer<typeof agentchatConfigSchema>;

export interface AgentchatDeps {
  /** a different board API; default = the HTTP board protocol over safe-net */
  client?: (cfg: AgentchatConfig) => BoardClient;
  /** test hook for the HTTP client */
  fetch?: HttpFetch;
}

/** a message with neither a room nor an addressee went to everyone: the `all` room */
const roomOf = (m: BoardMessage) => m.room || (m.to ? null : 'all');
const placeOf = (m: BoardMessage): PlaceInfo => {
  const room = roomOf(m);
  return room
    ? { id: `room:${room}`, title: `#${room}`, kind: 'channel' }
    : // a direct message is still never a `dm` place: the owner is never linked from the board
      { id: `agent:${m.from.id}`, title: m.from.name || m.from.id, kind: 'group' };
};

/** Plain substring check for `@id` / `@name` (no regex built from board text). */
function mentions(text: string, me: BoardAgent): boolean {
  const t = text.toLowerCase();
  return [me.id, me.name].filter((h) => h.trim()).some((h) => t.includes(`@${h.toLowerCase()}`));
}

/** Map one board message to an InboundMessage; null for the bridge's own posts (exported for tests). */
export function mapBoardMessage(m: BoardMessage, me: BoardAgent): InboundMessage | null {
  if (m.from.id === me.id) return null;
  const room = roomOf(m);
  if (!room && m.to !== me.id) return null; // someone else's direct message
  const text =
    m.text.length > BOARD_INBOUND_MAX ? `${m.text.slice(0, BOARD_INBOUND_MAX)}\n[… cut by PasaBot]` : m.text;
  return {
    externalId: m.id,
    placeId: placeOf(m).id,
    // board authors are agents, but they are the people of this channel: marking them bots would ignore them all.
    // Trust comes from the allowed-sender list, never from anything the board says.
    sender: { externalId: m.from.id, name: m.from.name || m.from.id, isBot: false },
    text,
    attachments: [],
    mentionsBot: !room || mentions(m.text, me),
    at: m.createdAt,
  };
}

export function createAgentchatAdapter(deps: AgentchatDeps = {}): ChannelAdapter<AgentchatConfig> {
  return {
    kind: AGENTCHAT_KIND,
    configSchema: agentchatConfigSchema,
    secretFields: ['token'],
    options: { boardUrl: 'string' },
    async connect(cfg, ctx) {
      const client = deps.client ? deps.client(cfg) : httpBoardClient(cfg, deps.fetch);
      return connectBoard(cfg, ctx, client);
    },
  };
}

async function connectBoard(
  cfg: AgentchatConfig,
  ctx: ChannelContext,
  client: BoardClient,
): Promise<ChannelConnection> {
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let me: BoardAgent;
  try {
    me = await client.whoami(stop.signal);
  } catch (e) {
    ctx.signal.removeEventListener('abort', onAbort);
    throw e instanceof BoardAuthError ? e : new Error(`agent board: cannot reach the board (${errText(e)})`);
  }
  const log = ctx.log.child({ channel: AGENTCHAT_KIND, binding: ctx.bindingId });
  let status: ChannelStatus = 'connected';
  const queue = new AckQueue<InboundMessage>();
  const audit = (action: string, data: Record<string, unknown>) => {
    try {
      ctx.audit?.(`agentchat.${action}`, data);
    } catch {
      /* an audit note never stops the bridge */
    }
  };
  const places = new Map<string, PlaceInfo>();
  /** board message id → thread, so a reply lands in the thread it answers */
  const threads = new Map<string, string>();
  const recent = new Map<string, number[]>();

  const finish = (s: ChannelStatus) => {
    if (status === 'stopped' || status === 'auth_failed') return;
    status = s;
    stop.abort();
    queue.end();
    ctx.signal.removeEventListener('abort', onAbort);
  };
  stop.signal.addEventListener('abort', () => finish('stopped'), { once: true });

  /** authors whose guard already tripped in the current window (one owner note per window) */
  const tripped = new Map<string, number>();
  const loopGuard = (sender: string, now: number) => {
    const times = (recent.get(sender) ?? []).filter((t) => now - t < LOOP_GUARD.windowMs);
    if (times.length >= LOOP_GUARD.max) {
      recent.set(sender, times);
      return false;
    }
    times.push(now);
    recent.set(sender, times);
    if (recent.size > 5000) recent.delete(recent.keys().next().value!);
    return true;
  };

  // the cursor survives a restart in the vault (ctx.state); a fresh binding starts at "now", never the backlog
  let cursor: string | null = null;
  try {
    const saved = await ctx.state?.load();
    if (saved) cursor = (JSON.parse(saved) as { cursor?: string }).cursor ?? null;
  } catch {
    cursor = null;
  }
  /**
   * The saved cursor moves past a page only once the runtime has taken every message of it (AckQueue), so a stop or
   * restart with messages still queued gets them again; the runtime drops repeats on the queue key. Saves run in
   * order.
   */
  let saved = cursor;
  let saving = Promise.resolve();
  const saveCursor = (c: string) =>
    queue.ack(() => {
      if (c === saved) return;
      saved = c;
      saving = saving.then(() => ctx.state?.save(JSON.stringify({ cursor: c })).catch(() => {}));
    });

  void (async () => {
    let failures = 0;
    let limit = INBOX_PAGE_LIMIT;
    while (!stop.signal.aborted) {
      try {
        let page: Awaited<ReturnType<BoardClient['inbox']>>;
        try {
          page = await client.inbox(cursor, stop.signal, limit);
        } catch (e) {
          if (!(e instanceof BoardPageError) || cursor === null) throw e;
          if (limit > 1) {
            // ask again at once for fewer messages
            limit = Math.max(1, Math.floor(limit / 4));
            log.warn('agent board: inbox page unreadable, asking for a smaller one', {
              reason: e.reason,
              limit,
            });
            continue;
          }
          // even one message cannot be read: skip to the board's current position so the bridge keeps working
          const latest = await client.inbox(null, stop.signal);
          log.warn('agent board: skipped unreadable board messages', { reason: e.reason });
          audit('page_skipped', { reason: e.reason });
          limit = INBOX_PAGE_LIMIT;
          cursor = latest.cursor;
          saveCursor(cursor);
          // one poll interval before the next read: a board that keeps serving unreadable pages is not hammered
          await sleep(cfg.pollIntervalSec * 1000, stop.signal).catch(() => {});
          continue;
        }
        limit = INBOX_PAGE_LIMIT;
        if (status === 'reconnecting') status = 'connected';
        failures = 0;
        const first = cursor === null;
        for (const m of first ? [] : page.messages) {
          const inb = mapBoardMessage(m, me);
          if (!inb) continue;
          if (m.threadId) {
            threads.set(m.id, m.threadId);
            if (threads.size > 2000) threads.delete(threads.keys().next().value!);
          }
          const p = placeOf(m);
          places.set(p.id, p);
          // only a message that would become a turn counts: room chatter without a mention is ignored by the runtime
          const now = Date.now();
          if (inb.mentionsBot && !loopGuard(m.from.id, now)) {
            log.warn('agent board: loop guard skipped a message', { from: m.from.id, id: m.id });
            const since = tripped.get(m.from.id);
            if (since === undefined || now - since >= LOOP_GUARD.windowMs) {
              tripped.set(m.from.id, now);
              if (tripped.size > 5000) tripped.delete(tripped.keys().next().value!);
              audit('loop_guard', {
                from: m.from.id,
                messageId: m.id,
                max: LOOP_GUARD.max,
                windowMin: LOOP_GUARD.windowMs / 60_000,
              });
            }
            continue;
          }
          queue.push(inb);
        }
        const moved = page.cursor !== cursor;
        cursor = page.cursor;
        saveCursor(cursor);
        // a full page: the board has more, ask again at once (unless the cursor did not move)
        if (!(page.more && moved)) await sleep(cfg.pollIntervalSec * 1000, stop.signal).catch(() => {});
      } catch (e) {
        if (stop.signal.aborted) break;
        if (e instanceof BoardAuthError) {
          log.error('agent board token rejected; bridge stopped');
          finish('auth_failed');
          break;
        }
        status = 'reconnecting';
        failures++;
        log.warn('agent board poll failed', { error: errText(e), failures });
        await sleep(backoff(failures), stop.signal).catch(() => {});
      }
    }
  })();

  const target = (placeId: string) => {
    if (placeId.startsWith('room:')) return { room: placeId.slice(5) };
    if (placeId.startsWith('agent:') && placeId.length > 6) return { to: placeId.slice(6) };
    throw new Error('agent board: unknown place');
  };

  return {
    inbound: queue,
    async send(placeId: string, msg: OutboundMessage) {
      if (msg.attachments?.length) log.warn('agent board: attachments are not sent to the board');
      const to = target(placeId);
      const threadId = msg.replyToExternalId
        ? (threads.get(msg.replyToExternalId) ?? msg.replyToExternalId)
        : undefined;
      let first: string | undefined;
      for (const text of chunkText(msg.text, BOARD_TEXT_MAX)) {
        const { id } = await client.post({ ...to, ...(threadId ? { threadId } : {}), text }, stop.signal);
        first ??= id;
      }
      return { externalId: first! };
    },
    async listPlaces() {
      return [...places.values()];
    },
    status: () => status,
    async close() {
      finish('stopped');
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default createAgentchatAdapter();
