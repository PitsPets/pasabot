/**
 * Channels module (W4b): the `channels_*` tables and the owner REST for Settings → Channels. The binding runtime
 * itself (connections, inbound → chats, replies out) lives in the server (`apps/server/src/channels`) because it
 * writes core chat rows; it reads these tables and is told about changes through `channels.changed` on the bus.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  type ChannelAdapter,
  HttpError,
  hashChannelLinkCode,
  httpResponse,
  type ModuleHost,
  newChannelLinkCode,
  type PasaBotModule,
  promotePairingState,
  type SecretRef,
  ulid,
  vaultChannelState,
  vaultPairingState,
} from '@pasabot/core';
import QRCode from 'qrcode';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

/** How long a link code stays valid. */
export const LINK_CODE_TTL_MS = 10 * 60_000;
/** Max ids in an allowed-senders list. */
const MAX_ALLOWED = 200;
const VAULT_SCOPE = 'module:channels';

export interface ChannelBindingDTO {
  id: string;
  kind: string;
  label: string;
  agentId: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastEventAt: number | null;
  statusAt: number | null;
  dropped: number;
  allowedSenders: string[];
  /** which secret fields are stored (values are never returned) */
  secretsSet: string[];
  /** non-secret settings (e.g. WhatsApp own-number mode) */
  options: Record<string, string | boolean>;
  owner: { externalUserId: string; name: string; linkedAt: number } | null;
  places: { id: string; title: string; kind: string; chatId: string | null }[];
  /** false when no adapter of this kind is installed on the server */
  available: boolean;
  createdAt: number;
}
export interface ChannelKindDTO {
  kind: string;
  secretFields: string[];
  /** non-secret settings the owner may set (name -> type) */
  options: Record<string, 'boolean' | 'string'>;
  /** linked by a pairing flow (WhatsApp QR), which starts only after the owner acknowledges the risk notice */
  pairing: boolean;
  /** the platform posts events to `/hooks/channels/<bindingId>/events` */
  inboundHttp: boolean;
}
/** Pairing session state, polled by Settings → Channels while the QR code is shown. */
export interface PairingDTO {
  state: 'idle' | 'waiting' | 'linked' | 'error';
  /** the current QR code as an SVG data URL (rotates every ~20 s) */
  qrSvg: string | null;
  code: string | null;
  error: string | null;
  updatedAt: number;
}
/** How long one pairing attempt may wait for a scan. */
export const PAIRING_TTL_MS = 3 * 60_000;

declare module '@pasabot/protocol' {
  interface EventMap {
    /** config changed: the runtime (re)starts or stops that binding */
    'channels.changed': { bindingId: string; removed?: boolean; restart?: boolean };
    /** status changed (connected, error, last event) */
    'channels.status': { bindingId: string; status: string; lastError: string | null; at: number };
  }
}

interface BindingRow {
  id: string;
  kind: string;
  label: string;
  config: string;
  secret_refs: string;
  status: string;
  orchestrator_agent_id: string;
  enabled: number;
  last_error: string | null;
  last_event_at: number | null;
  status_at: number | null;
  dropped: number;
  created_by: string;
  created_at: number;
}

const senderId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s]+$/, 'one id, no spaces');
const optionsBody = z.record(z.string().max(40), z.union([z.boolean(), z.string().max(500)]));
const createBody = z.object({
  kind: z.string().min(1).max(40),
  label: z.string().trim().max(80).optional(),
  agentId: z.string().min(1),
  /** secret field values (the bot token); stored in the vault, never echoed back */
  secrets: z.record(z.string(), z.string().min(1).max(4096)),
  options: optionsBody.optional(),
  allowedSenders: z.array(senderId).max(MAX_ALLOWED).optional(),
});
const patchBody = z.object({
  label: z.string().trim().max(80).optional(),
  agentId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  secrets: z.record(z.string(), z.string().min(1).max(4096)).optional(),
  options: optionsBody.optional(),
  allowedSenders: z.array(senderId).max(MAX_ALLOWED).optional(),
});
/** starting a pairing requires the owner to have read and accepted the risk notice */
const pairingBody = z.object({ acknowledgeRisk: z.literal(true) });

