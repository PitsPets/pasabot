/**
 * W8 + W9 together: a routine whose target is a workflow starts a run of it, the fire's result follows the run's
 * end, and the run acts with the routine's trust capped by the workflow's own `created_trust` (an outside fire is
 * never the owner). Real Fastify on 127.0.0.1:0, temp $PASABOT_HOME, both modules from source.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutinesModule } from '../../../../modules/routines/src/server.js';
import { createWorkflowsModule } from '../../../../modules/workflows/src/server.js';
import {
  bootTestServer,
  FakeProvider,
  seedAgent,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

const fake = new FakeProvider({
  script: () => [{ event: { type: 'text.final', text: 'ok' } }, { event: { type: 'done', stop: 'end' } }],
});
let open: TestServer[] = [];
afterEach(async () => {
  for (const s of open) await s.cleanup();
  open = [];
});

async function setup() {
  const s = await bootTestServer({
    modules: [createRoutinesModule({ tickMs: 0 }), createWorkflowsModule({ tickMs: 0 })],
    providers: [fake],
    dispatcher: { pollMs: 5 },
  });
  open.push(s);
  const owner = seedUser(s.db);
  const agent = seedAgent(s.db, { trust: 'trusted' });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${owner.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  return { s, owner, agent, call };
}
const node = (id: string, type: string, data: unknown) => ({ id, type, data, position: { x: 0, y: 0 } });
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('routine → workflow', () => {
  it('a routine that targets a workflow starts a run; the fire is ok when the run is done', async () => {
    const { s, call, agent } = await setup();
    const wf = await call('POST', '/api/m/workflows/workflows', {
      name: 'Digest',
      graph: {
        nodes: [
          node('t', 'transform', { template: 'got: {{input}}' }),
          node('o', 'output', { to: 'notification', title: 'Digest', template: '{{input}}' }),
        ],
        edges: [{ id: 'e1', source: 't', target: 'o' }],
      },
    });
    expect(wf.body).toMatchObject({ workflow: { name: 'Digest' } });
    const targets = await call('GET', '/api/m/routines/workflow-targets');
    expect(targets.body.workflows).toEqual([{ id: wf.body.workflow.id, name: 'Digest' }]);

    // a workflow target needs a workflow that exists
    const bad = await call('POST', '/api/m/routines/routines', {
      agentId: agent,
      name: 'Morning',
      prompt: 'Make the digest',
      trigger: { kind: 'manual', spec: {} },
      target: 'workflow',
      workflowId: 'nope',
    });
    expect(bad.status).toBe(400);

    const rt = await call('POST', '/api/m/routines/routines', {
      agentId: agent,
      name: 'Morning',
      prompt: 'Make the digest',
      trigger: { kind: 'manual', spec: {} },
      target: 'workflow',
      workflowId: wf.body.workflow.id,
    });
    expect(rt.body).toMatchObject({ routine: { target: 'workflow' } });
    expect(rt.body.routine).toMatchObject({ target: 'workflow', workflowId: wf.body.workflow.id });

    const fired = await call('POST', `/api/m/routines/routines/${rt.body.routine.id}/run`);
    expect(fired.status).toBe(202);
    expect(fired.body.status).toBe('started');
    const runId = fired.body.workflowRunId as string;
    const run = await until(
      () => call('GET', `/api/m/workflows/runs/${runId}`),
      (r) => r.body.run.state !== 'running',
    );
    expect(run.body.run.state).toBe('done');
    expect(run.body.run.startedBy).toBe(`routine:${rt.body.routine.id}`);
    const out = run.body.steps.find((x: { nodeId: string }) => x.nodeId === 'o');
    expect(out.output.text).toMatch(/^got: Make the digest/);
    // the owner's hand: the run acts as the owner, at the workflow's trust
    const sender = JSON.parse(
      (s.db.prepare('SELECT sender FROM workflows_run WHERE id = ?').get(runId) as { sender: string }).sender,
    );
    expect(sender).toMatchObject({ kind: 'owner', trust: 'trusted' });

    const fire = await until(
      () =>
        s.db
          .prepare('SELECT result, workflow_run_id FROM routines_fire WHERE routine_id = ?')
          .get(rt.body.routine.id) as { result: string; workflow_run_id: string },
      (f) => f.result !== 'pending',
    );
    expect(fire).toEqual({ result: 'ok', workflow_run_id: runId });
  });

  it('created_trust: an agent-made workflow never runs as the owner, and its trust caps the run', async () => {
    const { s, call, agent } = await setup();
    const wf = await call('POST', '/api/m/workflows/workflows', {
      name: 'Agent flow',
      graph: { nodes: [node('t', 'transform', { template: 'x' })], edges: [] },
    });
    // as if an agent at `standard` had made it
    s.db
      .prepare("UPDATE workflows_def SET created_by = ?, created_trust = 'standard' WHERE id = ?")
      .run(`agent:${agent}`, wf.body.workflow.id);
    const rt = await call('POST', '/api/m/routines/routines', {
      agentId: agent,
      name: 'Kick',
      prompt: 'go',
      trigger: { kind: 'manual', spec: {} },
      target: 'workflow',
      workflowId: wf.body.workflow.id,
    });
    const fired = await call('POST', `/api/m/routines/routines/${rt.body.routine.id}/run`);
    const sender = JSON.parse(
      (
        s.db.prepare('SELECT sender FROM workflows_run WHERE id = ?').get(fired.body.workflowRunId) as {
          sender: string;
        }
      ).sender,
    );
    expect(sender).toMatchObject({ kind: 'agent', id: agent, trust: 'standard' });
  });

  /**
   * An owner's routine starts an agent-made workflow: the run acts at the LOWEST trust anywhere in the chain (the
   * routine's created_trust, the routine's agent, the workflow's created_trust, and the workflow's maker as it is
   * now), never at the owner's, and never as the owner.
   */
  it.each([
    ['the routine’s created_trust', { routine: 'guarded' }],
    ['the routine’s agent', { routineAgent: 'guarded' }],
    ['the workflow’s created_trust', { workflow: 'guarded' }],
    ['the workflow’s maker, demoted since it made it', { maker: 'guarded' }],
  ] as const)(
    'an owner routine starting an agent-made workflow runs at the lowest trust in the chain: %s',
    async (_, low) => {
      const { s, call, agent } = await setup();
      const maker = seedAgent(s.db, { trust: 'trusted' });
      const wf = await call('POST', '/api/m/workflows/workflows', {
        name: 'Agent flow',
        graph: { nodes: [node('t', 'transform', { template: 'x' })], edges: [] },
      });
      s.db
        .prepare('UPDATE workflows_def SET created_by = ?, created_trust = ? WHERE id = ?')
        .run(`agent:${maker}`, 'workflow' in low ? low.workflow : 'standard', wf.body.workflow.id);
      const rt = await call('POST', '/api/m/routines/routines', {
        agentId: agent,
        name: 'Kick',
        prompt: 'go',
        trigger: { kind: 'manual', spec: {} },
        target: 'workflow',
        workflowId: wf.body.workflow.id,
      });
      expect(rt.status).toBe(201);
      const id = rt.body.routine.id;
      expect(s.db.prepare('SELECT created_trust FROM routines_routine WHERE id = ?').get(id)).toEqual({
        created_trust: 'trusted', // the owner made it
      });
      if ('routine' in low)
        s.db.prepare('UPDATE routines_routine SET created_trust = ? WHERE id = ?').run(low.routine, id);
      if ('routineAgent' in low)
        s.db.prepare('UPDATE agents SET trust_level = ? WHERE id = ?').run(low.routineAgent, agent);
      if ('maker' in low)
        s.db.prepare('UPDATE agents SET trust_level = ? WHERE id = ?').run(low.maker, maker);

      const fired = await call('POST', `/api/m/routines/routines/${id}/run`);
      expect(fired.status).toBe(202);
      const sender = JSON.parse(
        (
          s.db.prepare('SELECT sender FROM workflows_run WHERE id = ?').get(fired.body.workflowRunId) as {
            sender: string;
          }
        ).sender,
      );
      expect(sender.kind).not.toBe('owner');
      expect(sender).toMatchObject({ kind: 'agent', id: maker, trust: 'guarded' });
    },
  );
});
