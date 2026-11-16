/**
 * Admin/ops (W19): host identity, audit log viewer, machine metrics + alert rules (through the Notifier), per-agent
 * memory/CPU limits (through RunnerLimits), a redacted diagnostics zip, and agent export/import bundles (through the
 * core AgentAdmin port). Every route is owner-session only. Nothing here ever reads a secret value: the
 * diagnostics zip holds only generated summaries and log tails, all passed through the redaction filter and then
 * scanned once more against every value the vault knows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  ulid,
} from '@pasabot/core';
import { agentBundleSchema } from '@pasabot/protocol';
import { z } from 'zod';
import {
  type AlertRule,
  alertRuleSchema,
  hostSampler,
  METRICS,
  type Sample,
  type Sampler,
} from './metrics.js';
import { zip } from './zip.js';

export { alertRuleSchema, type Sample, type Sampler } from './metrics.js';
export { zip } from './zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();
const KEEP_MS = 7 * 24 * 3600_000;

export interface AdminOptions {
  /** machine sampler (default: this host) */
  sampler?: Sampler;
  /** sample interval (default 60 s; 0 = off, tests call `tick()`) */
  sampleMs?: number;
  now?: () => number;
}

export interface AlertDTO {
  id: string;
  rule: AlertRule;
  createdAt: number;
  lastFiredAt: number | null;
}
export interface AuditEntry {
  id: string;
  at: number;
  actorKind: string;
  actorId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  data: string;
}

declare module '@pasabot/protocol' {
  interface EventMap {
    'admin.alert': { id: string; name: string; metric: string; value: number; above: number };
  }
}

function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return p;
}

export class Admin {
  readonly home: string;
  constructor(
    private readonly app: ModuleHost,
    private readonly o: AdminOptions = {},
    private readonly sampler: Sampler = o.sampler ?? hostSampler(resolve(app.dataDir, '..', '..')),
  ) {
    this.home = resolve(app.dataDir, '..', '..');
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }

  audit(actorId: string | null, action: string, target: string | null, data: Record<string, unknown> = {}) {
    this.app.raw
      .prepare(
        "INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target, data) VALUES (?, ?, 'user', ?, ?, ?, ?)",
      )
      .run(ulid(), this.now(), actorId, action, target, JSON.stringify(data));
  }