function ownerOnly(ctx: AuthedCtx): { userId: string } {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return { userId: p.userId };
}

export function bindingDTO(app: ModuleHost, r: BindingRow): ChannelBindingDTO {
  const { allowedSenders, ...options } = JSON.parse(r.config) as Record<string, unknown> & {
    allowedSenders?: string[];
  };
  const owner = app.raw
    .prepare(
      "SELECT external_user_id, name, linked_at FROM channels_sender WHERE binding_id = ? AND trust = 'owner' ORDER BY linked_at DESC LIMIT 1",
    )
    .get(r.id) as { external_user_id: string; name: string; linked_at: number } | undefined;
  const places = app.raw
    .prepare('SELECT id, title, kind, chat_id FROM channels_place WHERE binding_id = ? ORDER BY created_at')
    .all(r.id) as { id: string; title: string; kind: string; chat_id: string | null }[];
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    agentId: r.orchestrator_agent_id,
    enabled: r.enabled === 1,
    status: r.status,
    lastError: r.last_error,
    lastEventAt: r.last_event_at,
    statusAt: r.status_at,
    dropped: r.dropped,
    allowedSenders: allowedSenders ?? [],
    options: options as Record<string, string | boolean>,
    secretsSet: Object.keys(JSON.parse(r.secret_refs) as Record<string, SecretRef>),
    owner: owner
      ? { externalUserId: owner.external_user_id, name: owner.name, linkedAt: owner.linked_at }
      : null,
    places: places.map((p) => ({ id: p.id, title: p.title, kind: p.kind, chatId: p.chat_id })),
    available: !!app.channels.get(r.kind),
    createdAt: r.created_at,
  };
}

/** Check the adapter accepts the secrets (and its defaults) without keeping or echoing the values. */
function checkConfig(
  adapter: ChannelAdapter<any> | undefined,
  secrets: Record<string, string>,
  options: Record<string, unknown> = {},
  partial = false,
) {
  if (!adapter) throw new HttpError(400, 'no channel adapter of this kind is installed', 'unknown_kind');
  const fields = adapter.secretFields.map(String);
  for (const k of Object.keys(secrets))
    if (!fields.includes(k)) throw new HttpError(400, `"${k}" is not a secret field`, 'invalid_config');
  const allowedOptions = adapter.options ?? {};
  for (const [k, v] of Object.entries(options))
    if (!(k in allowedOptions) || typeof v !== (allowedOptions as Record<string, string>)[k])
      throw new HttpError(400, `"${k}" is not a setting of this channel`, 'invalid_config');
  // a PATCH may replace one secret or one setting: only the fields it sends are checked
  const full = adapter.configSchema;
  const schema = partial ? ((full as { partial?: () => typeof full }).partial?.() ?? full) : full;
  const res = schema.safeParse({ ...options, ...secrets });
  if (!res.success) {
    // messages only (zod issue text never carries the value), so a pasted token is not reflected back
    const msg = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new HttpError(400, msg, 'invalid_config');
  }
}

async function storeSecrets(
  app: ModuleHost,
  bindingId: string,
  secrets: Record<string, string>,
  prev: Record<string, SecretRef>,
) {
  const refs = { ...prev };
  for (const [k, v] of Object.entries(secrets))
    refs[k] = await app.vault.put(VAULT_SCOPE, `binding:${bindingId}:${k}`, v);
  return refs;
}

/** QR as an SVG data URL, rendered on the server so the web module needs no QR library. */
async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function audit(app: ModuleHost, userId: string, action: string, target: string, data: unknown = {}) {
  app.raw
    .prepare(
      "INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target, data) VALUES (?, ?, 'user', ?, ?, ?, ?)",
    )
    .run(ulid(), Date.now(), userId, action, target, JSON.stringify(data));
}

