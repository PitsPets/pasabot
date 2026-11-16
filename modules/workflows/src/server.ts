/**
 * Workflows module (W9): graph definitions, runs on the `workflow` queue kind, owner approvals of approval
 * steps, graph templates (routine flows), owner REST for the canvas and agent tools (create/edit tier 2, delete
 * tier 3). See README.md.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type SenderInfo,
  type ToolCtx,
  ulid,
} from '@pasabot/core';
import { minTrust, type TrustLevel } from '@pasabot/protocol';
import { z } from 'zod';
import {
  type DefRow,
  type RunRow,
  runSummary,
  stepDTO,
  WorkflowsEngine,
  type WorkflowsOptions,
} from './engine.js';
import { fanOutGraph, type Graph, graphSchema, parseGraph, templateBody } from './graph.js';

export * from './engine.js';
export * from './graph.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MAX_WORKFLOWS = 200;

const nameSchema = z.string().trim().min(1).max(80);
const createBody = z.object({ name: nameSchema, graph: graphSchema });
const patchBody = z.object({ name: nameSchema.optional(), graph: graphSchema.optional() });
const runBody = z.object({ input: z.string().max(16_000).optional() }).default({});

function ownerOnly(ctx: AuthedCtx): { userId: string } {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
  return { userId: p.userId };
}

const lower = (t: TrustLevel): TrustLevel => (t === 'trusted' ? 'standard' : 'guarded');
/** The trust a turn has when it creates or starts something: min(agent, sender), one lower for non-owners (7.4). */
export function creatingTrust(agentTrust: TrustLevel, sender: SenderInfo): TrustLevel {
  const base = minTrust(agentTrust, sender.trust);
  return sender.kind === 'owner' ? base : lower(base);
}