  identity() {
    const r = this.app.raw.prepare("SELECT value FROM settings WHERE key = 'server.id'").get() as
      | { value: string }
      | undefined;
    return {
      serverId: r ? (JSON.parse(r.value) as string) : null,
      name: this.app.config.get<string>('name', '') || hostname(),
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      node: process.versions.node,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      startedAt,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  // ---------- audit log ----------
  auditPage(q: { before?: number; action?: string; limit?: number }): AuditEntry[] {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = this.app.raw
      .prepare(
        `SELECT id, at, actor_kind, actor_id, action, target, ip, data FROM audit_log
         WHERE (? IS NULL OR at < ?) AND (? IS NULL OR instr(action, ?) = 1)
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(q.before ?? null, q.before ?? null, q.action || null, q.action || null, limit) as {
      id: string;
      at: number;
      actor_kind: string;
      actor_id: string | null;
      action: string;
      target: string | null;
      ip: string | null;
      data: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actorKind: r.actor_kind,
      actorId: r.actor_id,
      action: r.action,
      target: r.target === null ? null : this.app.redact(r.target),
      ip: r.ip,
      data: this.app.redact(r.data),
    }));
  }

  // ---------- metrics + alerts ----------
  async tick(): Promise<Sample> {
    const s = await this.sampler();
    const at = this.now();
    this.app.raw
      .prepare('INSERT INTO admin_metric (at, cpu, mem, disk, load) VALUES (?, ?, ?, ?, ?)')
      .run(at, s.cpu, s.mem, s.disk, s.load);
    this.app.raw.prepare('DELETE FROM admin_metric WHERE at < ?').run(at - KEEP_MS);
    await this.evaluate(at);
    return s;
  }
  metrics(since: number): (Sample & { at: number })[] {
    return this.app.raw
      .prepare('SELECT at, cpu, mem, disk, load FROM admin_metric WHERE at >= ? ORDER BY at DESC LIMIT 1440')
      .all(since) as (Sample & { at: number })[];
  }
  alerts(): AlertDTO[] {
    return (
      this.app.raw.prepare('SELECT * FROM admin_alert ORDER BY created_at').all() as {
        id: string;
        rule: string;
        created_at: number;
        last_fired_at: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      rule: JSON.parse(r.rule) as AlertRule,
      createdAt: r.created_at,
      lastFiredAt: r.last_fired_at,
    }));
  }
  addAlert(rule: AlertRule): AlertDTO {
    const id = ulid();
    this.app.raw
      .prepare('INSERT INTO admin_alert (id, rule, created_at) VALUES (?, ?, ?)')
      .run(id, JSON.stringify(rule), this.now());
    return this.alerts().find((a) => a.id === id)!;
  }
  removeAlert(id: string): boolean {
    return this.app.raw.prepare('DELETE FROM admin_alert WHERE id = ?').run(id).changes === 1;
  }
  private async evaluate(at: number) {
    for (const a of this.alerts()) {
      const r = a.rule;
      if (!(METRICS as readonly string[]).includes(r.metric)) continue; // only a known column is ever named
      if (a.lastFiredAt !== null && at - a.lastFiredAt < r.cooldownMin * 60_000) continue;
      const recent = this.app.raw
        .prepare(`SELECT ${r.metric} AS v FROM admin_metric ORDER BY at DESC LIMIT ?`)
        .all(r.forSamples) as { v: number | null }[];
      if (recent.length < r.forSamples || !recent.every((x) => x.v !== null && x.v > r.above)) continue;
      const value = recent[0]!.v!;
      this.app.raw.prepare('UPDATE admin_alert SET last_fired_at = ? WHERE id = ?').run(at, a.id);
      this.app.bus.publish('owner', 'admin.alert', {
        id: a.id,
        name: r.name,
        metric: r.metric,
        value,
        above: r.above,
      });
      try {
        await this.app.notifier.notify({
          level: r.level,
          title: r.name,
          body: `${r.metric} ${value} > ${r.above}`,
          href: '#/admin',
        });
      } catch (e) {
        this.app.log.warn('alert notification failed', { error: String(e) });
      }
    }
  }

  // ---------- limits ----------
  async limits() {
    const agents = await this.app.agents.list();
    return Promise.all(
      agents.map(async (a) => {
        let usage: { memMb: number; cpuPct: number } | null = null;
        try {
          usage = await this.app.runner.sample(a.id);
        } catch {
          usage = null;
        }
        return {
          agentId: a.id,
          name: a.name,
          memMb: a.limits.memMb ?? null,
          cpuPct: a.limits.cpuPct ?? null,
          usage,
        };
      }),
    );
  }
  async setLimits(ownerId: string, agentId: string, l: { memMb: number | null; cpuPct: number | null }) {
    const a = this.app.agentAdmin.setLimits({ kind: 'user', id: ownerId }, agentId, {
      memMb: l.memMb ?? 0,
      cpuPct: l.cpuPct ?? 0,
    });
    if (!a) throw new HttpError(404, 'agent not found', 'not_found');
    await this.app.runner.apply(agentId, a.limits);
    return a;
  }
  /** At boot: hand every agent's stored limits to the runner. */
  async applyAll() {
    for (const a of await this.app.agents.list())
      if (a.limits.memMb || a.limits.cpuPct)
        await this.app.runner
          .apply(a.id, a.limits)
          .catch((e: unknown) =>
            this.app.log.warn('applying limits failed', { agentId: a.id, error: String(e) }),
          );
  }

  // ---------- diagnostics ----------
  /** Every text in the bundle: redacted, then checked against every known secret value (belt and braces). */
  private scrub(text: string): string {
    let out = this.app.redact(text);
    let known: string[] = [];
    try {
      known = [...this.app.vault.knownValues()].filter((v) => v.length >= 4);
    } catch {
      known = []; // vault unavailable: nothing to know
    }
    for (const v of known) if (out.includes(v)) out = out.split(v).join('[secret]');
    return out;
  }
  private logTails(): { name: string; data: string }[] {
    const dir = join(this.home, 'logs');
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => ({ f, st: statSync(join(dir, f)) }))
      .filter((x) => x.st.isFile())
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 5);
    return files.map(({ f, st }) => {
      const buf = readFileSync(join(dir, f));
      const tail = buf.subarray(Math.max(0, st.size - 256 * 1024)).toString('utf8');
      return { name: `logs/${f.replace(/[^\w.-]/g, '_')}`, data: tail };
    });
  }
  async diagnostics(): Promise<Buffer> {
    const agents = await this.app.agents.list();
    const json = (v: unknown) => JSON.stringify(v, null, 2);
    const files: { name: string; data: string }[] = [
      { name: 'identity.json', data: json(this.identity()) },
      {
        name: 'agents.json',
        // config summary only: no instructions, no workspace paths, no message rows
        data: json(
          agents.map((a) => ({
            id: a.id,
            slug: a.slug,
            name: a.name,
            providerId: a.providerId,
            model: a.model,
            trustLevel: a.trustLevel,
            limits: a.limits,
            status: a.status,
            queue: this.app.queue.list(a.id).reduce<Record<string, number>>((m, q) => {
              m[q.state] = (m[q.state] ?? 0) + 1;
              return m;
            }, {}),
          })),
        ),
      },
      { name: 'metrics.json', data: json(this.metrics(this.now() - 24 * 3600_000)) },
      { name: 'alerts.json', data: json(this.alerts()) },
      {
        name: 'audit.json',
        data: json(this.auditPage({ limit: 200 }).map(({ ip: _ip, ...e }) => e)),
      },
      {
        name: 'env.json',
        // names only: a value is never copied
        data: json(
          Object.keys(process.env)
            .filter((k) => k.startsWith('PASABOT_'))
            .sort(),
        ),
      },
      ...this.logTails(),
    ];
    return zip(files.map((f) => ({ name: f.name, data: this.scrub(f.data) })));
  }
}

export function createAdminModule(o: AdminOptions = {}): PasaBotModule & { admin(): Admin } {
  let ref: Admin | null = null;
  return {
    id: 'admin',
    migrations: join(here, '..', 'migrations'),
    admin() {
      if (!ref) throw new Error('admin module not registered yet');
      return ref;
    },
    async register(app) {
      const a = new Admin(app, o);
      ref = a;
      await a.applyAll();
      const ms = o.sampleMs ?? 60_000;
      if (ms > 0) {
        const t = setInterval(() => {
          if (!app.raw.open) return clearInterval(t);
          a.tick().catch((e: unknown) => app.log.warn('metrics sample failed', { error: String(e) }));
        }, ms);
        t.unref?.();
      }

      app.http.route({
        method: 'GET',
        url: '/identity',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return { identity: a.identity() };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/identity',
        auth: 'session',
        body: z.object({ name: z.string().trim().max(60) }),
        handler: (ctx) => {
          const p = owner(ctx);
          app.config.set('name', ctx.body.name);
          a.audit(p.userId, 'admin.identity.renamed', null, { name: ctx.body.name });
          return { identity: a.identity() };
        },
      });

      app.http.route({
        method: 'GET',
        url: '/audit',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const before = Number(ctx.query.before);
          return {
            entries: a.auditPage({
              before: Number.isFinite(before) && before > 0 ? before : undefined,
              action: typeof ctx.query.action === 'string' ? ctx.query.action.slice(0, 80) : undefined,
              limit: Number(ctx.query.limit) || 50,
            }),
          };
        },
      });

      app.http.route({
        method: 'GET',
        url: '/metrics',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const since = Number(ctx.query.since);
          return { samples: a.metrics(Number.isFinite(since) && since > 0 ? since : Date.now() - 3600_000) };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/metrics/sample',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          return { sample: await a.tick() };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/alerts',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          return { alerts: a.alerts() };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/alerts',
        auth: 'session',
        body: alertRuleSchema,
        handler: (ctx) => {
          const p = owner(ctx);
          if (a.alerts().length >= 50) throw new HttpError(400, 'at most 50 alert rules', 'too_many');
          const out = a.addAlert(ctx.body);
          a.audit(p.userId, 'admin.alert.created', out.id, { rule: ctx.body });
          return httpResponse(201, { alert: out });
        },
      });
      app.http.route({
        method: 'DELETE',
        url: '/alerts/:id',
        auth: 'session',
        handler: (ctx) => {
          const p = owner(ctx);
          if (!a.removeAlert(ctx.params.id!)) throw new HttpError(404, 'alert not found', 'not_found');
          a.audit(p.userId, 'admin.alert.removed', ctx.params.id!);
          return { ok: true };
        },
      });

      app.http.route({
        method: 'GET',
        url: '/limits',
        auth: 'session',
        handler: async (ctx) => {
          owner(ctx);
          return { agents: await a.limits() };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/limits/:agentId',
        auth: 'session',
        body: z.object({
          memMb: z.number().int().min(64).max(1_048_576).nullable(),
          cpuPct: z.number().int().min(1).max(6400).nullable(),
        }),
        handler: async (ctx) => {
          const p = owner(ctx);
          const agent = await a.setLimits(p.userId, ctx.params.agentId!, ctx.body);
          a.audit(p.userId, 'admin.limits.set', agent.id, ctx.body);
          return { limits: agent.limits };
        },
      });

      app.http.route({
        method: 'GET',
        url: '/diagnostics',
        auth: 'session',
        handler: async (ctx) => {
          const p = owner(ctx);
          const body = await a.diagnostics();
          a.audit(p.userId, 'admin.diagnostics.exported', null, { bytes: body.length });
          return httpResponse(200, body, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="pasabot-diagnostics-${new Date().toISOString().slice(0, 10)}.zip"`,
            'cache-control': 'no-store',
          });
        },
      });

      app.http.route({
        method: 'GET',
        url: '/agents/:id/export',
        auth: 'session',
        handler: (ctx) => {
          const p = owner(ctx);
          const b = app.agentAdmin.exportBundle({ kind: 'user', id: p.userId }, ctx.params.id!);
          if (!b) throw new HttpError(404, 'agent not found', 'not_found');
          a.audit(p.userId, 'admin.agent.exported', ctx.params.id!, { chats: b.chats.length });
          const file = (b.agent.slug || 'agent').replace(/[^a-z0-9-]/g, '') || 'agent';
          return httpResponse(200, JSON.stringify(b), {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${file}.pasabot-agent.json"`,
            'cache-control': 'no-store',
          });
        },
      });
      app.http.route({
        method: 'POST',
        url: '/agents/import',
        auth: 'session',
        bodyLimit: 50 * 1024 * 1024,
        body: agentBundleSchema,
        handler: (ctx) => {
          const p = owner(ctx);
          const out = app.agentAdmin.importBundle({ kind: 'user', id: p.userId }, ctx.body);
          a.audit(p.userId, 'admin.agent.imported', out.agentId, { chats: out.chatIds.length });
          return httpResponse(201, out);
        },
      });
    },
  };
}

export default defineModule(createAdminModule());
