/**
 * Passkeys (WebAuthn) for owner sign-in and re-auth (ARCHITECTURE 3.1 `passkeys`, 8 "Stolen device / session").
 * The relying party is the page's own origin: its Origin header must be an allowed origin (4.1) and its hostname
 * is the RP ID, so a passkey made on `localhost` signs in on `localhost` only. Challenges live in memory (5 min).
 * Adding or removing a passkey needs a fresh re-auth of the session (a passkey is itself a re-auth factor, so a
 * stolen session must not be able to mint one). Re-auth by passkey requires user verification (PIN/biometric);
 * sign-in keeps `preferred` so a security key without a PIN can still sign in.
 */
import { randomBytes } from 'node:crypto';
import { ulid } from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface PasskeyHelpers {
  db: Sqlite;
  isAllowedOrigin(origin: string): boolean;
  normalizeOrigin(origin: string): string | null;
  requireSession(
    req: FastifyRequest,
    reply: FastifyReply,
    ownerOnly?: boolean,
  ): { userId: string; sessionId: string } | null;
  /** creates a session for the user, sets the cookie, returns the login body */
  signIn(userId: string, req: FastifyRequest, reply: FastifyReply, action: string): unknown;
  limited(key: string, max: number, windowMs: number): boolean;
  audit(userId: string | null, action: string, target: string | null, ip: string): void;
  /** marks the session as recently re-authenticated; with `forApproval`, for that one approval card only */
  markReauth(sessionId: string, forApproval?: string): void;
  /** true when the session re-authenticated within the re-auth window */
  reauthedWithin(sessionId: string): boolean;
  /** owner-facing in-app notice (security events) */
  notify(userId: string, title: string, body: string): void;
  serverName(): string | null;
}

interface Challenge {
  challenge: string;
  /** registration: the user it is for; login: unset until verified */
  userId: string | null;
  /** `reauth` options require user verification; a `login` challenge never satisfies a re-auth */
  kind: 'register' | 'login' | 'reauth';
  expiresAt: number;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  sign_count: number;
  transports: string;
  created_at: number;
}

/** The page's origin and RP ID, or null when the request has no allowed browser Origin. */
function relyingParty(h: PasskeyHelpers, req: FastifyRequest) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !h.isAllowedOrigin(origin)) return null;
  const norm = h.normalizeOrigin(origin);
  if (!norm) return null;
  return { origin: norm, rpID: new URL(norm).hostname };
}

