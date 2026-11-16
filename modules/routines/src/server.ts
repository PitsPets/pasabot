/**
 * Routines module (W8): manual / schedule / webhook / event / GitHub triggers, own-chat or thread targets, the
 * silent marker, the webhook contract (ARCHITECTURE 5.3), a 30-day iCalendar feed, test runs, secret rotation,
 * the activity feed and agent tools. See README.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type RoutineControl,
  type ToolCtx,
  ulid,
} from '@pasabot/core';
import { verifyWebhook } from '@pasabot/safe-net';
import { z } from 'zod';
import { parseCron, slotsBetween, toIcs } from './cron.js';
import {
  agentTopicAllowed,
  checkTrigger,
  creatingTrust,
  type FireRow,
  fireDTO,
  MAX_WEBHOOK_ROUTINES,
  type RoutineDTO,
  type RoutineRow,
  RoutinesEngine,
  type RoutinesOptions,
  type Trigger,
  triggerSchema,
  WEBHOOK_BODY_LIMIT,
} from './engine.js';

export * from './cron.js';
export * from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 3600_000;

const createBody = z.object({
  agentId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  trigger: triggerSchema,
  target: z.enum(['chat', 'thread', 'workflow']).default('chat'),
  /** required for `target: 'workflow'` */
  workflowId: z.string().min(1).max(80).optional(),
  enabled: z.boolean().default(true),
  /** W34: an unreachable primary brain falls back to the next reachable one (a local model) */
  runEvenOffline: z.boolean().default(false),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(1).max(8000).optional(),
  trigger: triggerSchema.optional(),
  target: z.enum(['chat', 'thread', 'workflow']).optional(),
  workflowId: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  runEvenOffline: z.boolean().optional(),
});

function ownerOnly(ctx: AuthedCtx): { userId: string } {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return { userId: p.userId };
}

