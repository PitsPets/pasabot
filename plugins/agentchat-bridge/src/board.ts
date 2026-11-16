/**
 * The board side of the bridge: a small HTTP protocol (README "Board protocol") behind the `BoardClient`
 * interface, so another board API can be plugged in without touching the channel mapping.
 * The token is sent only as a bearer header; it never appears in a URL, an error or a log line.
 */
import { SsrfError, safeFetch } from '@pasabot/safe-net';
import { z } from 'zod';

export interface BoardAgent {
  /** immutable id on the board (no spaces); the bridge keys sender trust on it */
  id: string;
  name: string;
}
export interface BoardMessage {
  id: string;
  from: BoardAgent;
  /** agent id of a direct message */
  to?: string | null;
  /** room of a message posted to several agents */
  room?: string | null;
  threadId?: string | null;
  text: string;
  /** epoch ms */
  createdAt: number;
}
export interface BoardPost {
  to?: string;
  room?: string;
  threadId?: string;
  text: string;
}
export interface BoardClient {
  /** the bridge's own identity on the board; throws BoardAuthError on a rejected token */
  whoami(signal: AbortSignal): Promise<BoardAgent>;
  /**
   * Messages the bridge may read, oldest first, after `cursor` (null = only the board's current cursor, no backlog),
   * at most `limit` of them; `more` = the page was full, ask again at once. Throws BoardPageError when the page is
   * too large or not a page at all (the caller may ask for a smaller one, or skip it).
   */
  inbox(
    cursor: string | null,
    signal: AbortSignal,
    limit?: number,
  ): Promise<{ messages: BoardMessage[]; cursor: string; more?: boolean }>;
  post(p: BoardPost, signal: AbortSignal): Promise<{ id: string }>;
}

export class BoardAuthError extends Error {
  constructor() {
    super('agent board: auth failed (token rejected)');
  }
}
/** An inbox page that cannot be read: over the size cap, or not a valid page. Not a connection failure. */
export class BoardPageError extends Error {
  constructor(readonly reason: 'too_large' | 'malformed') {
    super(`agent board: inbox page ${reason === 'too_large' ? 'too large' : 'not readable'}`);
  }
}
export class BoardHttpError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
  ) {
    super(`agent board: ${op} failed (HTTP ${status})`);
  }
}

export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    allowHosts?: string[];
    maxBytes?: number;
  },
) => Promise<Response>;

const agentSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !/\s/.test(s), 'agent id has spaces'),
  name: z.string().max(120).default(''),
});
const messageSchema = z.object({
  id: z.string().min(1).max(200),
  from: agentSchema,
  to: z.string().max(200).nullish(),
  room: z.string().max(200).nullish(),
  threadId: z.string().max(200).nullish(),
  text: z.string().max(1_000_000),
  createdAt: z.union([z.number(), z.string()]),
});
// no count cap here: the body is already capped at BOARD_BODY_MAX and each message is checked on its own
const inboxSchema = z.object({ messages: z.array(z.unknown()), cursor: z.string().min(1).max(500) });
/** response body cap (safe-net `maxBytes`) */
export const BOARD_BODY_MAX = 4 * 1024 * 1024;
/** messages per inbox page the bridge asks for (`limit`); a smaller page is asked when one is too large */
export const INBOX_PAGE_LIMIT = 200;

const at = (v: number | string) => {
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : Date.now();
};

/**
 * HTTP client for the board protocol. The board address is set by the owner in Settings, so its host is the one
 * private/loopback host this binding's safe-net calls may reach (no other host, redirects re-checked).
 */
export function httpBoardClient(
  cfg: { boardUrl: string; token: string },
  http: HttpFetch = (url, init) => safeFetch(url, init),
): BoardClient {
  const base = cfg.boardUrl.replace(/\/+$/, '');
  const host = new URL(base).hostname;
  const call = async (op: string, method: string, path: string, signal: AbortSignal, body?: unknown) => {
    const res = await http(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      timeoutMs: 20_000,
      allowHosts: [host],
      maxBytes: BOARD_BODY_MAX,
    });
    if (res.status === 401 || res.status === 403) throw new BoardAuthError();
    if (!res.ok) throw new BoardHttpError(op, res.status);
    return (await res.json().catch(() => {
      throw new BoardHttpError(op, res.status);
    })) as unknown;
  };
  return {
    async whoami(signal) {
      return agentSchema.parse(await call('whoami', 'GET', '/api/whoami', signal));
    },
    async inbox(cursor, signal, limit = INBOX_PAGE_LIMIT) {
      const n = Math.max(1, Math.min(INBOX_PAGE_LIMIT, Math.floor(limit)));
      const q = cursor === null ? '?latest=1' : `?after=${encodeURIComponent(cursor)}&limit=${n}`;
      let raw: unknown;
      try {
        raw = await call('inbox', 'GET', `/api/inbox${q}`, signal);
      } catch (e) {
        if (e instanceof SsrfError && e.code === 'too_large') throw new BoardPageError('too_large');
        if (e instanceof BoardHttpError && e.status >= 200 && e.status < 300)
          throw new BoardPageError('malformed');
        throw e;
      }
      const page = inboxSchema.safeParse(raw);
      if (!page.success) throw new BoardPageError('malformed');
      const r = page.data;
      const messages: BoardMessage[] = [];
      // one malformed message is skipped, never the whole page
      for (const raw of r.messages) {
        const m = messageSchema.safeParse(raw);
        if (m.success) messages.push({ ...m.data, createdAt: at(m.data.createdAt) });
      }
      return { messages, cursor: r.cursor, more: cursor !== null && r.messages.length >= n };
    },
    async post(p, signal) {
      const r = z
        .object({ id: z.string().min(1).max(200) })
        .parse(await call('post', 'POST', '/api/messages', signal, p));
      return { id: r.id };
    },
  };
}
