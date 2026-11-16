/**
 * W31 safety suite: the global stop's REST and report, skill permission manifests (run-time guard + pre-install
 * scan in a worker) and per-run receipts with a timeline, redacted export and retention. Receipts are built from
 * server-side bus events only (run, tool call, approval decision, usage), never from what the agent says it did.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  httpResponse,
  KillSwitchError,
  type ModuleHost,
  type Principal,
  type SenderInfo,
  type StopActor,
} from '@pasabot/core';
import {
  type ApprovalDTO,
  minTrust,
  type RunDTO,
  type RunEventDTO,
  type TrustLevel,
} from '@pasabot/protocol';
import { z } from 'zod';
import { checkUse, manifestSchema, narrows, type SkillManifest } from './manifest.js';
import { type Finding, scanSkill } from './scan.js';

declare module '@pasabot/protocol' {
  interface EventMap {
    'safety.changed': { stopped: boolean; since: number | null };
  }
}

export const DEFAULT_RETENTION_DAYS = 30;
const DAY = 86_400_000;

export interface ReceiptRow {
  id: string;
  agent_id: string;
  chat_id: string | null;
  queue_item_id: string | null;
  queue_kind: string | null;
  state: string;
  started_at: number;
  finished_at: number | null;
  input_tokens: number;
  output_tokens: number;
  cost: number | null;
  cost_currency: string | null;
  export_path: string | null;
}
export interface ReceiptItem {
  n: number;
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface SafetyOptions {
  now?: () => number;
  /** how often expired receipts are pruned (default hourly; 0 = never on a timer) */
  pruneEveryMs?: number;
  scanTimeoutMs?: number;
}

const receiptView = (r: ReceiptRow) => ({
  id: r.id,
  runId: r.id,
  agentId: r.agent_id,
  chatId: r.chat_id,
  queueItemId: r.queue_item_id,
  kind: r.queue_kind,
  state: r.state,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.finished_at ? r.finished_at - r.started_at : null,
  tokens: { input: r.input_tokens, output: r.output_tokens },
  /** from the W32 budget's `budget.cost` event: null until it is in, or when no price is set for the model */
  cost: r.cost,
  currency: r.cost_currency,
});

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

function ownerOnly(p: Principal) {
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
}

/** Who is calling, as a stop actor. Members and guests may not stop through REST (owner, tokens and agents may). */
function actorOf(p: Principal): StopActor {
  if (p.kind === 'session') {
    if (p.userKind !== 'owner') throw new HttpError(403, 'only the owner may stop from the app', 'forbidden');
    return { kind: 'owner', userId: p.userId, sessionId: p.sessionId };
  }
  if (p.kind === 'automation') return { kind: 'automation', tokenId: p.tokenId, agentId: p.agentId };
  return { kind: 'agent', agentId: p.agentId, runId: p.runId };
}

/** a skill id a manifest may be stored under */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

