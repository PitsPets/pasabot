/**
 * Auth (ARCHITECTURE 4.1, 8): Host allowlist + Origin checks before anything else, the one-time setup token,
 * owner password login, sessions (cookie or bearer), QR device pairing, and the automation/run token rules.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type Notifier, type Principal, ulid } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { UserKind } from '@pasabot/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LANGUAGE_CODE, languageKey } from '../core/i18n.js';
import { type AuthResolver, bearerOf, hashToken, tokenPrincipal } from '../core/services.js';
import { registerPasskeyRoutes } from './passkey.js';
import { hashPassword, verifyPassword } from './password.js';

export const SESSION_COOKIE = 'pasabot_session';
const SETUP_TTL_MS = 30 * 60_000;
/**
 * `freshSetupLink` hands back the link it minted last, instead of a new one, while that link is younger than this and
 * still unused: a reload loop in the desktop window then cannot churn the setup_tokens table.
 */
export const SETUP_REMINT_MS = 10_000;
const PAIRING_TTL_MS = 120_000;
/**
 * A pairing device name or platform shown to the owner on a security decision: printable text only. Control
 * characters (C0, DEL, C1), format characters (bidi overrides, zero-width) and line/paragraph separators are refused,
 * so a claim can never redraw a terminal line, retitle it or reorder what the owner reads. Fixed pattern, linear.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const printable = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !UNPRINTABLE.test(v), 'printable characters only');
/** Non-secret id of a pairing code (derived from its hash), so a client can find the claim made on its own code. */
const pairingCodeId = (codeHash: string) =>
  createHash('sha256').update(`pasabot:pairing-code-id:${codeHash}`).digest('hex').slice(0, 24);
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 3600_000;
/** how long a re-auth (password or passkey) of a session counts for tier-3 approvals */
export const REAUTH_WINDOW_MS = 5 * 60_000;
/**
 * A re-auth made for one approval card (`POST /auth/reauth` with `for: <approval id>`, ARCHITECTURE 8 "Screen
 * helpers") answers that card only, once, and only this soon after; it never opens the 5-minute window.
 */
export const FRESH_REAUTH_MS = 2 * 60_000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

const newToken = () => randomBytes(32).toString('base64url');
/**
 * The raw session token goes in a response body only to non-browser clients (CLI, native): a request with an
 * `Origin` header is a page, which gets the HttpOnly cookie alone, so no script in the page can lift the token.
 */
const bodyToken = (req: FastifyRequest, token: string) => (req.headers.origin === undefined ? { token } : {});

/** `Host` / `Origin` hostname, lowercased, without port or IPv6 brackets. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  return h.split(':')[0] || null;
}
/** `scheme://host[:port]` of an Origin or URL, lowercased, default ports dropped; null when unparsable. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}
export const isLoopbackIp = (ip: string) =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');

export function cookieOf(headers: Record<string, string | string[] | undefined>, name: string) {
  const raw = headers.cookie;
  const v = Array.isArray(raw) ? raw.join('; ') : raw;
  if (!v) return null;
  for (const part of v.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export interface AuthOptions {
  db: Sqlite;
  serverId: string;
  /** configured hostnames besides localhost/127.0.0.1/[::1] */
  allowedHosts?: string[];
  sessionTtlMs?: number;
  /** where first-run links point (the web app); default: the server URL. Its origin is an allowed Origin. */
  publicUrl?: () => string;
  /** extra allowed browser origins, exact `scheme://host:port` (e.g. a dev web server) */
  allowedOrigins?: string[];
  /** the port this server listens on (its own loopback/allowed-host origins are allowed on it) */
  serverPort?: () => number | null;
  /** origins that are never allowed, whatever else matches (the sites origin) */
  deniedOrigins?: () => string[];
  /** in-app notices for security events (a passkey added or removed) */
  notifier?: Notifier;
}