export function createChannelsModule(): PasaBotModule {
  return {
    id: 'channels',
    migrations: join(here, '..', 'migrations'),
    register(app) {
      /** live pairing sessions by binding id (one at a time per binding; in memory only) */
      const pairings = new Map<string, { abort: AbortController; dto: PairingDTO }>();
      const row = (id: string) =>
        app.raw.prepare('SELECT * FROM channels_binding WHERE id = ?').get(id) as BindingRow | undefined;
      const mustRow = (id: string) => {
        const r = row(id);
        if (!r) throw new HttpError(404, 'binding not found', 'not_found');
        return r;
      };
      const changed = (bindingId: string, extra: { removed?: boolean; restart?: boolean } = {}) =>
        app.bus.publish('module:channels', 'channels.changed', { bindingId, ...extra });

      app.http.route({
        method: 'GET',
        url: '/bindings',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          const rows = app.raw
            .prepare('SELECT * FROM channels_binding ORDER BY created_at')
            .all() as BindingRow[];
          const kinds: ChannelKindDTO[] = app.channels.list().map((c) => ({
            kind: c.kind,
            secretFields: c.secretFields.map(String),
            options: (c.options ?? {}) as Record<string, 'boolean' | 'string'>,
            pairing: typeof c.pairing === 'function',
            inboundHttp: !!c.inboundHttp,
          }));
          return { bindings: rows.map((r) => bindingDTO(app, r)), kinds };
        },
      });

      app.http.route({
        method: 'POST',
        url: '/bindings',
        auth: 'session',
        body: createBody,
        handler: async (ctx) => {
          const { userId } = ownerOnly(ctx);
          const b = ctx.body;
          const agent = await app.agents.get(b.agentId);
          if (!agent || agent.archivedAt) throw new HttpError(404, 'agent not found', 'not_found');
          const adapter = app.channels.get(b.kind);
          checkConfig(adapter, b.secrets, b.options);
          const id = ulid();
          const refs = await storeSecrets(app, id, b.secrets, {});
          app.raw
            .prepare(
              "INSERT INTO channels_binding (id, kind, label, config, secret_refs, status, orchestrator_agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?)",
            )
            .run(
              id,
              b.kind,
              b.label ?? '',
              JSON.stringify({ ...(b.options ?? {}), allowedSenders: b.allowedSenders ?? [] }),
              JSON.stringify(refs),
              b.agentId,
              `user:${userId}`,
              Date.now(),
            );
          audit(app, userId, 'channel.binding_added', id, { kind: b.kind, agentId: b.agentId });
          changed(id);
          return httpResponse(201, { binding: bindingDTO(app, mustRow(id)) });
        },
      });

      app.http.route({
        method: 'PATCH',
        url: '/bindings/:id',
        auth: 'session',
        body: patchBody,
        handler: async (ctx) => {
          const { userId } = ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          const b = ctx.body;
          if (b.agentId) {
            const agent = await app.agents.get(b.agentId);
            if (!agent || agent.archivedAt) throw new HttpError(404, 'agent not found', 'not_found');
          }
          let refs = JSON.parse(r.secret_refs) as Record<string, SecretRef>;
          if (b.secrets && Object.keys(b.secrets).length) {
            checkConfig(app.channels.get(r.kind), b.secrets, {}, true);
            refs = await storeSecrets(app, r.id, b.secrets, refs);
          }
          const cfg = JSON.parse(r.config) as Record<string, unknown> & { allowedSenders?: string[] };
          if (b.options && Object.keys(b.options).length) {
            checkConfig(app.channels.get(r.kind), {}, b.options, true);
            Object.assign(cfg, b.options);
          }
          if (b.allowedSenders) cfg.allowedSenders = [...new Set(b.allowedSenders)];
          app.raw
            .prepare(
              'UPDATE channels_binding SET label = ?, orchestrator_agent_id = ?, enabled = ?, config = ?, secret_refs = ? WHERE id = ?',
            )
            .run(
              b.label ?? r.label,
              b.agentId ?? r.orchestrator_agent_id,
              b.enabled === undefined ? r.enabled : b.enabled ? 1 : 0,
              JSON.stringify(cfg),
              JSON.stringify(refs),
              r.id,
            );
          // sender trust is owner-only widening (4.1): every change is audited
          audit(app, userId, 'channel.binding_updated', r.id, {
            fields: Object.keys(b).filter((k) => k !== 'secrets'),
            secrets: Object.keys(b.secrets ?? {}),
            ...(b.allowedSenders ? { allowedSenders: cfg.allowedSenders } : {}),
          });
          changed(r.id, { restart: true });
          return { binding: bindingDTO(app, mustRow(r.id)) };
        },
      });

      app.http.route({
        method: 'DELETE',
        url: '/bindings/:id',
        auth: 'session',
        handler: async (ctx) => {
          const { userId } = ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          pairings.get(r.id)?.abort.abort();
          app.raw.prepare('DELETE FROM channels_binding WHERE id = ?').run(r.id);
          // a linked-device session (WhatsApp) is dropped with the binding
          await vaultChannelState(app.vault, r.id, 'module:channels')
            .save('')
            .catch(() => {});
          await vaultPairingState(app.vault, r.id, 'module:channels')
            .save('')
            .catch(() => {});
          audit(app, userId, 'channel.binding_removed', r.id, { kind: r.kind });
          changed(r.id, { removed: true });
          return httpResponse(204);
        },
      });

      app.http.route({
        method: 'POST',
        url: '/bindings/:id/restart',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          changed(r.id, { restart: true });
          return { ok: true };
        },
      });

      // one-time owner link code: shown once here, sent from the owner's account in a DM with the bot
      app.http.route({
        method: 'POST',
        url: '/bindings/:id/link',
        auth: 'session',
        handler: (ctx) => {
          const { userId } = ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          const now = Date.now();
          // a new code retires the earlier unused ones of this binding
          app.raw
            .prepare(
              "UPDATE channels_link SET used_at = ?, outcome = 'replaced' WHERE binding_id = ? AND used_at IS NULL",
            )
            .run(now, r.id);
          const code = newChannelLinkCode();
          const expiresAt = now + LINK_CODE_TTL_MS;
          app.raw
            .prepare('INSERT INTO channels_link (code_hash, binding_id, expires_at) VALUES (?, ?, ?)')
            .run(hashChannelLinkCode(code), r.id, expiresAt);
          audit(app, userId, 'channel.link_code_issued', r.id);
          return { code, expiresAt, command: `/link ${code}` };
        },
      });

      // unlinking the owner only narrows access
      app.http.route({
        method: 'DELETE',
        url: '/bindings/:id/owner',
        auth: 'session',
        handler: (ctx) => {
          const { userId } = ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          app.raw.prepare("DELETE FROM channels_sender WHERE binding_id = ? AND trust = 'owner'").run(r.id);
          audit(app, userId, 'channel.owner_unlinked', r.id);
          return { binding: bindingDTO(app, mustRow(r.id)) };
        },
      });

      // ---------- pairing (WhatsApp QR link as a linked device) ----------
      const pairingOf = (id: string): PairingDTO =>
        pairings.get(id)?.dto ?? { state: 'idle', qrSvg: null, code: null, error: null, updatedAt: 0 };

      app.http.route({
        method: 'POST',
        url: '/bindings/:id/pairing',
        auth: 'session',
        body: pairingBody,
        handler: async (ctx) => {
          const { userId } = ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          const adapter = app.channels.get(r.kind);
          if (!adapter?.pairing) throw new HttpError(400, 'this channel has no pairing flow', 'no_pairing');
          // only an unlinked binding pairs: one that is linked (even while it reconnects after a network flap) has a
          // live connection saving its working session, which a new pairing must never race or replace
          if (r.enabled && r.status !== 'auth_failed')
            throw new HttpError(409, 'this channel is already linked', 'already_linked');
          pairings.get(r.id)?.abort.abort();
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), PAIRING_TTL_MS);
          const dto: PairingDTO = {
            state: 'waiting',
            qrSvg: null,
            code: null,
            error: null,
            updatedAt: Date.now(),
          };
          const session = { abort, dto };
          pairings.set(r.id, session);
          // the owner read and accepted the terms-of-service / ban-risk notice before this call
          audit(app, userId, 'channel.pairing_started', r.id, { kind: r.kind, riskAcknowledged: true });
          const set = (patch: Partial<PairingDTO>) => {
            if (pairings.get(r.id) !== session) return;
            Object.assign(dto, patch, { updatedAt: Date.now() });
          };
          // the pairing writes into a staging entry; the live session is replaced only when the pairing is done
          const staging = vaultPairingState(app.vault, r.id, 'module:channels');
          const clearStaging = () => staging.save('').catch(() => {});
          void (async () => {
            let linked = false;
            try {
              await staging.save('');
              for await (const step of adapter.pairing!({
                bindingId: r.id,
                log: app.log.child({ channel: r.kind, bindingId: r.id, part: 'pairing' }),
                signal: abort.signal,
                state: staging,
              })) {
                if (abort.signal.aborted) break;
                if (step.qr) set({ qrSvg: await qrDataUrl(step.qr), code: step.code ?? null });
                else if (step.code) set({ code: step.code });
                if (step.done) {
                  if (pairings.get(r.id) !== session || abort.signal.aborted) break;
                  if (!(await promotePairingState(app.vault, r.id, 'module:channels'))) break;
                  linked = true;
                  set({ state: 'linked', qrSvg: null, code: null });
                  audit(app, userId, 'channel.paired', r.id, { kind: r.kind });
                  // reconnect with the stored session
                  changed(r.id, { restart: true });
                  break;
                }
              }
              if (dto.state === 'waiting')
                set({ state: 'error', qrSvg: null, error: abort.signal.aborted ? 'expired' : 'ended' });
            } catch (e) {
              set({
                state: 'error',
                qrSvg: null,
                error: app.redact(e instanceof Error ? e.message : String(e)),
              });
            } finally {
              clearTimeout(timer);
              // an aborted, expired or failed pairing leaves nothing behind (a newer pairing clears it on start)
              const current = pairings.get(r.id);
              if (!linked && (!current || current === session)) await clearStaging();
            }
          })();
          return httpResponse(202, { pairing: dto });
        },
      });

      app.http.route({
        method: 'GET',
        url: '/bindings/:id/pairing',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          return { pairing: pairingOf(r.id) };
        },
      });

      app.http.route({
        method: 'DELETE',
        url: '/bindings/:id/pairing',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          const r = mustRow(ctx.params.id!);
          pairings.get(r.id)?.abort.abort();
          pairings.delete(r.id);
          return { pairing: pairingOf(r.id) };
        },
      });

      // ---------- public inbound over HTTP (Slack Events) ----------
      app.publicHttp.route({
        method: 'POST',
        url: '/:bindingId/events',
        rateLimit: { max: 600, windowMs: 60_000 },
        bodyLimit: 1024 * 1024,
        handler: async (ctx) => {
          const r = row(String(ctx.params.bindingId ?? ''));
          if (!r || !app.channels.get(r.kind)?.inboundHttp || !app.channels.deliverHttp)
            return httpResponse(404, { error: 'not_found' });
          const res = await app.channels.deliverHttp(r.id, {
            method: 'POST',
            headers: ctx.headers,
            rawBody: ctx.rawBody,
          });
          return httpResponse(res.status, res.body ?? null, res.headers ?? {});
        },
      });
    },
  };
}

export default createChannelsModule();
