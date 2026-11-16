/**
 * W28 `manage` grant over `chat`: two real servers (port 0, temp homes) linked over the in-memory transport, the
 * link and routines modules from source. A `manage` link may list the other machine's agents' status and start /
 * stop its routines, within that machine's own trust rules (the fire is a `link` sender, never the owner, at most
 * `standard`); never secrets (no prompt, trigger spec, instructions or workspace) and never settings. `view` and
 * `chat` links can do none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLinkModule } from '../../../../modules/link/src/server.js';
import { createRoutinesModule } from '../../../../modules/routines/src/server.js';
import { createMemoryNetwork } from '../../../../packages/link-transport/src/index.js';
import {
  bootTestServer,
  FakeProvider,
  seedAgent,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

const fake = new FakeProvider({
  script: () => [{ event: { type: 'text.final', text: 'ok' } }, { event: { type: 'done', stop: 'end' } }],
});
const PROMPT = 'Check the stock list; the door code is 4417.'; // a routine's prompt never leaves its machine

interface Machine {
  s: TestServer;
  api(path: string, body?: unknown): Promise<{ status: number; json: any }>;
  reauth(): Promise<void>;
}
async function machine(net: ReturnType<typeof createMemoryNetwork>, name: string): Promise<Machine> {
  const s = await bootTestServer({
    modules: [
      createLinkModule({ name, transport: (keys) => net.transport(keys) }),
      createRoutinesModule({ tickMs: 0 }),
    ],
    providers: [fake],
    dispatcher: { pollMs: 5 },
  });
  const password = `password-for-${name}`;
  const setup = await fetch(`${s.url}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: s.auth.issueSetupToken(), displayName: `Owner of ${name}`, password }),
  });
  const token = ((await setup.json()) as { token: string }).token;
  const api: Machine['api'] = async (path, body) => {
    const r = await fetch(`${s.url}${path}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  return {
    s,
    api,
    async reauth() {
      expect((await api('/api/v1/auth/reauth', { password })).status).toBe(200);
    },
  };
}

describe('linked machine: the `manage` grant', () => {
  const net = createMemoryNetwork();
  let a: Machine; // alpha: has the agent and the routine
  let b: Machine; // beta: linked to alpha
  let peerOfBOnA = '';
  let peerOfAOnB = '';
  let agentId = '';
  let routineId = '';
  const grant = (g: string) =>
    a.s.db.prepare('UPDATE link_peer SET grant_level = ? WHERE id = ?').run(g, peerOfBOnA);
  const fires = () =>
    a.s.db.prepare('SELECT count(*) AS n FROM routines_fire WHERE routine_id = ?').get(routineId) as {
      n: number;
    };

  beforeAll(async () => {
    a = await machine(net, 'alpha');
    b = await machine(net, 'beta');
    const code = (await a.api('/api/m/link/codes', {})).json.code as string;
    await b.reauth();
    const join = await b.api('/api/m/link/join', { code, grant: 'view' });
    expect(join.status).toBe(201);
    peerOfAOnB = join.json.peer.id;
    peerOfBOnA = (await a.api('/api/m/link/peers')).json.peers[0].id;
    await a.reauth();
    expect((await a.api(`/api/m/link/peers/${peerOfBOnA}/confirm`, { grant: 'view' })).status).toBe(200);

    agentId = seedAgent(a.s.db, { slug: 'tala', trust: 'trusted' });
    const rt = await a.api('/api/m/routines/routines', {
      agentId,
      name: 'Stock check',
      prompt: PROMPT,
      trigger: { kind: 'manual', spec: {} },
    });
    expect(rt.status).toBe(201);
    routineId = rt.json.routine.id;
  });
  afterAll(async () => {
    await a.s.cleanup();
    await b.s.cleanup();
  });

  it.each(['view', 'chat'])(
    'a `%s` link cannot see agents’ status nor list, start or stop routines',
    async (g) => {
      grant(g);
      const base = `/api/m/link/peers/${peerOfAOnB}`;
      for (const r of [
        await b.api(`${base}/status`),
        await b.api(`${base}/routines`),
        await b.api(`${base}/routines/${routineId}/start`, {}),
        await b.api(`${base}/routines/${routineId}/stop`, {}),
      ]) {
        expect(r.status).toBe(403);
        expect(r.json.error).toBe('grant');
      }
      expect(fires().n).toBe(0);
      expect(
        (a.s.db.prepare('SELECT enabled FROM routines_routine WHERE id = ?').get(routineId) as any).enabled,
      ).toBe(1);
    },
  );

  it('a `manage` link lists agents’ status and routines, never secrets or settings', async () => {
    grant('manage');
    const st = await b.api(`/api/m/link/peers/${peerOfAOnB}/status`);
    expect(st.status).toBe(200);
    expect(st.json.agents).toEqual([
      { id: agentId, slug: 'tala', name: 'tala', status: expect.any(String), running: 0, queued: 0 },
    ]);
    const rs = await b.api(`/api/m/link/peers/${peerOfAOnB}/routines`);
    expect(rs.status).toBe(200);
    expect(rs.json.routines).toEqual([
      expect.objectContaining({
        id: routineId,
        name: 'Stock check',
        agentId,
        enabled: true,
        trigger: 'manual',
      }),
    ]);
    const all = JSON.stringify([st.json, rs.json]);
    for (const leak of [
      '4417',
      'door code',
      'instructions',
      'workspace',
      'trustLevel',
      'createdTrust',
      'spec',
    ])
      expect(all).not.toContain(leak);
  });

  it('a `manage` link starts a routine as a linked machine (never the owner, at most standard) and stops it', async () => {
    grant('manage');
    a.s.queue.pause(agentId, 'test: keep the fire queued'); // so stop has queued work to cancel
    const started = await b.api(`/api/m/link/peers/${peerOfAOnB}/routines/${routineId}/start`, {});
    expect(started).toMatchObject({ status: 200, json: { status: 'queued' } });
    const item = a.s.db
      .prepare("SELECT id, source FROM queue_items WHERE agent_id = ? AND kind = 'routine'")
      .get(agentId) as { id: string; source: string };
    const sender = JSON.parse(item.source).sender;
    expect(sender).toMatchObject({ kind: 'link', id: peerOfBOnA, trust: 'standard' });

    const stopped = await b.api(`/api/m/link/peers/${peerOfAOnB}/routines/${routineId}/stop`, {});
    expect(stopped).toMatchObject({ status: 200, json: { paused: true, cancelled: 1 } });
    expect(
      (a.s.db.prepare('SELECT enabled FROM routines_routine WHERE id = ?').get(routineId) as any).enabled,
    ).toBe(0);
    expect(a.s.queue.get(item.id)?.state).toBe('cancelled');

    // a paused routine stays paused for a linked machine: only this machine's owner turns it back on
    const again = await b.api(`/api/m/link/peers/${peerOfAOnB}/routines/${routineId}/start`, {});
    expect(again.json).toMatchObject({ status: 'skipped', reason: 'routine is paused' });
    a.s.queue.resume(agentId);
  });
});