export function createSafetyModule(o: SafetyOptions = {}) {
  const now = o.now ?? Date.now;
  let host: ModuleHost | null = null;
  let timer: NodeJS.Timeout | null = null;

  const redactDeep = (v: unknown): unknown => {
    if (!host) return v;
    return JSON.parse(host.redact(JSON.stringify(v ?? null)));
  };

  // ---------- receipts ----------
  function ensure(runId: string, at: number): void {
    const app = host!;
    app.raw
      .prepare(
        "INSERT OR IGNORE INTO safety_receipts (id, agent_id, state, started_at) VALUES (?, '', 'running', ?)",
      )
      .run(runId, at);
  }
  function addItem(runId: string, kind: string, data: Record<string, unknown>, at = now()): void {
    const app = host!;
    ensure(runId, at);
    const next = app.raw
      .prepare('SELECT coalesce(max(n), -1) + 1 AS n FROM safety_receipt_items WHERE receipt_id = ?')
      .get(runId) as { n: number };
    app.raw
      .prepare('INSERT INTO safety_receipt_items (receipt_id, n, at, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(runId, next.n, at, kind, JSON.stringify(redactDeep(data)));
  }
  function onRunStarted(r: RunDTO): void {
    const app = host!;
    ensure(r.id, r.startedAt);
    const q = app.queue.get(r.queueItemId);
    app.raw
      .prepare(
        'UPDATE safety_receipts SET agent_id = ?, chat_id = ?, queue_item_id = ?, queue_kind = ?, started_at = ? WHERE id = ?',
      )
      .run(r.agentId, q?.chatId ?? null, r.queueItemId, q?.kind ?? null, r.startedAt, r.id);
    addItem(
      r.id,
      'run.started',
      { provider: r.providerId, model: r.model, kind: q?.kind ?? null },
      r.startedAt,
    );
  }
  /** W32: the budget books a finished run's cost (`budget.cost`); the receipt records it (null = price not set) */
  function onCost(d: { runId?: unknown; cost?: { amount?: unknown; currency?: unknown } | null }): void {
    const app = host!;
    if (typeof d?.runId !== 'string') return;
    const has = app.raw.prepare('SELECT 1 FROM safety_receipts WHERE id = ?').get(d.runId);
    if (!has) return;
    const amount =
      typeof d.cost?.amount === 'number' && Number.isFinite(d.cost.amount) ? d.cost.amount : null;
    const currency =
      amount !== null && typeof d.cost?.currency === 'string' ? d.cost.currency.slice(0, 10) : null;
    app.raw
      .prepare('UPDATE safety_receipts SET cost = ?, cost_currency = ? WHERE id = ?')
      .run(amount, currency, d.runId);
  }
  function onRunFinished(r: RunDTO): void {
    const app = host!;
    ensure(r.id, r.startedAt);
    addItem(r.id, 'run.finished', { state: r.state, stopReason: r.stopReason }, r.finishedAt ?? now());
    app.raw
      .prepare(
        'UPDATE safety_receipts SET state = ?, finished_at = ?, input_tokens = max(input_tokens, ?), output_tokens = max(output_tokens, ?) WHERE id = ?',
      )
      .run(r.state, r.finishedAt ?? now(), r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0, r.id);
  }
  async function keepScreenshot(runId: string, sha: string): Promise<string | null> {
    const app = host!;
    if (!/^[a-f0-9]{64}$/.test(sha)) return null;
    const dir = join(app.dataDir, 'screenshots', runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${sha}.png`);
    try {
      await pipeline(app.files.open(sha), createWriteStream(file, { mode: 0o600 }));
      return `${sha}.png`;
    } catch {
      return null;
    }
  }
  function onRunEvent(e: RunEventDTO): void {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case 'tool.call':
        addItem(e.runId, 'tool.call', { id: d.id, name: d.name, input: d.input });
        break;
      case 'tool.result':
        addItem(e.runId, 'tool.result', {
          id: d.id,
          ok: d.ok,
          summary: String(d.summary ?? '').slice(0, 500),
        });
        break;
      case 'permission':
        addItem(e.runId, 'permission', { id: d.id, tool: d.tool, input: d.input });
        break;
      case 'usage': {
        const app = host!;
        ensure(e.runId, now());
        app.raw
          .prepare(
            'UPDATE safety_receipts SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?',
          )
          .run(Number(d.inputTokens) || 0, Number(d.outputTokens) || 0, e.runId);
        addItem(e.runId, 'usage', { inputTokens: d.inputTokens, outputTokens: d.outputTokens });
        break;
      }
      case 'text.final':
        addItem(e.runId, 'reply', {
          chars: String(d.text ?? '').length,
          preview: String(d.text ?? '').slice(0, 280),
        });
        break;
      case 'error':
        addItem(e.runId, 'error', { kind: d.kind, message: String(d.message ?? '').slice(0, 500) });
        break;
      case 'subagent':
        addItem(e.runId, 'subagent', { id: d.id, name: d.name, state: d.state });
        break;
      default: {
        // a browser/computer module's run event that carries a screenshot blob
        const shot = (d.screenshot ?? null) as { sha256?: string } | null;
        if (shot?.sha256) {
          const sha = shot.sha256;
          void keepScreenshot(e.runId, sha).then((file) => {
            if (file) addItem(e.runId, 'screenshot', { file, source: e.type, url: d.url ?? null });
          });
        } else if (typeof d.url === 'string') addItem(e.runId, 'link', { source: e.type, url: d.url });
      }
    }
  }
  function onApproval(type: string, a: ApprovalDTO): void {
    if (!a.runId) return;
    const app = host!;
    const kind = type === 'approval.requested' ? 'approval.requested' : 'approval.decided';
    const seen = app.raw
      .prepare(
        "SELECT 1 FROM safety_receipt_items WHERE receipt_id = ? AND kind = ? AND json_extract(data, '$.id') = ?",
      )
      .get(a.runId, kind, a.id);
    if (seen) return;
    addItem(
      a.runId,
      kind,
      kind === 'approval.requested'
        ? { id: a.id, tier: a.tier, summary: a.summary, class: a.ask?.class ?? null }
        : {
            id: a.id,
            decision: a.state,
            // who decided: the deciding user (null when it expired); the server records it, never the agent
            decidedBy: a.decidedBy,
            decidedAt: a.decidedAt,
            summary: a.summary,
          },
      kind === 'approval.decided' ? (a.decidedAt ?? now()) : now(),
    );
  }

  function receipt(id: string): { receipt: ReceiptRow; items: ReceiptItem[] } | null {
    const app = host!;
    const r = app.raw.prepare('SELECT * FROM safety_receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
    if (!r) return null;
    const items = (
      app.raw
        .prepare('SELECT n, at, kind, data FROM safety_receipt_items WHERE receipt_id = ? ORDER BY n')
        .all(id) as { n: number; at: number; kind: string; data: string }[]
    ).map((i) => ({ ...i, data: JSON.parse(i.data) as Record<string, unknown> }));
    return { receipt: r, items };
  }

  function exportJson(id: string) {
    const r = receipt(id);
    if (!r) return null;
    // redacted again on the way out (7.3): a value that became a secret after the event was stored is caught too
    return redactDeep({
      format: 'pasabot.receipt',
      version: 1,
      exportedAt: now(),
      receipt: receiptView(r.receipt),
      items: r.items.map((i) =>
        i.kind === 'screenshot' ? { ...i, data: { ...i.data, file: undefined } } : i,
      ),
    }) as Record<string, unknown>;
  }

  function exportHtml(j: Record<string, unknown>): string {
    const rec = j.receipt as ReturnType<typeof receiptView>;
    const items = j.items as ReceiptItem[];
    const rows = items
      .map(
        (i) =>
          `<tr><td>${i.n + 1}</td><td>${esc(new Date(i.at).toISOString())}</td><td>${esc(i.kind)}</td><td><pre>${esc(JSON.stringify(i.data, null, 2))}</pre></td></tr>`,
      )
      .join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${esc(rec.id)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:16px;color:#1d1d1f;background:#fff}table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:6px;vertical-align:top;font-size:14px}pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:13px}</style></head><body><h1>Receipt</h1><p>Run ${esc(rec.runId)} · agent ${esc(rec.agentId)} · ${esc(rec.state)} · ${rec.tokens.input} in / ${rec.tokens.output} out tokens</p><table>${rows}</table></body></html>`;
  }

  async function prune(at = now()): Promise<{ deleted: number }> {
    const app = host!;
    const days = app.config.get<number>('retentionDays', DEFAULT_RETENTION_DAYS);
    const cutoff = at - days * DAY;
    const old = app.raw
      .prepare('SELECT id, export_path FROM safety_receipts WHERE started_at < ?')
      .all(cutoff) as { id: string; export_path: string | null }[];
    for (const r of old) {
      await rm(join(app.dataDir, 'screenshots', r.id), { recursive: true, force: true });
      if (r.export_path) await app.sitesOrigin.remove(r.export_path).catch(() => {});
      app.raw.prepare('DELETE FROM safety_receipt_items WHERE receipt_id = ?').run(r.id);
      app.raw.prepare('DELETE FROM safety_receipts WHERE id = ?').run(r.id);
    }
    return { deleted: old.length };
  }

  // ---------- skill manifests ----------
  interface ManifestRow {
    manifest: string;
    trust: TrustLevel;
    created_by_kind: string;
    approved: number;
    proposal: string | null;
    proposal_by: string | null;
    proposal_trust: TrustLevel | null;
    proposal_at: number | null;
  }
  function manifestOf(skillId: string): {
    manifest: SkillManifest;
    trust: TrustLevel;
    createdByKind: string;
    /** false: an agent wrote it and the owner has not approved it; the guard enforces nothing from it */
    approved: boolean;
    /** an agent's widening or first manifest, waiting for the owner */
    proposal: {
      manifest: SkillManifest;
      by: string | null;
      trust: TrustLevel | null;
      at: number | null;
      /** what the owner saw: approve/reject may send it back and get 409 when the proposal changed since (W39) */
      version: string;
    } | null;
  } | null {
    const r = host!.raw
      .prepare(
        'SELECT manifest, trust, created_by_kind, approved, proposal, proposal_by, proposal_trust, proposal_at FROM safety_skill_manifests WHERE skill_id = ?',
      )
      .get(skillId) as ManifestRow | undefined;
    return r
      ? {
          manifest: manifestSchema.parse(JSON.parse(r.manifest)),
          trust: r.trust,
          createdByKind: r.created_by_kind,
          approved: r.approved === 1,
          proposal: r.proposal
            ? {
                manifest: manifestSchema.parse(JSON.parse(r.proposal)),
                by: r.proposal_by,
                trust: r.proposal_trust,
                at: r.proposal_at,
                version: proposalVersion(r),
              }
            : null,
        }
      : null;
  }

  /** a proposal's version: its exact text, author, trust and time (a re-sent proposal is a new version) */
  const proposalVersion = (r: ManifestRow): string =>
    createHash('sha256')
      .update(JSON.stringify([r.proposal, r.proposal_by, r.proposal_trust, r.proposal_at]))
      .digest('hex')
      .slice(0, 32);
  /** the owner decided on the version shown; a different (or vanished) proposal is a conflict, never approved blind */
  const decidedBody = z.object({ version: z.string().min(1).max(64).optional() }).optional();
  const checkVersion = (
    m: NonNullable<ReturnType<typeof manifestOf>>['proposal'],
    sent: string | undefined,
  ) => {
    if (sent !== undefined && m && m.version !== sent)
      throw new HttpError(
        409,
        'the proposal changed since you opened it; reload and look again',
        'proposal_changed',
      );
  };

  const summaryOf = (findings: Finding[]) => {
    const kinds = [...new Set(findings.map((f) => f.kind))];
    return { kinds, count: findings.length };
  };

  const mod = defineModule({
    id: 'safety',
    migrations: join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations'),
    register(app) {
      host = app;

      // the stop's live state for every signed-in tab
      app.killSwitch.watch((s) =>
        app.bus.publish('owner', 'safety.changed', { stopped: s.stopped, since: s.since }),
      );

      app.bus.subscribe((ev) => {
        try {
          if (ev.live) return;
          if (ev.type === 'run.started') onRunStarted(ev.data as RunDTO);
          else if (ev.type === 'run.finished') onRunFinished(ev.data as RunDTO);
          else if (ev.type === 'run.event') onRunEvent(ev.data as RunEventDTO);
          else if (ev.type === 'budget.cost') onCost(ev.data as Parameters<typeof onCost>[0]);
          else if (ev.type === 'approval.requested' || ev.type === 'approval.resolved')
            onApproval(ev.type, ev.data as ApprovalDTO);
        } catch (e) {
          app.log.warn('receipt event failed', {
            type: ev.type,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });

      // run-time manifest check: a run acting for a skill (queue payload `skill`) may use only what it declared.
      // The binding only ever narrows a run (a run without it is not restricted here). Known gap (FEATURES, ROADMAP):
      // no production path sets `skill` yet, because the agent CLI picks synced skills itself in ordinary turns.
      app.tools.addGuard(({ name, input, def, run, agent, actionClass }) => {
        const payload = (app.queue.input(run.queueItemId)?.payload ?? {}) as { skill?: unknown };
        if (typeof payload.skill !== 'string' || !payload.skill) return null;
        const skillId = payload.skill;
        const m = manifestOf(skillId);
        const refusal = !m
          ? `the skill "${skillId}" has no permission manifest, so it may not use any tool`
          : !m.approved
            ? `the skill "${skillId}" has no permission manifest the owner approved, so it may not use any tool`
            : checkUse(skillId, m.manifest, {
                name,
                input,
                // the gateway's resolved class (a dynamic class included); the static one as a fallback
                actionClass:
                  actionClass ?? (typeof def.actionClass === 'string' ? def.actionClass : undefined),
                workspace: agent.workspaceDir,
              });
        if (refusal) addItem(run.id, 'refused', { tool: name, skill: skillId, reason: refusal });
        return refusal;
      });

      const days = () => app.config.get<number>('retentionDays', DEFAULT_RETENTION_DAYS);
      if ((o.pruneEveryMs ?? 3_600_000) > 0) {
        timer = setInterval(() => void prune().catch(() => {}), o.pruneEveryMs ?? 3_600_000);
        timer.unref?.();
      }

      // ---------- stop ----------
      app.http.route({
        method: 'GET',
        url: '/state',
        auth: ['session', 'automation', 'run'],
        handler: (ctx) => {
          const s = app.killSwitch.state();
          const p = ctx.principal;
          // the report (owner's id, every agent's chats, routine and workflow names) is the owner's alone;
          // everyone else learns only whether things are stopped
          if (p.kind === 'session' && p.userKind === 'owner') return { ...s, view: 'owner' as const };
          return { stopped: s.stopped, since: s.since, view: 'limited' as const };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/stop',
        auth: ['session', 'automation', 'run'],
        body: z.object({ reason: z.string().max(200).optional() }).optional(),
        handler: async (ctx: AuthedCtx<{ reason?: string } | undefined>) => {
          const p = ctx.principal;
          const report = await app.killSwitch.stopAll(actorOf(p), ctx.body?.reason ?? 'stop button');
          const s = app.killSwitch.state();
          // as GET /state: only the owner sees what was stopped across every agent
          if (p.kind === 'session' && p.userKind === 'owner')
            return { state: { ...s, view: 'owner' as const }, report };
          return { state: { stopped: s.stopped, since: s.since, view: 'limited' as const } };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/resume',
        auth: ['session', 'automation', 'run'],
        handler: (ctx) => {
          const p = ctx.principal;
          const actor: StopActor =
            p.kind === 'session' && p.userKind === 'owner'
              ? { kind: 'owner', userId: p.userId, sessionId: p.sessionId }
              : p.kind === 'automation'
                ? { kind: 'automation', tokenId: p.tokenId, agentId: p.agentId }
                : p.kind === 'run'
                  ? { kind: 'agent', agentId: p.agentId, runId: p.runId }
                  : { kind: 'channel', id: `member:${p.userId}` };
          try {
            return app.killSwitch.resume(actor, { reauthed: p.kind === 'session' && p.reauthed === true });
          } catch (e) {
            if (e instanceof KillSwitchError)
              throw new HttpError(e.code === 'reauth_required' ? 401 : 403, e.message, e.code);
            throw e;
          }
        },
      });

      // ---------- receipts ----------
      app.http.route({
        method: 'GET',
        url: '/receipts',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx.principal);
          const agentId = typeof ctx.query.agentId === 'string' ? ctx.query.agentId : null;
          const rows = (
            agentId
              ? app.raw
                  .prepare(
                    'SELECT * FROM safety_receipts WHERE agent_id = ? ORDER BY started_at DESC LIMIT 200',
                  )
                  .all(agentId)
              : app.raw.prepare('SELECT * FROM safety_receipts ORDER BY started_at DESC LIMIT 200').all()
          ) as ReceiptRow[];
          const counts = app.raw
            .prepare('SELECT receipt_id AS id, count(*) AS c FROM safety_receipt_items GROUP BY receipt_id')
            .all() as { id: string; c: number }[];
          const by = new Map(counts.map((c) => [c.id, c.c]));
          return {
            receipts: rows.map((r) => ({ ...receiptView(r), steps: by.get(r.id) ?? 0 })),
            retentionDays: days(),
          };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/receipts/:id',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx.principal);
          const r = receipt(ctx.params.id ?? '');
          if (!r) throw new HttpError(404, 'no such receipt', 'not_found');
          return { receipt: receiptView(r.receipt), items: r.items };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/receipts/:id/export.json',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx.principal);
          const j = exportJson(ctx.params.id ?? '');
          if (!j) throw new HttpError(404, 'no such receipt', 'not_found');
          return httpResponse(200, j, {
            'content-disposition': `attachment; filename="receipt-${ctx.params.id}.json"`,
          });
        },
      });
      app.http.route({
        method: 'POST',
        url: '/receipts/:id/export',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx.principal);
          const id = ctx.params.id ?? '';
          const j = exportJson(id);
          if (!j) throw new HttpError(404, 'no such receipt', 'not_found');
          const prev = app.raw.prepare('SELECT export_path FROM safety_receipts WHERE id = ?').get(id) as {
            export_path: string | null;
          };
          if (prev.export_path) await app.sitesOrigin.remove(prev.export_path).catch(() => {});
          // the readable view lives only on the sandboxed sites origin, under an unguessable path
          const path = `receipts/${crypto.randomUUID()}/receipt.html`;
          await app.sitesOrigin.put(path, exportHtml(j), 'text/html; charset=utf-8');
          app.raw.prepare('UPDATE safety_receipts SET export_path = ? WHERE id = ?').run(path, id);
          return { htmlUrl: app.sitesOrigin.url(path), jsonUrl: `/api/m/safety/receipts/${id}/export.json` };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/receipts/:id/screenshots/:file',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx.principal);
          const file = ctx.params.file ?? '';
          if (!/^[a-f0-9]{64}\.png$/.test(file)) throw new HttpError(404, 'not found', 'not_found');
          const { readFile } = await import('node:fs/promises');
          try {
            const bytes = await readFile(join(app.dataDir, 'screenshots', ctx.params.id ?? '', file));
            return httpResponse(200, bytes, { 'content-type': 'image/png' });
          } catch {
            throw new HttpError(404, 'not found', 'not_found');
          }
        },
      });
      app.http.route({
        method: 'GET',
        url: '/settings',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx.principal);
          return { retentionDays: days() };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/settings',
        auth: 'session',
        body: z.object({ retentionDays: z.number().int().min(1).max(3650) }),
        handler: async (ctx: AuthedCtx<{ retentionDays: number }>) => {
          ownerOnly(ctx.principal);
          app.config.set('retentionDays', ctx.body.retentionDays);
          const res = await prune();
          return { retentionDays: days(), deleted: res.deleted };
        },
      });

      // ---------- skills ----------
      app.http.route({
        method: 'POST',
        url: '/scan',
        auth: 'session',
        bodyLimit: 8 * 1024 * 1024,
        body: z.object({
          files: z
            .array(z.object({ name: z.string().max(200), text: z.string() }))
            .min(1)
            .max(50),
          manifest: manifestSchema.optional(),
        }),
        handler: async (
          ctx: AuthedCtx<{ files: { name: string; text: string }[]; manifest?: SkillManifest }>,
        ) => {
          ownerOnly(ctx.principal);
          const res = await scanSkill(ctx.body.files, o.scanTimeoutMs);
          return { ...res, summary: summaryOf(res.findings), wants: ctx.body.manifest ?? null };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/skills/:id/manifest',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx.principal);
          // a skill with nothing recorded yet is an ordinary answer, not an error: the Skills page asks for every
          // skill it lists, and a 404 each time filled the console with errors for the built-in ones (W40)
          return manifestOf(ctx.params.id ?? '') ?? { manifest: null, approved: false, proposal: null };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/skills/:id/manifest',
        auth: ['session', 'run'],
        body: z.object({
          manifest: manifestSchema,
          files: z
            .array(z.object({ name: z.string(), text: z.string() }))
            .max(50)
            .optional(),
        }),
        handler: async (
          ctx: AuthedCtx<{ manifest: SkillManifest; files?: { name: string; text: string }[] }>,
        ) => {
          const p = ctx.principal;
          const skillId = ctx.params.id ?? '';
          if (!SKILL_ID_RE.test(skillId)) throw new HttpError(400, 'bad skill id', 'bad_request');
          const prev = manifestOf(skillId);
          const scan = ctx.body.files?.length ? await scanSkill(ctx.body.files, o.scanTimeoutMs) : null;
          const scanOut = scan ? { status: scan.status, summary: summaryOf(scan.findings) } : null;
          if (p.kind === 'session') {
            ownerOnly(p);
            // the owner may widen (7.4); an owner-written manifest starts at trusted and replaces any proposal
            app.raw
              .prepare(
                `INSERT INTO safety_skill_manifests (skill_id, manifest, trust, created_by_kind, created_by, findings, updated_at, approved)
                 VALUES (?, ?, 'trusted', 'owner', ?, ?, ?, 1)
                 ON CONFLICT(skill_id) DO UPDATE SET manifest = excluded.manifest, trust = excluded.trust,
                   created_by_kind = excluded.created_by_kind, created_by = excluded.created_by,
                   findings = excluded.findings, updated_at = excluded.updated_at, approved = 1,
                   proposal = NULL, proposal_by = NULL, proposal_trust = NULL, proposal_findings = NULL, proposal_at = NULL`,
              )
              .run(
                skillId,
                JSON.stringify(ctx.body.manifest),
                p.userId,
                scan ? JSON.stringify(scan.findings) : null,
                now(),
              );
            return { skillId, trust: 'trusted', createdByKind: 'owner', pending: false, scan: scanOut };
          }
          let trust: TrustLevel;
          let createdBy: string;
          if (p.kind === 'run') {
            const agent = await app.agents.get(p.agentId);
            if (!agent) throw new HttpError(403, 'unknown agent', 'forbidden');
            const qid = (
              app.raw.prepare('SELECT queue_item_id FROM safety_receipts WHERE id = ?').get(p.runId) as
                | { queue_item_id: string | null }
                | undefined
            )?.queue_item_id;
            const sender = (qid ? (app.queue.input(qid)?.source.sender ?? null) : null) as SenderInfo | null;
            // lowest trust in the chain: the agent, the run's sender (unknown = guarded), an earlier version
            trust = minTrust(agent.trustLevel, sender?.trust ?? 'guarded', ...(prev ? [prev.trust] : []));
            createdBy = p.agentId;
          } else throw new HttpError(403, 'not allowed', 'forbidden');
          const next = ctx.body.manifest;
          if (prev?.approved && narrows(next, prev.manifest)) {
            // narrowing an approved manifest needs no owner: it can only take permissions away
            app.raw
              .prepare(
                `UPDATE safety_skill_manifests SET manifest = ?, trust = ?, created_by_kind = 'agent', created_by = ?,
                   findings = ?, updated_at = ? WHERE skill_id = ?`,
              )
              .run(
                JSON.stringify(next),
                trust,
                createdBy,
                scan ? JSON.stringify(scan.findings) : null,
                now(),
                skillId,
              );
            return { skillId, trust, createdByKind: 'agent', pending: false, scan: scanOut };
          }
          // a first manifest or a widening from an agent is only a proposal: the enforced manifest stays as it was
          // (none = the skill may use nothing) until the owner approves it (7.4: only the owner widens)
          app.raw
            .prepare(
              `INSERT INTO safety_skill_manifests (skill_id, manifest, trust, created_by_kind, created_by, findings, updated_at,
                 approved, proposal, proposal_by, proposal_trust, proposal_findings, proposal_at)
               VALUES (?, '{}', ?, 'agent', ?, NULL, ?, 0, ?, ?, ?, ?, ?)
               ON CONFLICT(skill_id) DO UPDATE SET proposal = excluded.proposal, proposal_by = excluded.proposal_by,
                 proposal_trust = excluded.proposal_trust, proposal_findings = excluded.proposal_findings,
                 proposal_at = excluded.proposal_at`,
            )
            .run(
              skillId,
              trust,
              createdBy,
              now(),
              JSON.stringify(next),
              createdBy,
              trust,
              scan ? JSON.stringify(scan.findings) : null,
              now(),
            );
          return httpResponse(202, {
            skillId,
            trust,
            createdByKind: 'agent',
            pending: true,
            scan: scanOut,
          });
        },
      });
      // W31 x W32: the agent bundle carries the approved manifests of the agent's skills; an imported one is only
      // ever a proposal the owner approves or rejects (7.4: only the owner widens), never an approved manifest.
      // The host's wrapper checks the actor (the owner user or asSystem) before these run.
      app.skillManifests.setPort({
        exportManifests: async (_actor, skillIds) => {
          const out: { skillId: string; manifest: SkillManifest }[] = [];
          for (const id of new Set(skillIds)) {
            if (!SKILL_ID_RE.test(id)) continue;
            const m = manifestOf(id);
            if (m?.approved) out.push({ skillId: id, manifest: m.manifest });
          }
          return out;
        },
        importProposals: async (_actor, entries, o) => {
          // everything is checked first; the writes then go in one transaction
          const valid: { skillId: string; manifest: SkillManifest }[] = [];
          let skipped = 0;
          for (const e of entries) {
            const parsed = manifestSchema.safeParse(e.manifest);
            if (typeof e.skillId !== 'string' || !SKILL_ID_RE.test(e.skillId) || !parsed.success) skipped++;
            else valid.push({ skillId: e.skillId, manifest: parsed.data });
          }
          const trust = minTrust('guarded', o.maxTrust);
          let proposed = 0;
          app.raw.transaction(() => {
            for (const e of valid) {
              const prev = manifestOf(e.skillId);
              // never over a proposal the owner has not decided yet, and nothing to ask when it is already approved
              if (
                prev?.proposal ||
                (prev?.approved && JSON.stringify(prev.manifest) === JSON.stringify(e.manifest))
              ) {
                skipped++;
                continue;
              }
              app.raw
                .prepare(
                  `INSERT INTO safety_skill_manifests (skill_id, manifest, trust, created_by_kind, created_by, findings, updated_at,
                     approved, proposal, proposal_by, proposal_trust, proposal_findings, proposal_at)
                   VALUES (?, '{}', ?, 'agent', ?, NULL, ?, 0, ?, ?, ?, NULL, ?)
                   ON CONFLICT(skill_id) DO UPDATE SET proposal = excluded.proposal, proposal_by = excluded.proposal_by,
                     proposal_trust = excluded.proposal_trust, proposal_findings = NULL, proposal_at = excluded.proposal_at`,
                )
                .run(e.skillId, trust, o.by, now(), JSON.stringify(e.manifest), o.by, trust, now());
              proposed++;
            }
          })();
          return { proposed, skipped };
        },
      });

      // W39: every proposal waiting for the owner (the Skills page's "Proposed permissions" and the decision bar)
      app.http.route({
        method: 'GET',
        url: '/skills/proposals',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx.principal);
          const ids = app.raw
            .prepare(
              'SELECT skill_id FROM safety_skill_manifests WHERE proposal IS NOT NULL ORDER BY proposal_at, skill_id',
            )
            .all() as { skill_id: string }[];
          return {
            proposals: ids.flatMap(({ skill_id }) => {
              const m = manifestOf(skill_id);
              return m?.proposal
                ? [{ skillId: skill_id, approved: m.approved, current: m.manifest, ...m.proposal }]
                : [];
            }),
          };
        },
      });
      // the owner decides on an agent's proposal (approve makes it the enforced manifest, at its lowest trust)
      app.http.route({
        method: 'POST',
        url: '/skills/:id/manifest/approve',
        auth: 'session',
        body: decidedBody,
        handler: (ctx: AuthedCtx<{ version?: string } | undefined>) => {
          ownerOnly(ctx.principal);
          const skillId = ctx.params.id ?? '';
          const m = manifestOf(skillId);
          if (!m?.proposal)
            throw ctx.body?.version
              ? new HttpError(409, 'the proposal is gone; reload and look again', 'proposal_changed')
              : new HttpError(404, 'no proposal', 'not_found');
          checkVersion(m.proposal, ctx.body?.version);
          app.raw
            .prepare(
              `UPDATE safety_skill_manifests SET manifest = proposal, trust = coalesce(proposal_trust, 'guarded'),
                 created_by_kind = 'agent', created_by = coalesce(proposal_by, created_by),
                 findings = proposal_findings, approved = 1, updated_at = ?,
                 proposal = NULL, proposal_by = NULL, proposal_trust = NULL, proposal_findings = NULL, proposal_at = NULL
               WHERE skill_id = ?`,
            )
            .run(now(), skillId);
          return manifestOf(skillId);
        },
      });
      app.http.route({
        method: 'POST',
        url: '/skills/:id/manifest/reject',
        auth: 'session',
        body: decidedBody,
        handler: (ctx: AuthedCtx<{ version?: string } | undefined>) => {
          ownerOnly(ctx.principal);
          const skillId = ctx.params.id ?? '';
          const m = manifestOf(skillId);
          if (!m?.proposal)
            throw ctx.body?.version
              ? new HttpError(409, 'the proposal is gone; reload and look again', 'proposal_changed')
              : new HttpError(404, 'no proposal', 'not_found');
          checkVersion(m.proposal, ctx.body?.version);
          if (!m.approved)
            app.raw.prepare('DELETE FROM safety_skill_manifests WHERE skill_id = ?').run(skillId);
          else
            app.raw
              .prepare(
                `UPDATE safety_skill_manifests SET proposal = NULL, proposal_by = NULL, proposal_trust = NULL,
                   proposal_findings = NULL, proposal_at = NULL WHERE skill_id = ?`,
              )
              .run(skillId);
          return { skillId, rejected: true };
        },
      });
    },
  });

  return Object.assign(mod, {
    prune,
    receipt,
    exportJson,
    stopTimers() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}

export default createSafetyModule();
