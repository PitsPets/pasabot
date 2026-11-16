/**
 * Automation tokens (ARCHITECTURE 3.1 `automation_tokens`, 4.1, 7.4): the token model and the guards W0b owns.
 * The automation API itself (`/api/m/automation/*`: issuing/listing tokens over REST, `POST runs`, poll/stream,
 * agent CLI verbs) is W21. What lives here: per-agent tokens stored only as a hash, trust capped at `standard`,
 * optional expiry, loopback-only unless `remote_ok`, refused whenever an `Origin` header is present (both in the
 * auth resolver), a per-token run budget (default 30 runs/hour), and the sender an automation turn runs as —
 * never `owner`, so tier 3 (and tier 2) never auto-approve (approvals `autoApproves`).
 */
import { randomBytes } from 'node:crypto';
import {
  AutomationAccessError,
  type AutomationActor,
  type AutomationTokenInfo,
  type AutomationTokens,
  type Principal,
  type SenderInfo,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import type { TrustLevel } from '@pasabot/protocol';
import { hashToken } from '../core/services.js';

export const AUTOMATION_MAX_TRUST: TrustLevel = 'standard';
export const AUTOMATION_DEFAULT_RATE_PER_HOUR = 30;
const HOUR_MS = 3600_000;

export class AutomationTokenError extends Error {}

export interface IssueAutomationToken {
  agentId: string;
  /** at most `standard`; `trusted` is refused */
  trust?: TrustLevel;
  scopes?: string[];
  /** accept the token from non-loopback addresses (still never with an Origin header) */
  remoteOk?: boolean;
  ratePerHour?: number;
  expiresAt?: number | null;
  /** owner user id that minted it (issuing is owner-session REST only, 7.4) */
  createdBy: string;
  createdTrust?: TrustLevel;
}

/** Mint a token; only its sha256 is stored. Returns the raw token once. */
export function issueAutomationToken(
  db: Sqlite,
  o: IssueAutomationToken,
  now = Date.now(),
): { id: string; token: string } {
  const trust = o.trust ?? AUTOMATION_MAX_TRUST;
  if (trust !== 'guarded' && trust !== 'standard')
    throw new AutomationTokenError(`automation tokens are capped at "${AUTOMATION_MAX_TRUST}"`);
  const rate = o.ratePerHour ?? AUTOMATION_DEFAULT_RATE_PER_HOUR;
  if (!Number.isInteger(rate) || rate < 1)
    throw new AutomationTokenError('ratePerHour must be a positive integer');
  if (o.expiresAt != null && o.expiresAt <= now) throw new AutomationTokenError('expiresAt is in the past');
  const agent = db.prepare('SELECT 1 FROM agents WHERE id = ? AND archived_at IS NULL').get(o.agentId);
  if (!agent) throw new AutomationTokenError('unknown agent');
  const id = ulid();
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO automation_tokens (id, agent_id, token_hash, scopes, trust, remote_ok, rate_per_hour, created_by,
       created_trust, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.agentId,
    hashToken(token),
    JSON.stringify(o.scopes ?? []),
    trust,
    o.remoteOk ? 1 : 0,
    rate,
    o.createdBy,
    o.createdTrust ?? 'trusted',
    now,
    o.expiresAt ?? null,
  );
  return { id, token };
}

export function revokeAutomationToken(db: Sqlite, id: string, now = Date.now()): boolean {
  return (
    db.prepare('UPDATE automation_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
      .changes === 1
  );
}

/** Queue-item `source` for a run started with an automation token: carries the sender and the token id. */
export function automationSource(db: Sqlite, p: Extract<Principal, { kind: 'automation' }>) {
  return { sender: automationSender(db, p), automation: { tokenId: p.tokenId } };
}

/** The sender an automation turn runs as: never the owner, trust = the token's (≤ `standard`). */
export function automationSender(db: Sqlite, p: Extract<Principal, { kind: 'automation' }>): SenderInfo {
  const r = db.prepare('SELECT trust FROM automation_tokens WHERE id = ?').get(p.tokenId) as
    | { trust: TrustLevel }
    | undefined;
  const trust: TrustLevel = r?.trust === 'guarded' ? 'guarded' : AUTOMATION_MAX_TRUST;
  return { kind: 'automation', id: p.tokenId, name: `automation:${p.tokenId}`, trust };
}

interface TokenRow {
  id: string;
  agent_id: string;
  scopes: string;
  trust: TrustLevel;
  remote_ok: number;
  rate_per_hour: number;
  created_by: string;
  created_trust: TrustLevel;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}
const tokenInfo = (r: TokenRow): AutomationTokenInfo => {
  let scopes: string[] = [];
  try {
    const j = JSON.parse(r.scopes);
    if (Array.isArray(j)) scopes = j.filter((x): x is string => typeof x === 'string');
  } catch {
    // a malformed scopes cell grants nothing
  }
  return {
    id: r.id,
    agentId: r.agent_id,
    scopes,
    trust: r.trust,
    remoteOk: r.remote_ok === 1,
    ratePerHour: r.rate_per_hour,
    createdBy: r.created_by,
    createdTrust: r.created_trust,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
};
const COLS = `id, agent_id, scopes, trust, remote_ok, rate_per_hour, created_by, created_trust, created_at, expires_at,
  last_used_at, revoked_at`;

/** The live owner behind `actor`, checked against the sessions table (never trusted from the object's shape). */
function liveOwner(db: Sqlite, actor: AutomationActor, now = Date.now()): string {
  if (actor?.kind !== 'session' || actor.userKind !== 'owner')
    throw new AutomationAccessError('owner session required');
  const ok = db
    .prepare(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.kind = 'owner' AND u.disabled_at IS NULL`,
    )
    .get(actor.sessionId, actor.userId, now);
  if (!ok) throw new AutomationAccessError('owner session required');
  return actor.userId;
}
/**
 * The read rule for one token (`get`, `isActive`, `budget`): a live owner session or `asSystem(reason)` may read
 * any token; an automation principal only itself (its id and its agent); everyone else is refused.
 */
function mayRead(db: Sqlite, actor: AutomationActor, tokenId: string): void {
  if (actor?.kind === 'system' && typeof actor.reason === 'string' && actor.reason.length > 0) return;
  if (actor?.kind === 'automation') {
    const r = db.prepare('SELECT agent_id FROM automation_tokens WHERE id = ?').get(actor.tokenId) as
      | { agent_id: string }
      | undefined;
    if (actor.tokenId === tokenId && r && r.agent_id === actor.agentId) return;
    throw new AutomationAccessError('an automation token may read only itself');
  }
  liveOwner(db, actor);
}
const auditToken = (db: Sqlite, userId: string, action: string, tokenId: string, data: object = {}) =>
  db
    .prepare(
      'INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target, ip, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(ulid(), Date.now(), 'user', userId, action, tokenId, null, JSON.stringify(data));
const isActiveToken = (db: Sqlite, id: string, now = Date.now()) =>
  !!db
    .prepare(
      'SELECT 1 FROM automation_tokens WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
    )
    .get(id, now);

/**
 * The `ModuleHost.automation` port (W21's module): these helpers, never the hash. Every call takes the acting
 * principal and checks it here (refusals throw `AutomationAccessError`), like the ChatPort: issue, revoke and list
 * need a live owner session (7.4; `createdBy` is that owner; issue/revoke are audit-logged); get, isActive and
 * budget also take `asSystem(reason)` (the dispatch-time check) or a token reading itself; `source` takes the
 * calling token's own principal and refuses a revoked or expired token.
 */
export function automationPort(db: Sqlite): AutomationTokens {
  return {
    issue(actor, o) {
      const userId = liveOwner(db, actor);
      const r = issueAutomationToken(db, { ...o, createdBy: userId, createdTrust: 'trusted' });
      auditToken(db, userId, 'automation.token_issued', r.id, {
        agentId: o.agentId,
        trust: o.trust ?? AUTOMATION_MAX_TRUST,
        remoteOk: !!o.remoteOk,
        expiresAt: o.expiresAt ?? null,
      });
      return r;
    },
    revoke(actor, id) {
      const userId = liveOwner(db, actor);
      const done = revokeAutomationToken(db, id);
      if (done) auditToken(db, userId, 'automation.token_revoked', id);
      return done;
    },
    get(actor, id) {
      mayRead(db, actor, id);
      const r = db.prepare(`SELECT ${COLS} FROM automation_tokens WHERE id = ?`).get(id) as
        | TokenRow
        | undefined;
      return r ? tokenInfo(r) : null;
    },
    list(actor, o = {}) {
      liveOwner(db, actor);
      return (
        db
          .prepare(
            `SELECT ${COLS} FROM automation_tokens WHERE (? IS NULL OR agent_id = ?) ORDER BY created_at DESC, id DESC`,
          )
          .all(o.agentId ?? null, o.agentId ?? null) as TokenRow[]
      ).map(tokenInfo);
    },
    isActive(actor, id, now) {
      mayRead(db, actor, id);
      return isActiveToken(db, id, now);
    },
    source(actor) {
      if (actor?.kind !== 'automation') throw new AutomationAccessError('automation token required');
      const r = db.prepare('SELECT agent_id FROM automation_tokens WHERE id = ?').get(actor.tokenId) as
        | { agent_id: string }
        | undefined;
      if (!r || r.agent_id !== actor.agentId)
        throw new AutomationAccessError('an automation token may source only its own runs');
      if (!isActiveToken(db, actor.tokenId)) throw new AutomationTokenError('token revoked or expired');
      return automationSource(db, { kind: 'automation', tokenId: actor.tokenId, agentId: r.agent_id });
    },
    budget(actor, tokenId, now) {
      mayRead(db, actor, tokenId);
      return automationRunBudget(db, tokenId, now);
    },
  };
}

/**
 * Per-token run budget over the last hour (default 30). Counts the queue items this token started (tagged by
 * `automationSource`), so it survives restarts. W21's `POST runs` answers 429 + Retry-After when `ok` is false.
 */
export function automationRunBudget(
  db: Sqlite,
  tokenId: string,
  now = Date.now(),
): { ok: true; remaining: number } | { ok: false; retryAfterSec: number } {
  const t = db.prepare('SELECT rate_per_hour FROM automation_tokens WHERE id = ?').get(tokenId) as
    | { rate_per_hour: number }
    | undefined;
  const limit = t?.rate_per_hour ?? AUTOMATION_DEFAULT_RATE_PER_HOUR;
  const rows = db
    .prepare(
      `SELECT created_at FROM queue_items WHERE json_extract(source, '$.automation.tokenId') = ? AND created_at > ?
       ORDER BY created_at`,
    )
    .all(tokenId, now - HOUR_MS) as { created_at: number }[];
  if (rows.length < limit) return { ok: true, remaining: limit - rows.length };
  const oldest = rows[rows.length - limit]!.created_at;
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
}
