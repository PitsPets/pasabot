/**
 * W9 done-criteria (ROADMAP): crash mid-step resume, rejection stops, untaken branch skipped, join all-failed
 * skip, loop hits cap and stops, the routine-flow template passes A's answer to B and C, model steps are
 * tool-less, and the agent tools' tiers + trust. Real Fastify on 127.0.0.1:0, temp $PASABOT_HOME, FakeProvider.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  FakeProvider,
  seedAgent,
  seedUser,
  type TestServer,
  tempHome,
} from '../../../packages/testkit/src/index.js';
import { analyse, fedByModel, type Graph, graphSchema, matchesSafe, unsafePattern } from './graph.js';
import { createWorkflowsModule } from './server.js';

const seen: { text: string; tools: string; agent: string }[] = [];
const fake = new FakeProvider({
  script: (input) => {
    seen.push({ text: input.user.text, tools: input.tools, agent: input.agent.id });
    if (input.user.text.includes('FAIL-ME')) return [{ event: { type: 'done', stop: 'error' } }];
    const first = input.user.text.split('\n')[0]!;
    return [
      { event: { type: 'text.final', text: `answer(${first})` } },
      { event: { type: 'done', stop: 'end' } },
    ];
  },
});

let open: TestServer[] = [];
afterEach(async () => {
  for (const s of open) await s.cleanup();
  open = [];
  seen.length = 0;
});

async function boot(o: { home?: string; beforeExec?: (n: string) => void } = {}) {
  const mod = createWorkflowsModule({ tickMs: 0, ...(o.beforeExec ? { beforeExec: o.beforeExec } : {}) });
  const s = await bootTestServer({
    modules: [mod],
    providers: [fake],
    dispatcher: { pollMs: 5 },
    ...(o.home ? { home: o.home } : {}),
  });
  open.push(s);
  return { s, mod, e: mod.engine() };
}
type Ctx = Awaited<ReturnType<typeof boot>> & { owner: { id: string; token: string }; agents: string[] };
async function setup(o: Parameters<typeof boot>[0] = {}): Promise<Ctx> {
  const b = await boot(o);
  const owner = seedUser(b.s.db);
  const agents = [seedAgent(b.s.db, { trust: 'trusted' }), seedAgent(b.s.db), seedAgent(b.s.db)];
  return { ...b, owner, agents };
}
const api = (c: { s: TestServer; owner: { token: string } }, method: string, path: string, body?: unknown) =>
  fetch(`${c.s.url}/api/m/workflows${path}`, {
    method,
    headers: {
      authorization: `Bearer ${c.owner.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
async function create(c: Ctx, graph: unknown, name = 'Flow') {
  const r = await api(c, 'POST', '/workflows', { name, graph });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { workflow: { id: string } }).workflow.id;
}
async function start(c: Ctx, id: string, input?: string) {
  const r = await api(c, 'POST', `/workflows/${id}/run`, input ? { input } : {});
  expect(r.status, await r.clone().text()).toBe(202);
  return ((await r.json()) as { run: { id: string } }).run.id;
}
interface RunView {
  run: { state: string; error: string | null; iterations: number; waitingApproval: boolean };
  steps: {
    id: string;
    nodeId: string;
    iter: number;
    state: string;
    output: { text: string } | null;
    approvalId?: string | null;
  }[];
}
const view = async (c: Ctx, runId: string) =>
  (await (await api(c, 'GET', `/runs/${runId}`)).json()) as RunView;
async function until(c: Ctx, runId: string, pred: (v: RunView) => boolean, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    await c.e.idle();
    const v = await view(c, runId);
    if (pred(v)) return v;
    if (Date.now() > end) throw new Error(`timeout; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ended = (v: RunView) => v.run.state !== 'running';
const node = (id: string, type: string, data: unknown) => ({ id, type, data, position: { x: 0, y: 0 } });
const edge = (source: string, target: string, branch?: 'true' | 'false') => ({
  id: `${source}-${target}`,
  source,
  target,
  ...(branch ? { branch } : {}),
});
const states = (v: RunView) => Object.fromEntries(v.steps.map((s) => [`${s.nodeId}#${s.iter}`, s.state]));

describe('graph checks', () => {
  it('refuses an unreachable node, a missing node, or a branchless condition edge; a loop at the start is fine', () => {
    const g = (x: unknown) => graphSchema.parse(x);
    expect(
      analyse(
        g({
          nodes: [node('a', 'parallel', {}), node('b', 'parallel', {})],
          edges: [edge('a', 'b'), edge('b', 'a')],
        }),
      ).back,
    ).toEqual(new Set(['b-a']));
    expect(() =>
      analyse(
        g({
          nodes: [node('a', 'parallel', {}), node('b', 'parallel', {}), node('c', 'parallel', {})],
          edges: [edge('b', 'c'), edge('c', 'b')],
        }),
      ),
    ).toThrow(/reached/);
    expect(() => analyse(g({ nodes: [node('a', 'parallel', {})], edges: [edge('a', 'zz')] }))).toThrow(
      /missing/,
    );
    expect(() =>
      analyse(
        g({
          nodes: [node('c', 'condition', { op: 'empty' }), node('b', 'parallel', {})],
          edges: [edge('c', 'b')],
        }),
      ),
    ).toThrow(/branch/);
  });
});

describe('engine', () => {
  it('condition: only the chosen branch continues; the untaken branch (and what follows it) is skipped', async () => {
    const c = await setup();
    const id = await create(c, {
      nodes: [
        node('c', 'condition', { op: 'contains', value: 'yes' }),
        node('t', 'transform', { template: 'T:{{input}}' }),
        node('f', 'transform', { template: 'F:{{input}}' }),
        node('f2', 'transform', { template: 'after F' }),
      ],
      edges: [edge('c', 't', 'true'), edge('c', 'f', 'false'), edge('f', 'f2')],
    });
    const v = await until(c, await start(c, id, 'yes please'), ended);
    expect(v.run.state).toBe('done');
    expect(states(v)).toEqual({ 'c#0': 'done', 't#0': 'done', 'f#0': 'skipped', 'f2#0': 'skipped' });
    expect(v.steps.find((s) => s.nodeId === 't')!.output!.text).toBe('T:yes please');
  });

  it('join waits for all inputs and is skipped when every input failed', async () => {
    const c = await setup();
    const [a] = c.agents;
    const id = await create(c, {
      nodes: [
        node('p', 'parallel', {}),
        node('x', 'agent', { agentId: a, prompt: 'FAIL-ME one' }),
        node('y', 'agent', { agentId: a, prompt: 'FAIL-ME two' }),
        node('j', 'transform', { template: 'joined {{input}}' }),
      ],
      edges: [edge('p', 'x'), edge('p', 'y'), edge('x', 'j'), edge('y', 'j')],
    });
    const v = await until(c, await start(c, id), ended);
    expect(states(v)).toEqual({ 'p#0': 'done', 'x#0': 'failed', 'y#0': 'failed', 'j#0': 'skipped' });
    expect(v.run.state).toBe('failed');

    // one input done, one failed: the join still runs with what arrived
    const id2 = await create(c, {
      nodes: [
        node('p', 'parallel', {}),
        node('x', 'agent', { agentId: a, prompt: 'FAIL-ME one' }),
        node('y', 'agent', { agentId: a, prompt: 'fine' }),
        node('j', 'transform', { template: 'joined {{input}}' }),
      ],
      edges: [edge('p', 'x'), edge('p', 'y'), edge('x', 'j'), edge('y', 'j')],
    });
    const v2 = await until(c, await start(c, id2), ended);
    expect(states(v2)['j#0']).toBe('done');
    expect(v2.steps.find((s) => s.nodeId === 'j')!.output!.text).toBe('joined answer(fine)');
  });

  it('approval: approve continues; reject stops the run and nothing after it runs', async () => {
    const c = await setup();
    const graph = {
      nodes: [
        node('t', 'transform', { template: 'draft' }),
        node('ok', 'approval', { message: 'Send it?' }),
        node('out', 'output', { to: 'notification', title: 'Sent', template: '{{input}}!' }),
      ],
      edges: [edge('t', 'ok'), edge('ok', 'out')],
    };
    const id = await create(c, graph);
    const r1 = await start(c, id);
    let v = await until(c, r1, (x) => x.run.waitingApproval);
    const appr = v.steps.find((s) => s.nodeId === 'ok')!;
    expect(appr.state).toBe('waiting');
    // it is a core approval: listed at /api/v1/approvals (decision bar, "needs you"), answered there
    expect(appr.approvalId).toBeTruthy();
    const core = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${c.s.url}/api/v1/approvals${path}`, {
        method,
        headers: {
          authorization: `Bearer ${c.owner.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const listed = (await (await core('?state=pending')).json()) as {
      approvals: { id: string; runId: string | null; subject: string; tier: number; href: string }[];
    };
    expect(listed.approvals).toEqual([
      expect.objectContaining({
        id: appr.approvalId,
        runId: null,
        subject: `workflow:${r1}:${appr.id}`,
        tier: 2,
        href: '/workflows',
      }),
    ]);
    const nonce = c.s.approvals.get(appr.approvalId!)?.nonce;
    expect((await core(`/${appr.approvalId}/approve`, 'POST', { nonce })).status).toBe(200);
    v = await until(c, r1, ended);
    expect(v.run.state).toBe('done');
    expect(v.steps.find((s) => s.nodeId === 'out')!.output!.text).toBe('draft!');
    // deciding twice is refused
    expect((await api(c, 'POST', `/runs/${r1}/steps/${appr.id}/reject`)).status).toBe(409);

    const r2 = await start(c, id);
    v = await until(c, r2, (x) => x.run.waitingApproval);
    const appr2 = v.steps.find((s) => s.nodeId === 'ok')!;
    expect((await api(c, 'POST', `/runs/${r2}/steps/${appr2.id}/reject`)).status).toBe(200);
    v = await until(c, r2, ended);
    expect(v.run.state).toBe('rejected');
    expect(v.steps.some((s) => s.nodeId === 'out')).toBe(false);
    // the screen's reject decided the same core approval
    const decided = (await (await core(`?state=denied`)).json()) as { approvals: { id: string }[] };
    expect(decided.approvals.map((a) => a.id)).toContain(appr2.approvalId);

    // cancelling a run that waits withdraws its approval from the decision bar
    const r3 = await start(c, id);
    v = await until(c, r3, (x) => x.run.waitingApproval);
    const appr3 = v.steps.find((s) => s.nodeId === 'ok')!;
    expect((await api(c, 'POST', `/runs/${r3}/cancel`)).status).toBe(200);
    const after = (await (await core(`?state=pending`)).json()) as { approvals: unknown[] };
    expect(after.approvals).toEqual([]);
    expect(c.s.db.prepare('SELECT state FROM approvals WHERE id = ?').get(appr3.approvalId)).toEqual({
      state: 'expired',
    });
  });

  it('a waiting approval outlives a restart and is answered after it', async () => {
    const home = tempHome();
    const c = await setup({ home: home.dir });
    const id = await create(c, {
      nodes: [node('ok', 'approval', { message: 'Go?' }), node('t', 'transform', { template: 'went' })],
      edges: [edge('ok', 't')],
    });
    const r = await start(c, id);
    const v = await until(c, r, (x) => x.run.waitingApproval);
    const approvalId = v.steps[0]!.approvalId!;
    await c.s.close();
    open = open.filter((x) => x !== c.s);
    const b = await boot({ home: home.dir });
    // still pending after the restart (only agent-run approvals expire at boot)
    expect(b.s.db.prepare('SELECT state FROM approvals WHERE id = ?').get(approvalId)).toEqual({
      state: 'pending',
    });
    const c2 = { ...b, owner: c.owner, agents: c.agents };
    // the card's nonce survives the restart (it is stored with the approval)
    const res = await fetch(`${b.s.url}/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: b.s.approvals.get(approvalId)?.nonce }),
    });
    expect(res.status).toBe(200);
    const done = await until(c2, r, ended);
    expect(done.run.state).toBe('done');
    expect(states(done)).toEqual({ 'ok#0': 'done', 't#0': 'done' });
    home.cleanup();
  });

  it('a loop re-runs until its condition lets go, and a loop that never ends hits the cap and stops', async () => {
    const c = await setup();
    // counter: t appends "x"; condition loops back while the text is shorter than 3 x's
    const id = await create(c, {
      nodes: [
        node('t', 'transform', { template: '{{input}}x' }),
        node('c', 'condition', { op: 'matches', value: '^x{3}$' }),
        node('done', 'transform', { template: 'got {{input}}' }),
      ],
      edges: [
        edge('t', 'c'),
        edge('c', 'done', 'true'),
        { id: 'loop', source: 'c', target: 't', branch: 'false' },
      ],
      maxIterations: 5,
    });
    const v = await until(c, await start(c, id), ended);
    expect(v.run.state).toBe('done');
    expect(v.steps.find((s) => s.nodeId === 'done' && s.state === 'done')!.output!.text).toBe('got xxx');
    expect(v.run.iterations).toBe(2);

    const forever = await create(c, {
      nodes: [node('t', 'transform', { template: 'again' }), node('c', 'condition', { op: 'empty' })],
      edges: [edge('t', 'c'), { id: 'loop', source: 'c', target: 't', branch: 'false' }],
      maxIterations: 3,
    });
    const v2 = await until(c, await start(c, forever), ended);
    expect(v2.run.state).toBe('stopped');
    expect(v2.run.error).toMatch(/limit of 3/);
    expect(v2.steps.filter((s) => s.nodeId === 't')).toHaveLength(4); // first run + 3 repeats
  });

  it('crash mid-step: the run resumes after a restart and finished steps never run twice', async () => {
    const home = tempHome();
    try {
      let crash = true;
      const c = await setup({
        home: home.dir,
        beforeExec: (n) => {
          if (n === 'b' && crash) throw new Error('simulated crash in the middle of step b');
        },
      });
      const [a] = c.agents;
      const id = await create(c, {
        nodes: [
          node('a', 'agent', { agentId: a, prompt: 'first' }),
          node('b', 'transform', { template: 'B saw {{input}}' }),
          node('w', 'wait', { seconds: 60 }),
          node('o', 'output', { to: 'notification', title: 'Result', template: '{{node.b}}' }),
        ],
        edges: [edge('a', 'b'), edge('b', 'w'), edge('w', 'o')],
      });
      const runId = await start(c, id);
      const v = await until(c, runId, (x) => x.steps.some((s) => s.nodeId === 'b'));
      expect(states(v)).toEqual({ 'a#0': 'done', 'b#0': 'running' });
      const agentTurns = seen.length;
      await c.s.close();
      open = open.filter((s) => s !== c.s);

      crash = false;
      const c2 = { ...(await boot({ home: home.dir })), owner: c.owner, agents: c.agents };
      // the wait step is pending now; move past it
      let w = await until(c2, runId, (x) => x.steps.some((s) => s.nodeId === 'w' && s.state === 'waiting'));
      c2.s.db.prepare("UPDATE workflows_step SET resume_at = 0 WHERE node_id = 'w'").run();
      await c2.e.tick();
      w = await until(c2, runId, ended);
      expect(w.run.state).toBe('done');
      expect(states(w)).toEqual({ 'a#0': 'done', 'b#0': 'done', 'w#0': 'done', 'o#0': 'done' });
      expect(w.steps.find((s) => s.nodeId === 'o')!.output!.text).toBe('B saw answer(first)');
      expect(seen.length).toBe(agentTurns); // the agent step was not run again
    } finally {
      home.cleanup();
    }
  });

  it('routine-flow template: A answers, B and C each get A’s answer', async () => {
    const c = await setup();
    const [a, b, cc] = c.agents;
    const r = await api(c, 'POST', '/workflows/from-template', {
      template: 'fan-out',
      name: 'Morning flow',
      agentIds: [a, b, cc],
      prompt: 'What is new today?',
      followUp: 'Plan your part.',
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const id = ((await r.json()) as { workflow: { id: string } }).workflow.id;
    const v = await until(c, await start(c, id), ended);
    expect(v.run.state).toBe('done');
    const toB = seen.find((s) => s.agent === b)!;
    const toC = seen.find((s) => s.agent === cc)!;
    for (const t of [toB, toC]) {
      expect(t.text).toContain('Plan your part.');
      expect(t.text).toContain('answer(What is new today?)');
    }
  });

  it('a model step is a tool-less call; an agent step gets the gateway', async () => {
    const c = await setup();
    const [a] = c.agents;
    const id = await create(c, {
      nodes: [
        node('m', 'model', { agentId: a, prompt: 'summarise' }),
        node('g', 'agent', { agentId: a, prompt: 'act' }),
      ],
      edges: [edge('m', 'g')],
    });
    await until(c, await start(c, id), ended);
    expect(seen.find((s) => s.text.startsWith('summarise'))!.tools).toBe('none');
    expect(seen.find((s) => s.text.startsWith('act'))!.tools).toBe('gateway');
  });

  it('owner-only REST; members get 403; bad graphs get 400', async () => {
    const c = await setup();
    const member = seedUser(c.s.db, 'member', 'M');
    expect((await api({ s: c.s, owner: member }, 'GET', '/workflows')).status).toBe(403);
    const bad = await api(c, 'POST', '/workflows', {
      name: 'x',
      graph: { nodes: [node('a', 'agent', { agentId: 'nope', prompt: 'p' })], edges: [] },
    });
    expect(bad.status).toBe(400);
  });
});

describe('review fixes', () => {
  it('matches: slow patterns are refused at save time, and a slow one already saved times out as false', async () => {
    expect(unsafePattern('^(a|aa)+$')).toMatch(/repeated group/);
    expect(unsafePattern('(a+)+b')).toMatch(/repeated group/);
    expect(unsafePattern('(x)\\1')).toMatch(/back-references/);
    expect(unsafePattern('a(?=b)')).toMatch(/look-ahead/);
    expect(unsafePattern('^urgent|asap$')).toBeNull();
    expect(unsafePattern('^(?:ok|done)$')).toBeNull();
    expect(unsafePattern('order #\\d{3,6}')).toBeNull();
    // a pattern that slipped past the save-time check still cannot hold the event loop
    const t0 = Date.now();
    expect(await matchesSafe('a*a*a*a*a*a*a*a*c', 'a'.repeat(2_000), 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await matchesSafe('^order #\\d{3,6}$', 'Order #12345')).toBe(true);

    const c = await setup();
    const cond = (value: string) => ({
      nodes: [
        node('c', 'condition', { op: 'matches', value }),
        node('t', 'transform', { template: 'T' }),
        node('f', 'transform', { template: 'F' }),
      ],
      edges: [edge('c', 't', 'true'), edge('c', 'f', 'false')],
    });
    const bad = await api(c, 'POST', '/workflows', { name: 'x', graph: cond('^(a|aa)+$') });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/repeated group/);

    // a graph saved before the check existed: the condition is false, and the server keeps answering
    const id = await create(c, cond('^ok$'));
    const g = JSON.stringify(cond('^(a|aa)+$'));
    c.s.db.prepare('UPDATE workflows_def SET graph = ? WHERE id = ?').run(g, id);
    const started = Date.now();
    const v = await until(c, await start(c, id, `${'a'.repeat(40)}!`), ended);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(states(v)).toEqual({ 'c#0': 'done', 't#0': 'skipped', 'f#0': 'done' });
    expect((await api(c, 'GET', '/workflows')).status).toBe(200);
  });

  it('output to a channel with no channel transport fails the step instead of reporting a post', async () => {
    const c = await setup();
    const id = await create(c, {
      nodes: [
        node('t', 'transform', { template: 'hello' }),
        node('o', 'output', { to: 'channel', channel: 'b1', title: 'Post' }),
      ],
      edges: [edge('t', 'o')],
    });
    const v = await until(c, await start(c, id), ended);
    expect(v.run.state).toBe('failed');
    expect(states(v)).toEqual({ 't#0': 'done', 'o#0': 'failed' });
    const step = c.s.db.prepare("SELECT error FROM workflows_step WHERE node_id = 'o'").get() as {
      error: string;
    };
    // no channel runtime transport here: the notifier says so and the step fails (the runtime test sends one)
    expect(step.error).toMatch(/^could not send: .*no "channel" transport is running/);
  });

  it('owner-made workflows: a step fed by an earlier agent never acts as the owner', async () => {
    const c = await setup();
    const [a, b, cc] = c.agents;
    const r = await api(c, 'POST', '/workflows/from-template', {
      template: 'fan-out',
      name: 'Fan',
      agentIds: [a, b, cc],
      prompt: 'Browse and answer',
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const id = ((await r.json()) as { workflow: { id: string } }).workflow.id;
    const v = await until(c, await start(c, id), ended);
    expect(v.run.state).toBe('done');
    const sender = (agentId: string) =>
      (
        JSON.parse(
          (
            c.s.db
              .prepare("SELECT source FROM queue_items WHERE kind = 'workflow' AND agent_id = ?")
              .get(agentId) as { source: string }
          ).source,
        ) as { sender: { kind: string; trust: string } }
      ).sender;
    expect(sender(a!).kind).toBe('owner'); // A only sees the owner's own run input
    for (const x of [b!, cc!]) expect(sender(x).kind).not.toBe('owner');

    // static check: loops count from the second trip on; a transform pulling node outputs counts too
    const info = analyse(
      graphSchema.parse({
        nodes: [
          node('w', 'wait', { seconds: 1 }),
          node('ag', 'agent', { agentId: a, prompt: 'p' }),
          node('c', 'condition', { op: 'empty' }),
          node('t', 'transform', { template: '{{node.ag}}' }),
          node('z', 'agent', { agentId: a, prompt: 'p' }),
        ],
        edges: [
          edge('w', 'ag'),
          edge('ag', 'c'),
          edge('c', 'ag', 'false'),
          edge('c', 't', 'true'),
          edge('t', 'z'),
        ],
      }),
    );
    expect(fedByModel(info, 'ag', 0)).toBe(false);
    expect(fedByModel(info, 'ag', 1)).toBe(true);
    expect(fedByModel(info, 'z', 0)).toBe(true);
  });
});

describe('agent tools', () => {
  it('tiers: list 0, create/edit/run 2, delete 3; agent-made workflows keep the creating trust', async () => {
    const c = await setup();
    const tools = (c.s as unknown as { tools: { get(n: string): { tier: unknown } | undefined } }).tools;
    expect(tools.get('workflows_list')!.tier).toBe(0);
    expect(tools.get('workflows_create')!.tier).toBe(2);
    expect(tools.get('workflows_update')!.tier).toBe(2);
    expect(tools.get('workflows_run')!.tier).toBe(2);
    expect(tools.get('workflows_delete')!.tier).toBe(3);
    // W38: deleting a workflow is the fixed delete class (always asks, app-only approval)
    expect((tools.get('workflows_delete') as { actionClass?: unknown }).actionClass).toBe('delete');
    const g: Graph = graphSchema.parse({ nodes: [node('t', 'transform', { template: 'hi' })] });
    expect(g.maxIterations).toBe(10);
  });
});