export function createRoutinesModule(o: RoutinesOptions = {}): PasaBotModule & { engine(): RoutinesEngine } {
  let engine: RoutinesEngine | null = null;
  return {
    id: 'routines',
    migrations: join(here, '..', 'migrations'),
    engine() {
      if (!engine) throw new Error('routines module not registered yet');
      return engine;
    },
    register(app) {
      const e = new RoutinesEngine(app, o);
      engine = e;
      for (const s of Object.values(e.sources)) if (!app.triggers.get(s.kind)) app.triggers.register(s);
      registerRoutes(app, e, o);
      registerHooks(app, e, o);
      registerTools(app, e);
      app.routines.set(routineControl(app, e));
      // W40: Pause and Undo on a routine's card (the owner's tap; the route already checked it is the owner)
      app.cards.onAction('routines', ({ card, action }) => {
        const id = card.meta?.routineId;
        const r = id ? e.routine(id) : null;
        if (!id || !r) return { state: 'dismissed', settled: { key: 'routines:card.gone' } };
        e.disarm(id);
        if (action.id === 'undo') {
          app.raw.prepare('DELETE FROM routines_routine WHERE id = ?').run(id);
          app.bus.publish('module:routines', 'routines.changed', { id, deleted: true });
          return { state: 'dismissed', settled: { key: 'routines:card.undone' } };
        }
        if (action.id !== 'pause') return undefined;
        app.raw
          .prepare('UPDATE routines_routine SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(e.clock.now(), id);
        app.bus.publish('module:routines', 'routines.changed', { id });
        return { state: 'done', settled: { key: 'routines:card.paused' } };
      });
      e.start();
    },
  };
}

/**
 * What another module may do with routines (W28: a linked machine's `manage` grant): list names and state, fire one
 * now as that machine (never the owner; a paused routine stays paused), stop one (pause + cancel its queued work).
 * Never the prompt, the trigger spec or a webhook URL.
 */
function routineControl(app: ModuleHost, e: RoutinesEngine): RoutineControl {
  const active = (id: string) =>
    (
      app.raw
        .prepare("SELECT count(*) AS n FROM routines_fire WHERE routine_id = ? AND result = 'pending'")
        .get(id) as { n: number }
    ).n;
  return {
    list: () =>
      (app.raw.prepare('SELECT * FROM routines_routine ORDER BY created_at').all() as RoutineRow[]).map(
        (r) => {
          const last = lastFire(app, r.id);
          return {
            id: r.id,
            name: r.name,
            agentId: r.agent_id,
            enabled: !!r.enabled,
            target: r.target,
            trigger: (JSON.parse(r.trigger) as Trigger).kind,
            lastFireAt: last?.at ?? null,
            lastResult: last?.result ?? null,
            active: active(r.id),
          };
        },
      ),
    async start({ routineId, sender }) {
      if (sender.kind !== 'link') throw new Error('only a linked machine starts routines this way');
      if (!e.routine(routineId)) return { status: 'skipped', reason: 'routine not found' };
      const res = await e.fire(
        {
          routineId,
          at: e.clock.now(),
          source: 'link',
          payload: { by: sender.name },
          idemKey: `link:${routineId}:${ulid()}`,
        },
        'link',
        { link: sender },
      );
      return 'reason' in res ? { status: res.status, reason: res.reason } : { status: res.status };
    },
    stop({ routineId, by }) {
      const r = e.routine(routineId);
      if (!r) return { paused: false, cancelled: 0 };
      app.raw
        .prepare('UPDATE routines_routine SET enabled = 0, updated_at = ? WHERE id = ?')
        .run(e.clock.now(), r.id);
      e.disarm(r.id);
      let cancelled = 0;
      const pending = app.raw
        .prepare("SELECT queue_item_id FROM routines_fire WHERE routine_id = ? AND result = 'pending'")
        .all(r.id) as { queue_item_id: string | null }[];
      for (const f of pending) if (f.queue_item_id && app.queue.cancel(f.queue_item_id)) cancelled++;
      app.log.info('routine stopped from another module', { routineId: r.id, by });
      app.bus.publish('module:routines', 'routines.changed', { id: r.id });
      return { paused: true, cancelled };
    },
  };
}

// ---------- helpers ----------
function toDTO(e: RoutinesEngine, r: RoutineRow, last?: FireRow | null): RoutineDTO {
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    prompt: r.prompt,
    enabled: !!r.enabled,
    trigger: JSON.parse(r.trigger) as Trigger,
    target: r.target,
    workflowId: r.workflow_id,
    runEvenOffline: !!r.run_even_offline,
    createdBy: r.created_by,
    createdTrust: r.created_trust,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    nextAt: e.nextAt(r.id),
    lastFire: last ? fireDTO(last) : null,
  };
}
function lastFire(app: ModuleHost, id: string): FireRow | null {
  return (
    (app.raw
      .prepare('SELECT * FROM routines_fire WHERE routine_id = ? ORDER BY at DESC, id DESC LIMIT 1')
      .get(id) as FireRow | undefined) ?? null
  );
}
function mustRoutine(e: RoutinesEngine, id: string): RoutineRow {
  const r = e.routine(id);
  if (!r) throw new HttpError(404, 'routine not found', 'not_found');
  return r;
}
function validTrigger(t: Trigger) {
  try {
    checkTrigger(t);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err), 'bad_trigger');
  }
}
const isHook = (t: Trigger) => t.kind === 'webhook' || t.kind === 'github';

interface NewRoutine {
  agentId: string;
  name: string;
  prompt: string;
  trigger: Trigger;
  target: 'chat' | 'thread' | 'workflow';
  workflowId?: string | undefined;
  enabled: boolean;
  runEvenOffline?: boolean;
  createdBy: string;
  createdTrust: RoutineRow['created_trust'];
}
/** An agent-made event routine may only hear its own agent topic and chats the agent is a member of. */
function checkAgentTopic(app: ModuleHost, createdBy: string, agentId: string, t: Trigger) {
  if (t.kind !== 'event' || !createdBy.startsWith('agent:')) return;
  if (!agentTopicAllowed(app, agentId, t.spec.topic))
    throw new HttpError(
      400,
      `an agent's routine can only listen to agent:${agentId} or a chat the agent is in`,
      'bad_trigger',
    );
}
/**
 * A workflow target names a workflow that exists; an agent-made routine may only start a workflow that same agent
 * made (created_trust stays the lowest hand: the routine's sender is capped again by the workflow's own trust).
 */