export interface DefDTO {
  id: string;
  name: string;
  graph: Graph;
  version: number;
  createdBy: string;
  createdTrust: TrustLevel;
  createdAt: number;
  updatedAt: number;
}
export const defDTO = (d: DefRow): DefDTO => ({
  id: d.id,
  name: d.name,
  graph: JSON.parse(d.graph) as Graph,
  version: d.version,
  createdBy: d.created_by,
  createdTrust: d.created_trust,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

export function createWorkflowsModule(
  o: WorkflowsOptions = {},
): PasaBotModule & { engine(): WorkflowsEngine } {
  let engine: WorkflowsEngine | null = null;
  return {
    id: 'workflows',
    migrations: join(here, '..', 'migrations'),
    engine() {
      if (!engine) throw new Error('workflows module not registered yet');
      return engine;
    },
    register(app) {
      const e = new WorkflowsEngine(app, o);
      engine = e;
      registerRoutes(app, e);
      registerTools(app, e);
      app.flows.set(workflowStarter(app, e));
      e.start();
    },
  };
}

// ---------- shared ----------
function checkGraph(g: unknown): Graph {
  try {
    return parseGraph(g);
  } catch (err) {
    const msg =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : err instanceof Error
          ? err.message
          : String(err);
    throw new HttpError(400, msg, 'bad_graph');
  }
}
async function checkAgents(app: ModuleHost, g: Graph, onlyAgent?: string) {
  for (const n of g.nodes) {
    if (n.type !== 'agent' && n.type !== 'model') continue;
    const a = await app.agents.get(n.data.agentId);
    if (!a || a.archivedAt) throw new HttpError(400, `node "${n.id}": agent not found`, 'bad_graph');
    // an agent may only build workflows that run itself; reaching other agents is the collab module's job
    if (onlyAgent && a.id !== onlyAgent)
      throw new HttpError(
        400,
        `node "${n.id}": a workflow made by an agent can only run that agent`,
        'bad_graph',
      );
  }
}
function insertDef(
  app: ModuleHost,
  e: WorkflowsEngine,
  name: string,
  g: Graph,
  by: string,
  trust: TrustLevel,
) {
  const n = (app.raw.prepare('SELECT count(*) AS n FROM workflows_def').get() as { n: number }).n;
  if (n >= MAX_WORKFLOWS) throw new HttpError(409, `at most ${MAX_WORKFLOWS} workflows`, 'limit');
  const id = ulid();
  const now = e.clock.now();
  app.raw
    .prepare(
      `INSERT INTO workflows_def (id, name, graph, version, created_by, created_trust, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(id, name, JSON.stringify(g), by, trust, now, now);
  app.bus.publish('module:workflows', 'workflows.changed', { id });
  return e.def(id)!;
}
function updateDef(
  app: ModuleHost,
  e: WorkflowsEngine,
  d: DefRow,
  p: { name?: string; graph?: Graph },
  trust: TrustLevel,
) {
  app.raw
    .prepare(
      'UPDATE workflows_def SET name = ?, graph = ?, version = version + 1, created_trust = ?, updated_at = ? WHERE id = ?',
    )
    // an edit never raises created_trust: it is the lowest of every hand that shaped the workflow
    .run(
      p.name ?? d.name,
      p.graph ? JSON.stringify(p.graph) : d.graph,
      minTrust(d.created_trust, trust),
      e.clock.now(),
      d.id,
    );
  app.bus.publish('module:workflows', 'workflows.changed', { id: d.id });
  return e.def(d.id)!;
}
function deleteDef(app: ModuleHost, d: DefRow) {
  app.raw.prepare('DELETE FROM workflows_def WHERE id = ?').run(d.id);
  app.bus.publish('module:workflows', 'workflows.changed', { id: d.id, deleted: true });
}
/**
 * The trust of an agent-made workflow's maker as it is now (`trusted` = no cap for an owner-made one): a run acts as
 * that agent, so a maker demoted (or removed) since it made the workflow lowers every later run. created_trust never
 * escalates: a run gets the lowest trust anywhere in the chain.
 */
async function makerTrust(app: ModuleHost, d: DefRow): Promise<TrustLevel> {
  if (!d.created_by.startsWith('agent:')) return 'trusted';
  const a = await app.agents.get(d.created_by.slice('agent:'.length));
  return a && !a.archivedAt ? a.trustLevel : 'guarded';
}
/** who an owner-started run acts as: an agent-made workflow never runs as the owner */
function ownerRunSender(d: DefRow, userId: string, maker: TrustLevel): SenderInfo {
  const trust = minTrust(d.created_trust, maker);
  if (d.created_by.startsWith('agent:'))
    return {
      kind: 'agent',
      id: d.created_by.slice('agent:'.length),
      name: `workflow ${d.name}`,
      trust,
    };
  return { kind: 'owner', id: userId, name: 'owner', trust };
}
/**
 * What a routine (W8) starts: the run acts as the routine's sender capped at the workflow's own `created_trust`, and
 * an agent-made workflow never acts as the owner (the same rules as an owner's own start, `ownerRunSender`).
 */
function workflowStarter(app: ModuleHost, e: WorkflowsEngine) {
  return {
    list: () =>
      (app.raw.prepare('SELECT * FROM workflows_def ORDER BY name').all() as DefRow[]).map((d) => ({
        id: d.id,
        name: d.name,
        createdBy: d.created_by,
        createdTrust: d.created_trust,
      })),
    async start(o: { workflowId: string; sender: SenderInfo; startedBy: string; input?: string }) {
      const found = e.def(o.workflowId);
      if (!found) throw new Error('workflow not found');
      const maker = await makerTrust(app, found);
      const d = e.def(o.workflowId); // read again after the wait: it may have changed or gone
      if (!d) throw new Error('workflow not found');
      const trust = minTrust(d.created_trust, o.sender.trust, maker);
      const sender: SenderInfo =
        o.sender.kind === 'owner' && d.created_by.startsWith('agent:')
          ? { kind: 'agent', id: d.created_by.slice('agent:'.length), name: `workflow ${d.name}`, trust }
          : { ...o.sender, trust };
      const run = e.startRun(d, {
        sender,
        startedBy: o.startedBy,
        ...(o.input ? { input: o.input.slice(0, 16_000) } : {}),
      });
      return { runId: run.id };
    },
    runState(runId: string) {
      const r = e.run(runId);
      return r ? { state: r.state, error: r.error, startedBy: r.started_by } : null;
    },
  };
}

const runsQuery = `SELECT r.*, coalesce(d.name, '') AS def_name,
  (SELECT count(*) FROM workflows_step s WHERE s.run_id = r.id AND s.state = 'waiting' AND s.queue_item_id IS NULL AND s.resume_at IS NULL) AS waiting
  FROM workflows_run r LEFT JOIN workflows_def d ON d.id = r.def_id`;

// ---------- REST (owner session) ----------
function registerRoutes(app: ModuleHost, e: WorkflowsEngine) {
  const mustDef = (id: string) => {
    const d = e.def(id);
    if (!d) throw new HttpError(404, 'workflow not found', 'not_found');
    return d;
  };
  app.http.route({
    method: 'GET',
    url: '/workflows',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const rows = app.raw.prepare('SELECT * FROM workflows_def ORDER BY created_at').all() as DefRow[];
      return { workflows: rows.map(defDTO) };
    },
  });
  app.http.route({
    method: 'POST',
    url: '/workflows',
    auth: 'session',
    body: createBody,
    handler: async (ctx) => {
      const { userId } = ownerOnly(ctx);
      const g = checkGraph(ctx.body.graph);
      await checkAgents(app, g);
      const d = insertDef(app, e, ctx.body.name, g, `user:${userId}`, 'trusted');
      return httpResponse(201, { workflow: defDTO(d) });
    },
  });
  app.http.route({
    method: 'POST',
    url: '/workflows/from-template',
    auth: 'session',
    body: templateBody.extend({ name: nameSchema }),
    handler: async (ctx) => {
      const { userId } = ownerOnly(ctx);
      const g = checkGraph(fanOutGraph(ctx.body));
      await checkAgents(app, g);
      const d = insertDef(app, e, ctx.body.name, g, `user:${userId}`, 'trusted');
      return httpResponse(201, { workflow: defDTO(d) });
    },
  });
  app.http.route({
    method: 'GET',
    url: '/workflows/:id',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      return { workflow: defDTO(mustDef(ctx.params.id!)) };
    },
  });
  app.http.route({
    method: 'PATCH',
    url: '/workflows/:id',
    auth: 'session',
    body: patchBody,
    handler: async (ctx) => {
      ownerOnly(ctx);
      const d = mustDef(ctx.params.id!);
      const g = ctx.body.graph ? checkGraph(ctx.body.graph) : undefined;
      if (g) await checkAgents(app, g);
      // the owner's edit keeps whatever trust the workflow had (it can only narrow)
      return {
        workflow: defDTO(updateDef(app, e, d, { ...ctx.body, ...(g ? { graph: g } : {}) }, 'trusted')),
      };
    },
  });
  app.http.route({
    method: 'DELETE',
    url: '/workflows/:id',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      deleteDef(app, mustDef(ctx.params.id!));
      return httpResponse(204);
    },
  });
  app.http.route({
    method: 'POST',
    url: '/workflows/:id/run',
    auth: 'session',
    body: runBody,
    handler: async (ctx) => {
      const { userId } = ownerOnly(ctx);
      const maker = await makerTrust(app, mustDef(ctx.params.id!));
      const d = mustDef(ctx.params.id!);
      const run = e.startRun(d, {
        sender: ownerRunSender(d, userId, maker),
        startedBy: `user:${userId}`,
        ...(ctx.body?.input ? { input: ctx.body.input } : {}),
      });
      return httpResponse(202, { run: runSummary(run) });
    },
  });
  app.http.route({
    method: 'GET',
    url: '/runs',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const def = typeof ctx.query.workflowId === 'string' ? ctx.query.workflowId : null;
      const limit = Math.min(200, Math.max(1, Number(ctx.query.limit ?? 50) || 50));
      const rows = app.raw
        .prepare(
          `${runsQuery} WHERE (? IS NULL OR r.def_id = ?) ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
        )
        .all(def, def, limit) as (RunRow & { def_name: string; waiting: number })[];
      return { runs: rows.map(runSummary) };
    },
  });
  app.http.route({
    method: 'GET',
    url: '/runs/:id',
    auth: 'session',
    handler: (ctx) => {
      ownerOnly(ctx);
      const r = app.raw.prepare(`${runsQuery} WHERE r.id = ?`).get(ctx.params.id!) as
        | (RunRow & { def_name: string; waiting: number })
        | undefined;
      if (!r) throw new HttpError(404, 'run not found', 'not_found');
      return { run: runSummary(r), graph: JSON.parse(r.graph) as Graph, steps: e.steps(r.id).map(stepDTO) };
    },
  });
  for (const decision of ['approve', 'reject'] as const) {
    app.http.route({
      method: 'POST',
      url: `/runs/:id/steps/:stepId/${decision}`,
      auth: 'session',
      handler: async (ctx) => {
        const { userId } = ownerOnly(ctx);
        const ok = await e.decide(ctx.params.id!, ctx.params.stepId!, decision, userId);
        if (!ok) throw new HttpError(409, 'this step is not waiting for a decision', 'not_waiting');
        return { run: runSummary(e.run(ctx.params.id!)!) };
      },
    });
  }
  app.http.route({
    method: 'POST',
    url: '/runs/:id/cancel',
    auth: 'session',
    handler: async (ctx) => {
      ownerOnly(ctx);
      if (!(await e.cancel(ctx.params.id!))) throw new HttpError(409, 'the run is not going', 'not_running');
      return { run: runSummary(e.run(ctx.params.id!)!) };
    },
  });
}