export interface Auth {
  resolver: AuthResolver;
  isAllowedHost(hostname: string | null): boolean;
  /** full Origin check: scheme, host and port must match the allowlist (4.1) */
  isAllowedOrigin(origin: string): boolean;
  registerGuards(app: FastifyInstance): void;
  registerRoutes(app: FastifyInstance): void;
  /** true while no owner exists */
  needsSetup(): boolean;
  /**
   * mint a fresh single-use setup token (30 min); returns the raw token. Every older unused token stops working (one
   * live code at a time). Throws once an owner exists.
   */
  issueSetupToken(): string;
  setupLink(token: string): string;
  /**
   * The desktop app's fresh setup link (ARCHITECTURE 4.3 `pasabot:setup-link`, parent channel only, never HTTP): null
   * once an owner exists; the last minted link again while it is younger than SETUP_REMINT_MS and unused; else a new one.
   */
  freshSetupLink(): string | null;
  /** server fingerprint shown during pairing */
  fingerprint: string;
  /** true when the session re-authenticated (password or passkey) within `ms` (tier-3 approvals, 8) */
  reauthedWithin(sessionId: string, ms?: number): boolean;
  /**
   * Takes (once) the re-auth this session made for approval `approvalId` in the last `FRESH_REAUTH_MS`; false when
   * there is none, it was for another card, or it was already used (8, "Screen helpers").
   */
  takeFreshReauth(sessionId: string, approvalId: string): boolean;
  /** W23 (PeoplePort.signIn): a new session for `userId`; returns the raw token (stored hashed) */
  startSession(userId: string, req: { ip: string; userAgent: string }): string;
  /** the `set-cookie` header value for a session token */
  sessionCookie(token: string): string;
}

