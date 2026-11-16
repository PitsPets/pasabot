/** WebSocket `/ws`: hello/welcome, topic subscriptions with membership checks, resume or `gap`, heartbeat, backpressure. */
import type { BusEvent, Principal } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import { type C2S, c2sSchema, type S2C, type Topic, type UserDTO } from '@pasabot/protocol';
import type { FastifyInstance } from 'fastify';
import type { Bus, EventStore } from './bus.js';
import { type AuthResolver, tokenPrincipal } from './services.js';

export interface WsOptions {
  bus: Bus;
  store: EventStore;
  db: Sqlite;
  serverId: string;
  resolve: AuthResolver;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
  /** above this many buffered bytes, `live` frames are dropped; persisted events disconnect with bye 'slow' */
  maxBufferedBytes?: number;
  /** a `sub` that would replay more than this many events gets `gap` instead (default 5000) */
  maxReplay?: number;
  /** how often an idle socket re-checks its session and topics (default 5 s); every delivery re-checks too */
  recheckMs?: number;
  /**
   * The event's data as this principal may see it (the shared message serialiser, deny by default: only the event
   * types and block kinds anyone may get reach a non-owner), or `drop` when it must not reach them. Applied to every
   * frame, live and replayed.
   */
  view?: (type: string, data: unknown, p: Principal) => { data: unknown } | 'drop';
}

/**
 * The session behind a socket, re-read: null once it was logged out, revoked (device revoke deletes its sessions),
 * expired, or its user disabled. The user's kind is re-read too, so a demoted owner loses owner topics.
 */
export function currentSession(db: Sqlite, p: Principal, now = Date.now()): Principal | null {
  if (p.kind !== 'session') return null;
  const r = db
    .prepare(
      `SELECT u.kind FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
    )
    .get(p.sessionId, p.userId, now) as { kind: 'owner' | 'member' | 'guest' } | undefined;
  return r ? { ...p, userKind: r.kind } : null;
}

/** Owners see every topic; other users only `global` and the chats they are members of (ARCHITECTURE 3.1). */
export function canAccessTopic(db: Sqlite, p: Principal, topic: Topic): boolean {
  if (p.kind !== 'session') return false;
  if (p.userKind === 'owner') return true;
  if (topic === 'global') return true;
  if (topic.startsWith('chat:')) {
    return !!db
      .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
      .get(topic.slice(5), p.userId);
  }
  return false;
}

export function registerWs(app: FastifyInstance, o: WsOptions): void {
  const heartbeatMs = o.heartbeatMs ?? 25_000;
  const maxBuffered = o.maxBufferedBytes ?? 4 * 1024 * 1024;
  const maxReplay = o.maxReplay ?? 5000;
  app.get('/ws', { websocket: true }, (socket, req) => {
    let principal: Principal | null = null;
    let replayFrom: number | null = null;
    const topics = new Set<Topic>();
    let missedPongs = 0;
    const send = (f: S2C) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(f));
    };
    const bye = (reason: string) => {
      send({ t: 'bye', reason });
      socket.close(1000, reason);
    };
    /**
     * Sessions and memberships change under a live socket: logout, device/session revoke, removal from a chat.
     * Re-check before anything is sent: a dead session closes the socket, a topic the principal lost is dropped.
     */
    const recheck = (): boolean => {
      if (!principal) return false;
      const p = currentSession(o.db, principal);
      if (!p) {
        principal = null;
        topics.clear();
        bye('session_revoked');
        return false;
      }
      principal = p;
      for (const t of topics) if (!canAccessTopic(o.db, p, t)) topics.delete(t);
      return true;
    };
    const deliver = (ev: BusEvent) => {
      if (!principal || !topics.has(ev.topic)) return;
      if (!recheck() || !topics.has(ev.topic)) return;
      if (socket.bufferedAmount > maxBuffered) {
        if (ev.live) return; // drop live frames first
        bye('slow');
        return;
      }
      const v = o.view ? o.view(ev.type, ev.data, principal) : { data: ev.data };
      if (v === 'drop') return;
      if (ev.live) send({ t: 'live', topic: ev.topic, type: ev.type as never, data: v.data });
      else send({ t: 'ev', seq: ev.seq!, topic: ev.topic, type: ev.type as never, data: v.data });
    };
    const unsubscribe = o.bus.subscribe(deliver);
    const helloTimer = setTimeout(() => {
      if (!principal) bye('hello_timeout');
    }, o.helloTimeoutMs ?? 10_000);
    const beat = setInterval(() => {
      if (missedPongs >= 2) {
        socket.terminate();
        return;
      }
      missedPongs++;
      socket.ping();
    }, heartbeatMs);
    const recheckTimer = setInterval(() => {
      if (principal) recheck();
    }, o.recheckMs ?? 5000);
    socket.on('pong', () => {
      missedPongs = 0;
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(beat);
      clearInterval(recheckTimer);
      unsubscribe();
    });
    socket.on('message', (raw: unknown) => {
      let frame: C2S;
      try {
        frame = c2sSchema.parse(JSON.parse(String(raw)));
      } catch {
        bye('bad_frame');
        return;
      }
      if (frame.t === 'hello') {
        if (principal) return;
        const p = frame.token
          ? tokenPrincipal(o.db, frame.token)
          : o.resolve({ headers: req.headers, ip: req.ip });
        if (p?.kind !== 'session') {
          bye('unauthorized');
          return;
        }
        const u = o.db.prepare('SELECT id, kind, display_name FROM users WHERE id = ?').get(p.userId) as
          | { id: string; kind: UserDTO['kind']; display_name: string }
          | undefined;
        if (!u) {
          bye('unauthorized');
          return;
        }
        principal = p;
        const seq = o.store.lastSeq();
        send({
          t: 'welcome',
          serverId: o.serverId,
          seq,
          user: { id: u.id, kind: u.kind, displayName: u.display_name },
        });
        if (frame.resumeFrom !== undefined && !o.store.canResume(frame.resumeFrom)) {
          send({ t: 'gap', from: frame.resumeFrom });
          replayFrom = seq; // the client refetches via REST; deliver from now on
        } else {
          replayFrom = frame.resumeFrom ?? seq;
        }
        return;
      }
      if (!principal) {
        bye('hello_first');
        return;
      }
      switch (frame.t) {
        case 'sub': {
          if (!recheck()) return;
          const added = frame.topics.filter((t) => !topics.has(t) && canAccessTopic(o.db, principal!, t));
          // synchronous replay then live: better-sqlite3 is synchronous, so no event can slip in between.
          // Bounded: more than maxReplay events -> `gap` (the client refetches via REST); the same
          // backpressure rule as live delivery applies while replaying.
          const from = replayFrom ?? o.store.lastSeq();
          const backlog = o.store.since(from, new Set(added), maxReplay + 1);
          if (backlog.length > maxReplay) {
            send({ t: 'gap', from });
          } else {
            for (const ev of backlog) {
              if (socket.bufferedAmount > maxBuffered) {
                bye('slow');
                return;
              }
              const v = o.view ? o.view(ev.type, ev.data, principal!) : { data: ev.data };
              if (v === 'drop') continue;
              send({ t: 'ev', seq: ev.seq, topic: ev.topic, type: ev.type as never, data: v.data });
            }
          }
          for (const t of added) topics.add(t);
          return;
        }
        case 'unsub':
          for (const t of frame.topics) topics.delete(t);
          return;
        case 'ping':
          send({ t: 'pong', n: frame.n });
          return;
        case 'typing':
          return; // typing indicators are W0b chat work
      }
    });
  });
}