// ---------- agent tools (list 0, create/edit/run 2, delete 3; an agent touches only workflows it made) ----------
function registerTools(app: ModuleHost, e: WorkflowsEngine) {
  const own = (id: string, ctx: ToolCtx) => {
    const d = e.def(id);
    if (!d || d.created_by !== `agent:${ctx.agent.id}`) throw new Error('workflow not found');
    return d;
  };
  const graphHelp =
    'A graph is { nodes, edges, maxIterations }. Node types: agent { agentId, prompt }, model { agentId, prompt } ' +
    '(no tools), condition { op: contains|not_contains|equals|matches|empty|not_empty, value } (edges out carry ' +
    'branch "true"/"false"), approval { message }, transform { template with {{input}} or {{node.<id>}} }, wait ' +
    '{ seconds }, parallel {}, output { to: notification|channel, title, template }. An agent can only use itself ' +
    'in agent/model nodes.';
  app.tools.add({
    name: 'workflows_list',
    title: 'List my workflows',
    description: 'Lists the workflows this agent made, with their graphs.',
    input: z.object({}),
    tier: 0,
    handler: async (_i, ctx) => ({
      workflows: (
        app.raw
          .prepare('SELECT * FROM workflows_def WHERE created_by = ? ORDER BY created_at')
          .all(`agent:${ctx.agent.id}`) as DefRow[]
      ).map(defDTO),
    }),
  });
  app.tools.add({
    name: 'workflows_create',
    title: 'Create a workflow',
    description: `Creates a workflow. It always runs with the trust of the turn that made it, never more. ${graphHelp}`,
    input: z.object({ name: nameSchema, graph: z.unknown() }),
    tier: 2,
    handler: async (i, ctx) => {
      const g = checkGraph(i.graph);
      await checkAgents(app, g, ctx.agent.id);
      const d = insertDef(
        app,
        e,
        i.name,
        g,
        `agent:${ctx.agent.id}`,
        creatingTrust(ctx.agent.trustLevel, ctx.sender),
      );
      return { id: d.id, createdTrust: d.created_trust };
    },
  });
  app.tools.add({
    name: 'workflows_update',
    title: 'Edit one of my workflows',
    description: `Renames a workflow this agent made or replaces its graph. ${graphHelp}`,
    input: z.object({ id: z.string(), name: nameSchema.optional(), graph: z.unknown().optional() }),
    tier: 2,
    handler: async (i, ctx) => {
      const d = own(i.id, ctx);
      const g = i.graph !== undefined ? checkGraph(i.graph) : undefined;
      if (g) await checkAgents(app, g, ctx.agent.id);
      const next = updateDef(
        app,
        e,
        d,
        { ...(i.name ? { name: i.name } : {}), ...(g ? { graph: g } : {}) },
        creatingTrust(ctx.agent.trustLevel, ctx.sender),
      );
      return { id: next.id, version: next.version, createdTrust: next.created_trust };
    },
  });
  app.tools.add({
    name: 'workflows_run',
    title: 'Run one of my workflows',
    description: 'Starts a run of a workflow this agent made; returns the run id.',
    input: z.object({ id: z.string(), input: z.string().max(16_000).optional() }),
    tier: 2,
    handler: async (i, ctx) => {
      const d = own(i.id, ctx);
      const run = e.startRun(d, {
        sender: {
          kind: 'agent',
          id: ctx.agent.id,
          name: `workflow ${d.name}`,
          trust: minTrust(d.created_trust, creatingTrust(ctx.agent.trustLevel, ctx.sender)),
        },
        startedBy: `agent:${ctx.agent.id}`,
        ...(i.input ? { input: i.input } : {}),
      });
      return { runId: run.id };
    },
  });
  app.tools.add({
    name: 'workflows_delete',
    title: 'Delete one of my workflows',
    description: 'Deletes a workflow this agent made. Always asks the owner first.',
    input: z.object({ id: z.string() }),
    tier: 3,
    // W38: the fixed delete class, so the card shows what is deleted (a workflow lives outside the workspace)
    actionClass: 'delete',
    actionDetails: (i, ctx, cls) => {
      const d = own(i.id, ctx);
      return {
        class: cls,
        fields: [
          { key: 'target', value: `workflow "${d.name}" (${d.id})` },
          { key: 'where', value: 'workflows this agent made' },
          { key: 'count', value: '1' },
        ],
      };
    },
    handler: async (i, ctx) => {
      deleteDef(app, own(i.id, ctx));
      return { ok: true };
    },
  });
}

export default defineModule(createWorkflowsModule());