function checkWorkflowTarget(
  app: ModuleHost,
  createdBy: string,
  target: NewRoutine['target'],
  workflowId: string | null | undefined,
): string | null {
  if (target !== 'workflow') return null;
  if (!workflowId) throw new HttpError(400, 'choose the workflow this routine starts', 'bad_target');
  const starter = app.flows.get();
  if (!starter) throw new HttpError(400, 'workflows are not available on this server', 'bad_target');
  const wf = starter.list().find((w) => w.id === workflowId);
  if (!wf) throw new HttpError(400, 'workflow not found', 'bad_target');
  if (createdBy.startsWith('agent:') && wf.createdBy !== createdBy)
    throw new HttpError(400, "an agent's routine can only start that agent's own workflows", 'bad_target');
  return wf.id;
}
async function insertRoutine(app: ModuleHost, e: RoutinesEngine, n: NewRoutine) {
  validTrigger(n.trigger);
  const workflowId = checkWorkflowTarget(app, n.createdBy, n.target, n.workflowId);
  checkAgentTopic(app, n.createdBy, n.agentId, n.trigger);
  if (isHook(n.trigger) && e.webhookCount() >= MAX_WEBHOOK_ROUTINES)
    throw new HttpError(409, `at most ${MAX_WEBHOOK_ROUTINES} webhook routines per server`, 'webhook_limit');
  const now = e.clock.now();
  const id = ulid(now);
  app.raw
    .prepare(
      `INSERT INTO routines_routine (id, agent_id, name, prompt, enabled, trigger, target, workflow_id, created_by, created_trust, created_at, updated_at, run_even_offline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      n.agentId,
      n.name,
      n.prompt,
      n.enabled ? 1 : 0,
      JSON.stringify(n.trigger),
      n.target,
      workflowId,
      n.createdBy,
      n.createdTrust,
      now,
      now,
      n.runEvenOffline ? 1 : 0,
    );
  const webhook = isHook(n.trigger) ? await e.createWebhook(id) : null;
  if (n.enabled) e.arm(e.routine(id)!);
  app.bus.publish('module:routines', 'routines.changed', { id });
  return { id, webhook };
}

// ---------- REST (owner session) ----------
function registerRoutes(app: ModuleHost, e: RoutinesEngine, _o: RoutinesOptions) {
  app.http.route({
    method: 'GET',
    url: '/routines',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const rows = app.raw
        .prepare('SELECT * FROM routines_routine ORDER BY created_at')
        .all() as RoutineRow[];
      return {
        routines: rows.map((r) => toDTO(e, r, lastFire(app, r.id))),
        webhookLimit: MAX_WEBHOOK_ROUTINES,
      };
    },
  });
  app.http.route({
    method: 'GET',
    url: '/workflow-targets',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      return {
        workflows: (app.flows.get()?.list() ?? []).map((w) => ({ id: w.id, name: w.name })),
      };
    },
  });
  app.http.route({
    method: 'POST',
    url: '/routines',
    auth: 'session',
    body: createBody,
    handler: async (ctx) => {
      const { userId } = ownerOnly(ctx);
      const agent = await app.agents.get(ctx.body.agentId);
      if (!agent) throw new HttpError(404, 'agent not found', 'not_found');
      const { id, webhook } = await insertRoutine(app, e, {
        ...ctx.body,
        createdBy: `user:${userId}`,
        createdTrust: 'trusted',
      });
      // the secret and the URL are shown once; only the URL token's hash is stored
      return httpResponse(201, { routine: toDTO(e, e.routine(id)!), webhook });
    },
  });
  app.http.route({
    method: 'PATCH',
    url: '/routines/:id',
    auth: 'session',
    body: patchBody,
    handler: async (ctx) => {
      ownerOnly(ctx);
      const r = mustRoutine(e, ctx.params.id!);
      const b = ctx.body;
      const before = JSON.parse(r.trigger) as Trigger;
      let webhook = null;
      if (b.trigger) {
        validTrigger(b.trigger);
        checkAgentTopic(app, r.created_by, r.agent_id, b.trigger);
        if (isHook(b.trigger) && !isHook(before) && e.webhookCount() >= MAX_WEBHOOK_ROUTINES)
          throw new HttpError(
            409,
            `at most ${MAX_WEBHOOK_ROUTINES} webhook routines per server`,
            'webhook_limit',
          );
      }
      const trig = b.trigger ? JSON.stringify(b.trigger) : r.trigger;
      const target = b.target ?? r.target;
      const workflowId = checkWorkflowTarget(
        app,
        r.created_by,
        target,
        b.workflowId ?? (target === 'workflow' ? r.workflow_id : null),
      );
      app.raw
        .prepare(
          `UPDATE routines_routine SET name = ?, prompt = ?, enabled = ?, trigger = ?, target = ?, workflow_id = ?, run_even_offline = ?, updated_at = ?,
             sched_last_at = CASE WHEN ? THEN NULL ELSE sched_last_at END WHERE id = ?`,
        )
        .run(
          b.name ?? r.name,
          b.prompt ?? r.prompt,
          b.enabled === undefined ? r.enabled : b.enabled ? 1 : 0,
          trig,
          target,
          workflowId,
          b.runEvenOffline === undefined ? r.run_even_offline : b.runEvenOffline ? 1 : 0,
          e.clock.now(),
          trig !== r.trigger ? 1 : 0,
          r.id,
        );
      if (b.trigger && isHook(b.trigger) && !isHook(before)) webhook = await e.createWebhook(r.id);
      if (b.trigger && !isHook(b.trigger) && isHook(before))
        app.raw.prepare('DELETE FROM routines_webhook WHERE routine_id = ?').run(r.id);
      e.arm(e.routine(r.id)!);
      app.bus.publish('module:routines', 'routines.changed', { id: r.id });
      return { routine: toDTO(e, e.routine(r.id)!, lastFire(app, r.id)), webhook };
    },
  });
  app.http.route({
    method: 'DELETE',
    url: '/routines/:id',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const r = mustRoutine(e, ctx.params.id!);
      e.disarm(r.id);
      app.raw.prepare('DELETE FROM routines_routine WHERE id = ?').run(r.id);
      app.bus.publish('module:routines', 'routines.changed', { id: r.id, deleted: true });
      return httpResponse(204);
    },
  });
  for (const kind of ['run', 'test'] as const) {
    app.http.route({
      method: 'POST',
      url: `/routines/:id/${kind}`,
      auth: 'session',
      handler: async (ctx) => {
        const owner = ownerOnly(ctx);
        const r = mustRoutine(e, ctx.params.id!);
        const t = JSON.parse(r.trigger) as Trigger;
        const sample =
          kind === 'test' ? await e.sources[t.kind].test?.(t.spec) : { payload: { by: 'owner' }, at: 0 };
        const res = await e.fire(
          {
            routineId: r.id,
            at: e.clock.now(),
            source: kind === 'test' ? 'test' : 'manual',
            payload: sample?.payload ?? {},
            idemKey: `${kind}:${r.id}:${ulid()}`,
          },
          kind === 'test' ? 'test' : 'manual',
          { owner },
        );
        if (res.status === 'full') throw new HttpError(503, 'agent queue is full', 'queue_full');
        if (res.status === 'skipped') throw new HttpError(409, res.reason, 'skipped');
        return httpResponse(202, res);
      },
    });
  }
  app.http.route({
    method: 'POST',
    url: '/routines/:id/rotate-secret',
    auth: 'session',
    handler: async (ctx) => {
      ownerOnly(ctx);
      const r = mustRoutine(e, ctx.params.id!);
      if (!isHook(JSON.parse(r.trigger) as Trigger))
        throw new HttpError(400, 'only webhook routines have a secret', 'no_webhook');
      return { webhook: await e.createWebhook(r.id) };
    },
  });
  app.http.route({
    method: 'GET',
    url: '/activity',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const limit = Math.min(200, Math.max(1, Number(ctx.query.limit ?? 50) || 50));
      const rid = typeof ctx.query.routineId === 'string' ? ctx.query.routineId : null;
      const rows = app.raw
        .prepare(
          `SELECT f.*, coalesce(r.name, '') AS routine_name FROM routines_fire f LEFT JOIN routines_routine r ON r.id = f.routine_id
           WHERE (? IS NULL OR f.routine_id = ?) ORDER BY f.at DESC, f.id DESC LIMIT ?`,
        )
        .all(rid, rid, limit) as (FireRow & { routine_name: string })[];
      return { fires: rows.map(fireDTO) };
    },
  });
  app.http.route({
    method: 'GET',
    url: '/calendar.ics',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const now = e.clock.now();
      const rows = app.raw
        .prepare('SELECT * FROM routines_routine WHERE enabled = 1 ORDER BY created_at')
        .all() as RoutineRow[];
      const events = [];
      for (const r of rows) {
        const t = JSON.parse(r.trigger) as Trigger;
        if (t.kind !== 'schedule') continue;
        for (const at of slotsBetween(parseCron(t.spec.cron), t.spec.tz, now, now + 30 * DAY, 500))
          events.push({
            uid: `${r.id}-${at}@pasabot`,
            at,
            summary: r.name,
            description: r.prompt.slice(0, 200),
          });
      }
      events.sort((a, b) => a.at - b.at);
      return httpResponse(200, toIcs(events, now), { 'content-type': 'text/calendar; charset=utf-8' });
    },
  });
}

// ---------- public hooks: the webhook contract (ARCHITECTURE 5.3) + GitHub ----------
const DELIVERY_RE = /^[\w.:-]{1,128}$/;
const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

function registerHooks(app: ModuleHost, e: RoutinesEngine, o: RoutinesOptions) {
  const rateLimit = o.hookRateLimit ?? { max: 60, windowMs: 60_000 };
  app.publicHttp.route({
    method: 'POST',
    url: '/:token',
    rateLimit,
    bodyLimit: WEBHOOK_BODY_LIMIT,
    handler: async (ctx) => {
      const hit = e.webhookFor(String(ctx.params.token ?? ''));
      const t = hit ? (JSON.parse(hit.routine.trigger) as Trigger) : null;
      if (!hit || t?.kind !== 'webhook') return httpResponse(401, { error: 'unauthorized' });
      const h = {
        ts: header(ctx.headers, 'x-pasabot-timestamp'),
        deliveryId: header(ctx.headers, 'x-pasabot-delivery'),
        signature: header(ctx.headers, 'x-pasabot-signature'),
      };
      if (!h.deliveryId || !DELIVERY_RE.test(h.deliveryId))
        return httpResponse(401, { error: 'unauthorized' });
      const secret = await e.secretFor(hit.routine.id, hit.secretRef);
      if (!verifyWebhook(secret, h, ctx.rawBody, e.clock.now()))
        return httpResponse(401, { error: 'unauthorized' });
      return accept(
        e,
        hit.routine,
        'webhook',
        `webhook:${hit.routine.id}:${h.deliveryId}`,
        parseBody(ctx.rawBody),
      );
    },
  });
  app.publicHttp.route({
    method: 'POST',
    url: '/gh/:token',
    rateLimit,
    bodyLimit: WEBHOOK_BODY_LIMIT,
    handler: async (ctx) => {
      const hit = e.webhookFor(String(ctx.params.token ?? ''));
      const t = hit ? (JSON.parse(hit.routine.trigger) as Trigger) : null;
      if (!hit || t?.kind !== 'github') return httpResponse(401, { error: 'unauthorized' });
      const delivery = header(ctx.headers, 'x-github-delivery');
      const event = header(ctx.headers, 'x-github-event');
      const sig = header(ctx.headers, 'x-hub-signature-256') ?? '';
      if (!delivery || !DELIVERY_RE.test(delivery) || !event)
        return httpResponse(401, { error: 'unauthorized' });
      const secret = await e.secretFor(hit.routine.id, hit.secretRef);
      const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(ctx.rawBody).digest('hex')}`);
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got))
        return httpResponse(401, { error: 'unauthorized' });
      const body = parseBody(ctx.rawBody) as { action?: unknown } | null;
      const action = typeof body?.action === 'string' ? body.action : null;
      const wanted = t.spec.events;
      const match =
        wanted.includes('*') || wanted.includes(event) || (action && wanted.includes(`${event}.${action}`));
      if (event === 'ping' || !match) return httpResponse(202, { accepted: false, ignored: event });
      return accept(e, hit.routine, 'github', `github:${hit.routine.id}:${delivery}`, {
        event,
        ...(action ? { action } : {}),
        body,
      });
    },
  });
}