export function registerPasskeyRoutes(app: FastifyInstance, h: PasskeyHelpers) {
  const { db } = h;
  const challenges = new Map<string, Challenge>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, c] of challenges) if (c.expiresAt <= now) challenges.delete(k);
  };
  const take = (id: string, kind: Challenge['kind']) => {
    sweep();
    const c = challenges.get(id);
    if (!c || c.kind !== kind) return null;
    challenges.delete(id); // single use
    return c;
  };
  const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });
  /** session + a fresh re-auth (password, or a user-verified passkey) within the window; else 401 `reauth_required` */
  const requireFresh = (req: FastifyRequest, reply: FastifyReply) => {
    const p = h.requireSession(req, reply);
    if (!p) return null;
    if (!h.reauthedWithin(p.sessionId)) {
      bad(reply, 'reauth_required', 401);
      return null;
    }
    return p;
  };

  app.get('/api/v1/auth/passkeys', async (req, reply) => {
    const p = h.requireSession(req, reply);
    if (!p) return;
    const rows = db
      .prepare('SELECT id, created_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at')
      .all(p.userId) as { id: string; created_at: number; transports: string }[];
    return {
      passkeys: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        transports: JSON.parse(r.transports),
      })),
    };
  });

  app.delete('/api/v1/auth/passkeys/:id', async (req, reply) => {
    const p = requireFresh(req, reply);
    if (!p) return;
    const id = (req.params as { id: string }).id;
    const r = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, p.userId);
    if (r.changes !== 1) return bad(reply, 'not_found', 404);
    h.audit(p.userId, 'passkey.removed', id, req.ip);
    h.notify(p.userId, 'A passkey was removed', 'A passkey was removed from your account.');
    return { ok: true };
  });

  // ---------- registration (signed-in user adds a passkey) ----------
  app.post('/api/v1/auth/passkey/register/options', async (req, reply) => {
    const p = requireFresh(req, reply);
    if (!p) return;
    const rp = relyingParty(h, req);
    if (!rp) return bad(reply, 'origin_not_allowed', 403);
    const user = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(p.userId) as {
      id: string;
      display_name: string;
    };
    const existing = db
      .prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?')
      .all(p.userId) as { credential_id: string; transports: string }[];
    const options = await generateRegistrationOptions({
      rpName: h.serverName() ?? 'PasaBot',
      rpID: rp.rpID,
      userName: user.display_name,
      userDisplayName: user.display_name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports),
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = ulid();
    challenges.set(challengeId, {
      challenge: options.challenge,
      userId: p.userId,
      kind: 'register',
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  });

  app.post('/api/v1/auth/passkey/register/verify', async (req, reply) => {
    const p = requireFresh(req, reply);
    if (!p) return;
    const b = z
      .object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()) })
      .safeParse(req.body);
    if (!b.success) return bad(reply, 'invalid_input');
    const rp = relyingParty(h, req);
    if (!rp) return bad(reply, 'origin_not_allowed', 403);
    const c = take(b.data.challengeId, 'register');
    if (!c || c.userId !== p.userId) return bad(reply, 'challenge_expired');
    let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      v = await verifyRegistrationResponse({
        response: b.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: c.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch {
      return bad(reply, 'passkey_invalid');
    }
    if (!v.verified) return bad(reply, 'passkey_invalid');
    const cred = v.registrationInfo.credential;
    const id = ulid();
    db.prepare(
      'INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      p.userId,
      cred.id,
      Buffer.from(cred.publicKey),
      cred.counter,
      JSON.stringify(cred.transports ?? []),
      Date.now(),
    );
    h.audit(p.userId, 'passkey.added', id, req.ip);
    h.notify(p.userId, 'A passkey was added', 'A new passkey can now sign in to your account.');
    return reply.code(201).send({ passkey: { id } });
  });

  // ---------- authentication (sign in, or re-auth of the current session) ----------
  app.post('/api/v1/auth/passkey/login/options', async (req, reply) => {
    if (h.limited(`passkey:${req.ip}`, 20, 60_000)) return bad(reply, 'rate_limited', 429);
    const rp = relyingParty(h, req);
    if (!rp) return bad(reply, 'origin_not_allowed', 403);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'preferred',
      challenge: randomBytes(32),
    });
    const challengeId = ulid();
    sweep();
    challenges.set(challengeId, {
      challenge: options.challenge,
      userId: null,
      kind: 'login',
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  });

  // re-auth of the current session: user verification (PIN/biometric) is required, unlike sign-in
  app.post('/api/v1/auth/passkey/reauth/options', async (req, reply) => {
    const p = h.requireSession(req, reply);
    if (!p) return;
    if (h.limited(`passkey:${req.ip}`, 20, 60_000)) return bad(reply, 'rate_limited', 429);
    const rp = relyingParty(h, req);
    if (!rp) return bad(reply, 'origin_not_allowed', 403);
    const mine = db
      .prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?')
      .all(p.userId) as {
      credential_id: string;
      transports: string;
    }[];
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'required',
      challenge: randomBytes(32),
      allowCredentials: mine.map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports) })),
    });
    const challengeId = ulid();
    sweep();
    challenges.set(challengeId, {
      challenge: options.challenge,
      userId: p.userId,
      kind: 'reauth',
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  });

  /**
   * Verifies an assertion against a stored passkey; returns the passkey's user id or null.
   * `reauth` takes only a `reauth` challenge and requires the UV flag (a touch alone is not "confirm it's you").
   */
  const verifyAssertion = async (
    req: FastifyRequest,
    body: unknown,
    kind: 'login' | 'reauth',
  ): Promise<string | null> => {
    const b = z
      .object({ challengeId: z.string(), response: z.object({ id: z.string() }).passthrough() })
      .safeParse(body);
    if (!b.success) return null;
    const rp = relyingParty(h, req);
    if (!rp) return null;
    const c = take(b.data.challengeId, kind);
    if (!c) return null;
    const row = db
      .prepare(
        `SELECT p.* FROM passkeys p JOIN users u ON u.id = p.user_id
         WHERE p.credential_id = ? AND u.disabled_at IS NULL`,
      )
      .get(b.data.response.id) as PasskeyRow | undefined;
    if (!row) return null;
    try {
      const v = await verifyAuthenticationResponse({
        response: b.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: c.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.sign_count,
          transports: JSON.parse(row.transports),
        },
        requireUserVerification: kind === 'reauth',
      });
      if (!v.verified) return null;
      if (kind === 'reauth' && (c.userId !== row.user_id || !v.authenticationInfo.userVerified)) return null;
      db.prepare('UPDATE passkeys SET sign_count = ? WHERE id = ?').run(
        v.authenticationInfo.newCounter,
        row.id,
      );
      return row.user_id;
    } catch {
      return null;
    }
  };

  app.post('/api/v1/auth/passkey/login/verify', async (req, reply) => {
    if (h.limited(`passkey:${req.ip}`, 20, 60_000)) return bad(reply, 'rate_limited', 429);
    const userId = await verifyAssertion(req, req.body, 'login');
    if (!userId) {
      h.audit(null, 'auth.passkey_failed', null, req.ip);
      return bad(reply, 'invalid_credentials', 401);
    }
    return h.signIn(userId, req, reply, 'auth.passkey_login');
  });

  /**
   * Re-auth of the current session (tier-3 approvals, 8): the owner's password or a passkey of the same user.
   * Marks the session; approvals that need it check `reauthedWithin`.
   */
  return {
    async reauth(req: FastifyRequest, reply: FastifyReply, check: (password: string) => Promise<boolean>) {
      const p = h.requireSession(req, reply);
      if (!p) return;
      if (h.limited(`reauth:${req.ip}`, 10, 60_000)) return bad(reply, 'rate_limited', 429);
      const body = req.body as { password?: unknown; passkey?: unknown; for?: unknown } | undefined;
      // `for`: the approval card this re-auth answers (8, "Screen helpers"); it then counts for that card alone
      const forApproval =
        typeof body?.for === 'string' && /^[0-9A-Za-z]{1,40}$/.test(body.for) ? body.for : undefined;
      let ok = false;
      if (typeof body?.password === 'string') ok = await check(body.password);
      else if (body?.passkey) ok = (await verifyAssertion(req, body.passkey, 'reauth')) === p.userId;
      if (!ok) {
        h.audit(p.userId, 'auth.reauth_failed', null, req.ip);
        return bad(reply, 'invalid_credentials', 401);
      }
      h.markReauth(p.sessionId, forApproval);
      h.audit(p.userId, 'auth.reauth', null, req.ip);
      return { ok: true };
    },
  };
}
