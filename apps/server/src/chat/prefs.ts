/**
 * Simplify spec 4: per-user UI preferences and the owner's "Not using this" list.
 *   GET /api/v1/me/prefs                -> { prefs: { 'ui.pins': string[], 'ui.tidied': boolean, 'ui.advanced': boolean } }
 *                                          (own row only; 'ui.advanced' = the Settings "Advanced" switch, off by default)
 *   PUT /api/v1/me/prefs/:key           -> any signed-in person, own row only; known keys only
 *   GET /api/v1/settings/features       -> { hidden: string[] } (any signed-in person, only the ids their role may see)
 *   PUT /api/v1/settings/features       -> owner only; never-hideable ids are refused
 * Pins and hides are a UI matter only: they never open a page or a call a role may not use (every module route
 * still checks its own role), and a hidden feature keeps running. Pinned ids of hidden features are dropped, and a
 * member's or guest's pins keep only the features their role may see (`featureAllows`, the slots' own rule), so an
 * owner-only id is never stored for them nor handed back.
 */
import type { Principal } from '@pasabot/core';
import { featureAllows, NEVER_HIDDEN_FEATURES } from '@pasabot/core/web';
import type { Sqlite } from '@pasabot/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthResolver } from '../core/services.js';

type Session = Extract<Principal, { kind: 'session' }>;

const featureId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/);
/** Features the owner can never hide (spec 4.2): one list with the web catalog (`NEVER_HIDDEN_FEATURES`). */
export const NEVER_HIDDEN: ReadonlySet<string> = new Set(NEVER_HIDDEN_FEATURES);
const MAX_PINS = 40;

const PREFS = {
  'ui.pins': z
    .array(featureId)
    .max(200)
    .transform((a) => [...new Set(a)].slice(0, MAX_PINS)),
  'ui.tidied': z.boolean(),
  /** Settings shows every group and the technical labels (off: only the groups a first-timer needs) */
  'ui.advanced': z.boolean(),
  /** the chats list's "Team talk" group (helpers' conversations with each other) is open; closed by default */
  'ui.teamTalk': z.boolean(),
} as const;
type PrefKey = keyof typeof PREFS;
const DEFAULTS: Record<PrefKey, unknown> = {
  'ui.pins': [],
  'ui.tidied': false,
  'ui.advanced': false,
  'ui.teamTalk': false,
};

export function registerPrefsRoutes(app: FastifyInstance, d: { db: Sqlite; resolveAuth: AuthResolver }) {
  const { db } = d;
  const auth = (req: FastifyRequest, reply: FastifyReply, ownerOnly = false): Session | null => {
    const p = d.resolveAuth({ headers: req.headers, ip: req.ip });
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
  const hidden = (): string[] => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'features.hidden'").get() as
      | { value: string }
      | undefined;
    const v = z.array(featureId).safeParse(r ? JSON.parse(r.value) : []);
    return v.success ? v.data : [];
  };
  /** the ids this person may keep or learn about: all for the owner, the shared rule for members and guests */
  const mayKeep = (p: Session, ids: string[]) =>
    p.userKind === 'owner' ? ids : ids.filter((id) => featureAllows(id, p.userKind));
  /**
   * 'ui.tidied' unset: only an account that existed before the simplified UI arrived (created before the
   * `user_prefs` migration ran on this server) gets the "We tidied up" card; a newer one never saw the old UI.
   */
  const tidiedDefault = (userId: string): boolean => {
    const m = db
      .prepare("SELECT MIN(applied_at) AS t FROM _migrations WHERE name LIKE '%user_prefs%'")
      .get() as { t: number | null } | undefined;
    const u = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId) as
      | { created_at: number }
      | undefined;
    return !m?.t || !u || u.created_at >= m.t;
  };
  const read = (p: Session) => {
    const userId = p.userId;
    const rows = db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(userId) as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = { ...DEFAULTS, 'ui.tidied': tidiedDefault(userId) };
    for (const r of rows) {
      const schema = PREFS[r.key as PrefKey];
      if (!schema) continue;
      const v = schema.safeParse(JSON.parse(r.value));
      if (v.success) out[r.key] = v.data;
    }
    const gone = new Set(hidden());
    out['ui.pins'] = mayKeep(
      p,
      (out['ui.pins'] as string[]).filter((id) => !gone.has(id)),
    );
    return out;
  };

  app.get('/api/v1/me/prefs', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    return { prefs: read(p) };
  });
  app.put('/api/v1/me/prefs/:key', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    const key = (req.params as { key: string }).key as PrefKey;
    const schema = PREFS[key];
    if (!schema || !Object.hasOwn(PREFS, key)) return reply.code(404).send({ error: 'unknown_pref' });
    const r = z.object({ value: schema }).safeParse(req.body ?? {});
    if (!r.success) return reply.code(400).send({ error: 'invalid_input', message: r.error.message });
    let value: unknown = r.data.value;
    if (key === 'ui.pins') {
      const gone = new Set(hidden());
      value = mayKeep(
        p,
        (value as string[]).filter((id) => !gone.has(id)),
      );
    }
    db.prepare(
      `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(p.userId, key, JSON.stringify(value), Date.now());
    return { prefs: read(p) };
  });

  app.get('/api/v1/settings/features', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return;
    return { hidden: mayKeep(p, hidden()) };
  });
  app.put('/api/v1/settings/features', async (req, reply) => {
    const p = auth(req, reply, true);
    if (!p) return;
    const r = z.object({ hidden: z.array(featureId).max(200) }).safeParse(req.body ?? {});
    if (!r.success) return reply.code(400).send({ error: 'invalid_input', message: r.error.message });
    const refused = r.data.hidden.filter((id) => NEVER_HIDDEN.has(id));
    if (refused.length) return reply.code(400).send({ error: 'not_hideable', message: refused.join(', ') });
    const list = [...new Set(r.data.hidden)];
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('features.hidden', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(list));
    return { hidden: list };
  });
}