function parseBody(raw: Buffer): unknown {
  const s = raw.toString('utf8');
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function accept(
  e: RoutinesEngine,
  r: RoutineRow,
  kind: 'webhook' | 'github',
  idemKey: string,
  payload: unknown,
) {
  if (!r.enabled || !e.isArmed(r.id)) return httpResponse(503, { error: 'paused' }, { 'retry-after': '300' });
  const res = await e.fire({ routineId: r.id, at: e.clock.now(), source: kind, payload, idemKey }, kind);
  if (res.status === 'duplicate') return httpResponse(202, { accepted: true, duplicate: true });
  if (res.status === 'queued' || res.status === 'started') return httpResponse(202, { accepted: true });
  if (res.status === 'full') return httpResponse(503, { error: 'queue_full' }, { 'retry-after': '60' });
  return httpResponse(503, { error: 'paused' }, { 'retry-after': '300' });
}

// ---------- agent tools (narrowing is cheap, creating is tier 2, deleting is tier 3) ----------
const agentTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), spec: z.object({}).strict().default({}) }),
  z.object({
    kind: z.literal('schedule'),
    spec: z.object({
      cron: z.string().min(9).max(120),
      tz: z.string().default('UTC'),
      catchUp: z.boolean().default(false),
    }),
  }),
  z.object({
    kind: z.literal('event'),
    spec: z.object({
      topic: z.string().min(1).max(120),
      type: z.string().min(1).max(80),
      filter: z.unknown().optional(),
    }),
  }),
]);