export function createAuth(o: AuthOptions): Auth {
  const { db } = o;
  const allowed = new Set([...LOOPBACK_HOSTS, ...(o.allowedHosts ?? []).map((h) => h.toLowerCase())]);
  const ttl = o.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const fingerprint = createHash('sha256')
    .update(`pasabot:${o.serverId}`)
    .digest('hex')
    .slice(0, 16)
    .match(/.{4}/g)!
    .join('-');
  const isAllowedHost = (h: string | null) => !!h && allowed.has(h);
  const configuredHosts = (o.allowedHosts ?? []).map((h) => h.toLowerCase());
  const explicitOrigins = (o.allowedOrigins ?? []).map(normalizeOrigin).filter((x): x is string => !!x);
  /**
   * Allowed browser origins, compared on scheme://host:port (never the host alone: the sites origin shares the
   * host and differs only in port). = explicit list + the public URL's origin + this server's own port on every
   * allowed host (http and https) + `https://<configured host>` (a TLS front such as Tailscale serve on 443).
   */
  const allowedOrigins = (): Set<string> => {
    const out = new Set(explicitOrigins);
    const pub = o.publicUrl?.();
    const pubOrigin = pub ? normalizeOrigin(pub) : null;
    if (pubOrigin) out.add(pubOrigin);
    const port = o.serverPort?.();
    if (port) {
      for (const h of allowed) {
        const host = h.includes(':') ? `[${h}]` : h;
        for (const scheme of ['http', 'https']) {
          const n = normalizeOrigin(`${scheme}://${host}:${port}`);
          if (n) out.add(n);
        }
      }
    }
    for (const h of configuredHosts) {
      const n = normalizeOrigin(`https://${h.includes(':') ? `[${h}]` : h}`);
      if (n) out.add(n);
    }
    for (const d of o.deniedOrigins?.() ?? []) {
      const n = normalizeOrigin(d);
      if (n) out.delete(n);
    }
    return out;
  };
  const isAllowedOrigin = (origin: string) => {
    const n = normalizeOrigin(origin);
    return !!n && allowedOrigins().has(n);
  };

  const resolver: AuthResolver = (req) => {
    const bearer = bearerOf(req.headers);
    const token = bearer ?? cookieOf(req.headers, SESSION_COOKIE);
    if (!token) return null;
    const p = tokenPrincipal(db, token);
    if (!p) return null;
    if (p.kind === 'automation') {
      // automation tokens: bearer only, never from a page (Origin), loopback unless remote_ok
      if (!bearer || req.headers.origin !== undefined) return null;
      const row = db
        .prepare(
          `SELECT t.remote_ok FROM automation_tokens t JOIN agents a ON a.id = t.agent_id
           WHERE t.id = ? AND a.archived_at IS NULL`,
        )
        .get(p.tokenId) as { remote_ok: number } | undefined;
      if (!row || (!row.remote_ok && !isLoopbackIp(req.ip))) return null;
      db.prepare('UPDATE automation_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), p.tokenId);
    }
    if (p.kind === 'run' && !bearer) return null;
    return p;
  };

  const audit = (actor: Principal | null, action: string, target: string | null, ip: string, data = {}) => {
    db.prepare(
      'INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target, ip, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      ulid(),
      Date.now(),
      actor?.kind === 'session' ? 'user' : (actor?.kind ?? 'anonymous'),
      actor?.kind === 'session' ? actor.userId : null,
      action,
      target,
      ip,
      JSON.stringify(data),
    );
  };

  const createSession = (
    userId: string,
    req: Pick<FastifyRequest, 'ip' | 'headers'>,
    deviceId: string | null = null,
  ) => {
    const token = newToken();
    const now = Date.now();
    db.prepare(
      'INSERT INTO sessions (id, user_id, device_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      hashToken(token),
      userId,
      deviceId,
      now,
      now + ttl,
      req.ip,
      String(req.headers['user-agent'] ?? ''),
    );
    return token;
  };
  const cookieFor = (token: string) =>
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}`;
  const setCookie = (reply: FastifyReply, token: string) => reply.header('set-cookie', cookieFor(token));
  const userDTO = (id: string) => {
    const u = db.prepare('SELECT id, kind, display_name FROM users WHERE id = ?').get(id) as {
      id: string;
      kind: 'owner' | 'member' | 'guest';
      display_name: string;
    };
    return { id: u.id, kind: u.kind, displayName: u.display_name };
  };
  const needsSetup = () => !db.prepare("SELECT 1 FROM users WHERE kind = 'owner' LIMIT 1").get();
  /** the last setup token this process minted (raw, memory only) and when, for `freshSetupLink` */
  let lastSetup: { token: string; at: number } | null = null;
  const replaceSetupToken = db.transaction((hash: string, now: number) => {
    // one live code at a time: every older unused one stops working (used ones stay as the record of the claim)
    db.prepare('DELETE FROM setup_tokens WHERE used_at IS NULL').run();
    db.prepare('INSERT INTO setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
      hash,
      now,
      now + SETUP_TTL_MS,
    );
  });
  const issueSetupToken = () => {
    if (!needsSetup()) throw new Error('owner_exists: a setup token is minted only while no owner exists');
    const token = newToken();
    const now = Date.now();
    replaceSetupToken(hashToken(token), now);
    lastSetup = { token, at: now };
    return token;
  };
  // the token rides in the fragment: never sent to a server, never in access logs (4.1 "tokens never in URLs")
  const setupLink = (token: string) => `${(o.publicUrl?.() ?? '').replace(/\/$/, '')}/#/setup?token=${token}`;

  // simple fixed-window limiter for login / pairing claims (per ip)
  const hits = new Map<string, { n: number; reset: number }>();
  const limited = (key: string, max: number, windowMs: number) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    return ++h.n > max;
  };

  // pending pairing claims live in memory: they last at most a few minutes
  interface Claim {
    id: string;
    secretHash: string;
    userId: string;
    deviceName: string;
    platform: string | null;
    /** `pairingCodeId` of the code this claim used */
    codeId: string;
    state: 'pending' | 'confirmed' | 'rejected';
    expiresAt: number;
  }
  const claims = new Map<string, Claim>();
  const reauthAt = new Map<string, number>();
  /** per session: the one approval card its latest re-auth was made for, and when */
  const freshFor = new Map<string, { approvalId: string; at: number }>();
  const sweepClaims = () => {
    const now = Date.now();
    for (const [k, c] of claims) if (c.expiresAt <= now) claims.delete(k);
  };

  const principalOf = (req: FastifyRequest) => resolver({ headers: req.headers, ip: req.ip });
  const requireSession = (req: FastifyRequest, reply: FastifyReply, ownerOnly = false) => {
    const p = principalOf(req);
    if (p?.kind !== 'session') {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    if (ownerOnly && p.userKind !== 'owner') {
      reply.code(403).send({ error: 'owner_only' });
      return null;
    }
    return p;
  };
  const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null => {
    const r = schema.safeParse(body);
    if (!r.success) {
      reply.code(400).send({ error: 'invalid_input', message: r.error.message });
      return null;
    }
    return r.data;
  };

  const serverName = () => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'server.name'").get() as
      | { value: string }
      | undefined;
    return r ? (JSON.parse(r.value) as string) : null;
  };

  return {
    resolver,
    isAllowedHost,
    isAllowedOrigin,
    fingerprint,
    needsSetup,
    startSession: (userId, req) =>
      createSession(userId, { ip: req.ip, headers: { 'user-agent': req.userAgent } }),
    sessionCookie: cookieFor,
    reauthedWithin(sessionId, ms = REAUTH_WINDOW_MS) {
      const at = reauthAt.get(sessionId);
      return at !== undefined && Date.now() - at <= ms;
    },
    takeFreshReauth(sessionId, approvalId) {
      const f = freshFor.get(sessionId);
      freshFor.delete(sessionId); // one card, one use: a second approve needs a new re-auth
      return !!f && f.approvalId === approvalId && Date.now() - f.at <= FRESH_REAUTH_MS;
    },
    issueSetupToken,
    setupLink,
    freshSetupLink() {
      if (!needsSetup()) {
        lastSetup = null;
        return null;
      }
      const now = Date.now();
      if (
        lastSetup &&
        now - lastSetup.at < SETUP_REMINT_MS &&
        db
          .prepare('SELECT 1 FROM setup_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
          .get(hashToken(lastSetup.token), now)
      )
        return setupLink(lastSetup.token);
      return setupLink(issueSetupToken());
    },

    registerGuards(app) {
      app.addHook('onRequest', async (req, reply) => {
        // 1. Host allowlist on every HTTP and WS request, before auth (DNS rebinding)
        const isUpgrade = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
        // a refused upgrade must not leave the socket open for reuse
        const refuse = (code: number, error: string) => {
          if (!isUpgrade) return reply.code(code).send({ error });
          // an upgrade socket is outside Fastify's response cycle: answer on it directly and close it
          const body = JSON.stringify({ error });
          const sock = req.raw.socket;
          reply.hijack();
          sock.end(
            `HTTP/1.1 ${code} ${code === 421 ? 'Misdirected Request' : 'Forbidden'}\r\nConnection: close\r\n` +
              `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
          sock.once('finish', () => sock.destroy());
          return reply;
        };
        if (!isAllowedHost(hostnameOf(req.headers.host))) return refuse(421, 'misdirected_request');
        // 2. Origin: a browser request from a foreign origin is refused (WS upgrade + every mutation).
        //    Non-browser clients send no Origin; browsers always send it on WS upgrades and cross-site writes.
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== 'null') {
          const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
          if ((isUpgrade || mutation) && !isAllowedOrigin(origin)) return refuse(403, 'origin_not_allowed');
        } else if (origin === 'null' && isUpgrade) {
          return refuse(403, 'origin_not_allowed'); // sandboxed iframes send Origin: null
        }
      });
    },

    registerRoutes(app) {
      /** `fresh`: the caller proved the password just now, so the new session counts as re-authenticated */
      const signIn = (
        userId: string,
        req: FastifyRequest,
        reply: FastifyReply,
        action: string,
        fresh = false,
      ) => {
        const token = createSession(userId, req);
        if (fresh) reauthAt.set(hashToken(token), Date.now());
        const kind = (db.prepare('SELECT kind FROM users WHERE id = ?').get(userId) as { kind: UserKind })
          .kind;
        audit({ kind: 'session', userId, userKind: kind, sessionId: '' }, action, userId, req.ip);
        setCookie(reply, token);
        return { user: userDTO(userId), ...bodyToken(req, token) };
      };
      app.get('/api/v1/setup', async () => ({ needsSetup: needsSetup(), fingerprint }));

      app.post('/api/v1/setup', async (req, reply) => {
        const b = parse(
          z.object({
            token: z.string().max(200).optional(),
            displayName: z.string().min(1).max(80),
            password: z.string().min(8).max(512),
          }),
          req.body,
          reply,
        );
        if (!b) return;
        if (limited(`setup:${req.ip}`, 10, 60_000)) return reply.code(429).send({ error: 'rate_limited' });
        const now = Date.now();
        // claim the token atomically: single use, unexpired
        const claimed = db
          .prepare(
            'UPDATE setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
          )
          .run(now, hashToken(b.token ?? ''), now);
        if (claimed.changes !== 1) {
          audit(null, 'setup.refused', null, req.ip);
          return reply.code(403).send({ error: 'invalid_setup_token' });
        }
        if (!needsSetup()) return reply.code(409).send({ error: 'owner_exists' });
        const id = ulid();
        db.prepare(
          "INSERT INTO users (id, kind, display_name, password_hash, created_at) VALUES (?, 'owner', ?, ?, ?)",
        ).run(id, b.displayName, await hashPassword(b.password), now);
        const token = createSession(id, req);
        reauthAt.set(hashToken(token), Date.now()); // the password was just set: a fresh re-auth
        audit(
          { kind: 'session', userId: id, userKind: 'owner', sessionId: '' },
          'setup.owner_created',
          id,
          req.ip,
        );
        setCookie(reply, token);
        return { user: userDTO(id), ...bodyToken(req, token) };
      });

      app.post('/api/v1/auth/login', async (req, reply) => {
        const b = parse(
          z.object({ password: z.string().min(1).max(512), userId: z.string().optional() }),
          req.body,
          reply,
        );
        if (!b) return;
        if (limited(`login:${req.ip}`, 10, 60_000)) return reply.code(429).send({ error: 'rate_limited' });
        const u = (
          b.userId
            ? db
                .prepare('SELECT id, password_hash FROM users WHERE id = ? AND disabled_at IS NULL')
                .get(b.userId)
            : db
                .prepare(
                  "SELECT id, password_hash FROM users WHERE kind = 'owner' AND disabled_at IS NULL LIMIT 1",
                )
                .get()
        ) as { id: string; password_hash: string | null } | undefined;
        if (!u?.password_hash || !(await verifyPassword(b.password, u.password_hash))) {
          audit(null, 'auth.login_failed', u?.id ?? null, req.ip);
          return reply.code(401).send({ error: 'invalid_credentials' });
        }
        return signIn(u.id, req, reply, 'auth.login', true);
      });

      const passkeys = registerPasskeyRoutes(app, {
        db,
        isAllowedOrigin,
        normalizeOrigin,
        requireSession,
        signIn,
        limited,
        audit: (userId, action, target, ip) =>
          audit(
            userId ? { kind: 'session', userId, userKind: 'owner', sessionId: '' } : null,
            action,
            target,
            ip,
          ),
        // a re-auth for one card counts for that card only (8, "Screen helpers"): it opens no 5-minute window
        markReauth: (sessionId, forApproval) => {
          if (forApproval) freshFor.set(sessionId, { approvalId: forApproval, at: Date.now() });
          else reauthAt.set(sessionId, Date.now());
        },
        reauthedWithin: (sessionId) => {
          const at = reauthAt.get(sessionId);
          return at !== undefined && Date.now() - at <= REAUTH_WINDOW_MS;
        },
        notify: (_userId, title, body) => {
          void o.notifier?.notify({ level: 'warn', title, body }).catch(() => {});
        },
        serverName,
      });
      app.post('/api/v1/auth/reauth', async (req, reply) =>
        passkeys.reauth(req, reply, async (password) => {
          const p = principalOf(req);
          if (p?.kind !== 'session') return false;
          const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(p.userId) as
            | { password_hash: string | null }
            | undefined;
          return !!u?.password_hash && (await verifyPassword(password, u.password_hash));
        }),
      );

      app.post('/api/v1/auth/logout', async (req, reply) => {
        const p = requireSession(req, reply);
        if (!p) return;
        db.prepare('DELETE FROM sessions WHERE id = ?').run(p.sessionId);
        reauthAt.delete(p.sessionId);
        freshFor.delete(p.sessionId);
        reply.header(
          'set-cookie',
          `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        );
        return { ok: true };
      });

      app.get('/api/v1/me', async (req, reply) => {
        const p = requireSession(req, reply);
        if (!p) return;
        return { user: userDTO(p.userId), serverId: o.serverId, fingerprint };
      });

      // W24: the app language a person picked, so text the server renders for them (push, channels, stored
      // messages) is in that language
      app.put('/api/v1/me/language', async (req, reply) => {
        const p = requireSession(req, reply);
        if (!p) return;
        const b = parse(z.object({ language: z.string().max(20).regex(LANGUAGE_CODE) }), req.body, reply);
        if (!b) return;
        db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(languageKey(p.userId), JSON.stringify(b.language));
        return { language: b.language };
      });

      app.get('/api/v1/server', async (req, reply) => {
        if (!requireSession(req, reply)) return;
        return { serverId: o.serverId, name: serverName(), fingerprint };
      });
      app.put('/api/v1/server/name', async (req, reply) => {
        const p = requireSession(req, reply, true);
        if (!p) return;
        const b = parse(z.object({ name: z.string().min(1).max(60) }), req.body, reply);
        if (!b) return;
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('server.name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(JSON.stringify(b.name));
        audit(p, 'server.renamed', null, req.ip, { name: b.name });
        return { name: b.name };
      });

      // ---------- QR device pairing (8, "Pairing hijack") ----------
      /**
       * Pairing mints a new long-lived, device-bound session, so like adding a passkey (2.4) it needs a fresh re-auth
       * (password or a user-verified passkey within the window): a stolen or stale session cannot pair itself a
       * second device that outlives logout or revoking the first one. Else 401 `reauth_required`.
       */
      const requireFreshOwner = (req: FastifyRequest, reply: FastifyReply) => {
        const p = requireSession(req, reply, true);
        if (!p) return null;
        const at = reauthAt.get(p.sessionId);
        if (at === undefined || Date.now() - at > REAUTH_WINDOW_MS) {
          reply.code(401).send({ error: 'reauth_required' });
          return null;
        }
        return p;
      };
      app.post('/api/v1/pairing', async (req, reply) => {
        const p = requireFreshOwner(req, reply);
        if (!p) return;
        const code = randomBytes(10).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
        const expiresAt = Date.now() + PAIRING_TTL_MS;
        db.prepare('INSERT INTO pairing_codes (code_hash, created_by, expires_at) VALUES (?, ?, ?)').run(
          hashToken(code),
          p.userId,
          expiresAt,
        );
        audit(p, 'pairing.code_created', null, req.ip);
        // codeId: filter GET /pairing/claims to this code's claim; publicUrl: the address a phone should open
        return {
          code,
          codeId: pairingCodeId(hashToken(code)),
          expiresAt,
          fingerprint,
          publicUrl: o.publicUrl?.() || null,
        };
      });

      app.post('/api/v1/pairing/claim', async (req, reply) => {
        const b = parse(
          z.object({
            code: z.string().min(6).max(64),
            deviceName: printable(1, 80),
            platform: printable(0, 40).optional(),
          }),
          req.body,
          reply,
        );
        if (!b) return;
        if (limited(`pair:${req.ip}`, 10, 60_000)) return reply.code(429).send({ error: 'rate_limited' });
        const now = Date.now();
        const row = db
          .prepare(
            'SELECT created_by FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
          )
          .get(hashToken(b.code), now) as { created_by: string } | undefined;
        if (!row) return reply.code(403).send({ error: 'invalid_code' });
        const used = db
          .prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
          .run(now, hashToken(b.code));
        if (used.changes !== 1) return reply.code(403).send({ error: 'invalid_code' });
        sweepClaims();
        const secret = newToken();
        const claim: Claim = {
          id: ulid(),
          secretHash: hashToken(secret),
          userId: row.created_by,
          deviceName: b.deviceName,
          platform: b.platform ?? null,
          codeId: pairingCodeId(hashToken(b.code)),
          state: 'pending',
          expiresAt: now + 5 * 60_000,
        };
        claims.set(claim.id, claim);
        audit(null, 'pairing.claimed', claim.id, req.ip, { deviceName: b.deviceName });
        return { claimId: claim.id, claimSecret: secret, fingerprint };
      });

      app.get('/api/v1/pairing/claims', async (req, reply) => {
        const p = requireSession(req, reply, true);
        if (!p) return;
        sweepClaims();
        // `?codeId=` narrows the list to the claim made on that code (the CLI confirms only its own code's claim)
        const q = (req.query as { codeId?: unknown }).codeId;
        const codeId = typeof q === 'string' ? q : null;
        return {
          claims: [...claims.values()]
            .filter((c) => c.userId === p.userId && c.state === 'pending' && (!codeId || c.codeId === codeId))
            .map((c) => ({
              id: c.id,
              codeId: c.codeId,
              deviceName: c.deviceName,
              platform: c.platform,
              expiresAt: c.expiresAt,
            })),
        };
      });

      for (const action of ['confirm', 'reject'] as const) {
        app.post(`/api/v1/pairing/claims/:id/${action}`, async (req, reply) => {
          // letting a device in mints the credential: fresh re-auth; declining one never needs it
          const p = action === 'confirm' ? requireFreshOwner(req, reply) : requireSession(req, reply, true);
          if (!p) return;
          const c = claims.get((req.params as { id: string }).id);
          if (!c || c.userId !== p.userId || c.state !== 'pending' || c.expiresAt <= Date.now())
            return reply.code(404).send({ error: 'not_found' });
          c.state = action === 'confirm' ? 'confirmed' : 'rejected';
          audit(p, `pairing.${action}ed`, c.id, req.ip);
          if (action === 'confirm') {
            // the same security notice as a new passkey; the name came from the phone (printable text only)
            const what = c.platform ? `"${c.deviceName}" (${c.platform})` : `"${c.deviceName}"`;
            void o.notifier
              ?.notify({
                level: 'warn',
                title: 'A device was paired',
                body: `${what} can now sign in to your account.`,
                msg: {
                  title: { key: 'core:server.devicePaired' },
                  body: { key: 'core:server.devicePairedBody', params: { what } },
                },
              })
              .catch(() => {});
          }
          return { ok: true };
        });
      }

      app.post('/api/v1/pairing/claims/:id/session', async (req, reply) => {
        const b = parse(z.object({ claimSecret: z.string().min(16) }), req.body, reply);
        if (!b) return;
        const c = claims.get((req.params as { id: string }).id);
        if (!c || c.secretHash !== hashToken(b.claimSecret) || c.expiresAt <= Date.now())
          return reply.code(404).send({ error: 'not_found' });
        if (c.state === 'pending') return reply.code(202).send({ state: 'pending' });
        claims.delete(c.id);
        if (c.state === 'rejected') return reply.code(403).send({ error: 'rejected' });
        const deviceId = ulid();
        db.prepare(
          'INSERT INTO devices (id, user_id, name, platform, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        ).run(deviceId, c.userId, c.deviceName, c.platform, Date.now());
        const token = createSession(c.userId, req, deviceId);
        setCookie(reply, token);
        return { state: 'confirmed', ...bodyToken(req, token), user: userDTO(c.userId), deviceId };
      });

      app.get('/api/v1/devices', async (req, reply) => {
        const p = requireSession(req, reply, true);
        if (!p) return;
        return {
          devices: db
            .prepare('SELECT id, name, platform, last_seen_at, revoked_at FROM devices WHERE user_id = ?')
            .all(p.userId),
        };
      });
      app.post('/api/v1/devices/:id/revoke', async (req, reply) => {
        const p = requireSession(req, reply, true);
        if (!p) return;
        const id = (req.params as { id: string }).id;
        db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ?').run(
          Date.now(),
          id,
          p.userId,
        );
        db.prepare('DELETE FROM sessions WHERE device_id = ?').run(id);
        audit(p, 'device.revoked', id, req.ip);
        return { ok: true };
      });
    },
  };
}