function registerTools(app: ModuleHost, e: RoutinesEngine) {
  const own = (id: string, ctx: ToolCtx) => {
    const r = e.routine(id);
    if (!r || r.agent_id !== ctx.agent.id) throw new Error('routine not found');
    return r;
  };
  app.tools.add({
    name: 'routines_list',
    title: 'List my routines',
    description: 'Lists the routines that run this agent, with their trigger and the next scheduled time.',
    input: z.object({}),
    tier: 0,
    handler: async (_i, ctx) => ({
      routines: (
        app.raw
          .prepare('SELECT * FROM routines_routine WHERE agent_id = ? ORDER BY created_at')
          .all(ctx.agent.id) as RoutineRow[]
      ).map((r) => {
        const d = toDTO(e, r);
        return {
          id: d.id,
          name: d.name,
          enabled: d.enabled,
          trigger: d.trigger,
          target: d.target,
          nextAt: d.nextAt,
        };
      }),
    }),
  });
  app.tools.add({
    name: 'routines_create',
    title: 'Create a routine',
    description:
      'Creates a routine that runs this agent on a schedule (5-field cron + IANA time zone), on an event, or by hand. ' +
      'It always runs with the trust of the turn that created it, never more. An event routine can only listen to ' +
      '`agent:<this agent id>` or `chat:<id>` of a chat this agent is in. Webhook routines are created by the owner only.',
    input: z.object({
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().min(1).max(8000),
      trigger: agentTrigger,
      target: z.enum(['chat', 'thread', 'workflow']).default('chat'),
      /** for `target: 'workflow'`: one of this agent's own workflows */
      workflowId: z.string().min(1).max(80).optional(),
    }),
    tier: 2,
    handler: async (i, ctx) => {
      const { id } = await insertRoutine(app, e, {
        agentId: ctx.agent.id,
        name: i.name,
        prompt: i.prompt,
        trigger: i.trigger as Trigger,
        target: i.target,
        workflowId: i.workflowId,
        enabled: true,
        createdBy: `agent:${ctx.agent.id}`,
        createdTrust: creatingTrust(ctx.agent.trustLevel, ctx.sender),
      });
      // W40: the owner sees what was just set up, with Pause it and Delete it
      const chatId = app.chats.runChat(ctx.run.id);
      if (chatId)
        try {
          app.cards.post({
            chatId,
            authorAgentId: ctx.agent.id,
            card: {
              variant: 'result',
              title: { key: 'routines:card.created.title', params: { name: i.name } },
              text: { key: 'routines:card.created.text' },
              actions: [
                // named by what they do: Pause it (the one primary) keeps it, Delete it removes it
                { id: 'pause', label: { key: 'routines:card.pause' }, style: 'primary', server: true },
                { id: 'undo', label: { key: 'routines:card.undo' }, style: 'secondary', server: true },
                { id: 'open', label: { key: 'routines:card.open' }, style: 'ghost', href: '#/routines' },
              ],
              source: 'routines',
              agentId: ctx.agent.id,
              meta: { routineId: id },
            },
          });
        } catch (err) {
          app.log.warn('routine card not posted', { error: (err as Error).message });
        }
      return { id, createdTrust: e.routine(id)!.created_trust };
    },
  });
  app.tools.add({
    name: 'routines_pause',
    title: 'Pause one of my routines',
    description: 'Stops a routine of this agent from firing until the owner turns it back on.',
    input: z.object({ id: z.string() }),
    tier: 1,
    handler: async (i, ctx) => {
      const r = own(i.id, ctx);
      app.raw
        .prepare('UPDATE routines_routine SET enabled = 0, updated_at = ? WHERE id = ?')
        .run(e.clock.now(), r.id);
      e.disarm(r.id);
      app.bus.publish('module:routines', 'routines.changed', { id: r.id });
      return { ok: true };
    },
  });
  app.tools.add({
    name: 'routines_delete',
    title: 'Delete one of my routines',
    description: 'Deletes a routine of this agent. Always asks the owner first.',
    input: z.object({ id: z.string() }),
    tier: 3,
    // W38: the fixed delete class, so the card shows what is deleted (a routine lives outside the workspace)
    actionClass: 'delete',
    actionDetails: (i, ctx, cls) => {
      const r = own(i.id, ctx);
      return {
        class: cls,
        fields: [
          { key: 'target', value: `routine "${r.name}" (${r.id})` },
          { key: 'where', value: "this agent's routines (its scheduled and webhook work)" },
          { key: 'count', value: '1' },
        ],
      };
    },
    handler: async (i, ctx) => {
      const r = own(i.id, ctx);
      e.disarm(r.id);
      app.raw.prepare('DELETE FROM routines_routine WHERE id = ?').run(r.id);
      app.bus.publish('module:routines', 'routines.changed', { id: r.id, deleted: true });
      return { ok: true };
    },
  });
}

export default defineModule(createRoutinesModule());
