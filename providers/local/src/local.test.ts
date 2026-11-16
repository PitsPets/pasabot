/**
 * W34 done-criteria. Stub HTTP servers on 127.0.0.1 port 0 speak Ollama's API and the OpenAI-compatible one; a
 * booted PasaBot server (real orchestrator, queue, MCP gateway, routines and the W3 policy) runs turns on them.
 * Nothing here reaches the network or starts a binary.
 */
import { rmSync } from 'node:fs';
import { defineModule, type ProviderAdapter, type ProviderEvent, type TurnInput } from '@pasabot/core';
import { createProviderOpsModule } from '@pasabot/mod-provider-ops/server';
import { createRoutinesModule } from '@pasabot/mod-routines/server';
import { classifyLocalModelUrl, createSafeNet, fetchLocalModel, SsrfError } from '@pasabot/safe-net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bootTestServer,
  seedAgent,
  seedAutomationToken,
  seedChat,
  seedRunToken,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { deadUrl, ollamaStub, openAiStub, type Stub } from './__fixtures__/stub.js';
import { type LocalApi, LocalModelAdapter, TOOLS_OFF_NOTE } from './adapter.js';
import { createLocalModule } from './server.js';

const stubs: Stub[] = [];
let s: TestServer | null = null;
afterEach(async () => {
  for (const x of stubs.splice(0)) await x.close();
  if (s) rmSync(`${s.home}-accounts`, { recursive: true, force: true });
  await s?.cleanup();
  s = null;
});

async function until<T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** a tool the gateway offers every run, so a tool round-trip is visible end to end */
const probeTools = defineModule({
  id: 'w34probe',
  register(app) {
    app.tools.add({
      name: 'w34probe_echo',
      title: 'Echo',
      description: 'Returns the text it was given.',
      input: z.object({ text: z.string() }),
      output: z.object({ echo: z.string() }),
      tier: 0,
      handler: async ({ text }) => ({ echo: `ECHO ${text}` }),
    });
  },
});

async function boot(
  candidates: { api: LocalApi; url: string; name: string }[] = [],
  extra: ReturnType<typeof defineModule>[] = [],
) {
  s = await bootTestServer({
    modules: [
      createLocalModule({ candidates, timeoutMs: 3000 }),
      createProviderOpsModule(),
      createRoutinesModule(),
      probeTools,
      ...extra,
    ],
  });
  const owner = seedUser(s.db);
  return { owner, api: api(owner.token) };
}
function api(token: string, extra: Record<string, string> = {}) {
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s!.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...extra,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
}
async function addEndpoint(
  call: ReturnType<typeof api>,
  name: string,
  apiKind: LocalApi,
  url: string,
  tools = 'auto',
) {
  const r = await call('POST', '/api/m/local/endpoints', { name, api: apiKind, url, tools });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.endpoint as { id: string; providerId: string; url: string; warning?: string };
}
const finalReply = (chatId: string) =>
  until(
    () =>
      s!.db
        .prepare(
          "SELECT body FROM messages WHERE chat_id = ? AND author_kind = 'agent' AND status = 'final' ORDER BY created_at DESC",
        )
        .get(chatId) as { body: string } | undefined,
  );
async function send(call: ReturnType<typeof api>, chatId: string, text: string) {
  const r = await call('POST', `/api/v1/chats/${chatId}/messages`, { text });
  expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
}
function setModel(agentId: string, providerId: string, model: string) {
  s!.db.prepare('UPDATE agents SET provider_id = ?, model = ? WHERE id = ?').run(providerId, model, agentId);
}

/** run one turn straight on an adapter (no server), collecting its events */
async function turn(a: LocalModelAdapter, text: string, o: Partial<TurnInput> = {}) {
  const out: ProviderEvent[] = [];
  const input = {
    runId: 'r1',
    agent: { id: 'a', trustLevel: 'standard' } as TurnInput['agent'],
    workspaceDir: '/tmp',
    systemPrompt: 'You are a test.',
    user: { text, attachments: [], from: { kind: 'owner', id: 'u', name: 'Owner', trust: 'trusted' } },
    mcp: { url: '', bearer: '' },
    tools: 'none',
    env: {},
    ...o,
  } as TurnInput;
  for await (const e of a.runTurn(input, new AbortController().signal)) out.push(e);
  return out;
}

describe.each([
  ['ollama', ollamaStub, 'chatty:latest', 'plain:latest'],
  ['openai', openAiStub, 'chatty', 'plain'],
] as const)('%s API against a stub on 127.0.0.1:0', (apiKind, make, toolModel, plainModel) => {
  it('detect, list models (with tool support), a streamed turn with usage', async () => {
    const stub = await make();
    stubs.push(stub);
    const a = new LocalModelAdapter({
      id: 'x',
      name: 'Stub',
      api: apiKind,
      baseUrl: stub.url,
      origin: stub.origin,
      scope: 'loopback',
      tools: 'auto',
    });
    expect((await a.detect()).installed).toBe(true);
    const models = await a.models();
    expect(models.map((m) => m.id)).toEqual([toolModel, plainModel]);
    if (apiKind === 'ollama') expect(models.map((m) => m.tools)).toEqual([true, false]);
    const ev = await turn(a, 'hello there', { model: toolModel });
    const deltas = ev.filter((e) => e.type === 'text.delta');
    expect(deltas.length).toBe(2); // streamed in parts
    expect(ev.find((e) => e.type === 'text.final')).toMatchObject({ text: 'local: hello there' });
    expect(ev.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: expect.any(Number) });
    expect((ev.find((e) => e.type === 'usage') as any).inputTokens).toBeGreaterThan(0);
    expect(ev.filter((e) => e.type === 'done')).toEqual([{ type: 'done', stop: 'end' }]);
  });

  it('owner adds it in the app; an agent on it does a tool call round-trip through the MCP gateway', async () => {
    const stub = await make();
    stubs.push(stub);
    const { owner, api: call } = await boot();
    const ep = await addEndpoint(call, 'My stub', apiKind, stub.url);
    expect(ep.providerId).toBe(`local:${ep.id}`);
    const providers = await call('GET', '/api/v1/providers');
    expect(providers.json.providers.map((p: { id: string }) => p.id)).toContain(ep.providerId);
    const agent = seedAgent(s!.db, { providerId: ep.providerId, trust: 'trusted' });
    setModel(agent, ep.providerId, toolModel);
    const chat = seedChat(s!.db, { userIds: [owner.id], agentIds: [agent] });
    await send(call, chat, 'call w34probe_echo {"text":"hi"}');
    const reply = await finalReply(chat);
    expect(reply.body).toContain('tool said:');
    expect(reply.body).toContain('ECHO hi');
    // the tool list reached the model, then the tool result went back to it
    const chats = stub.requests.filter((r) => r.path.endsWith('chat') || r.path.endsWith('completions'));
    expect(chats[0]!.body.tools.map((t: any) => t.function.name)).toContain('w34probe_echo');
    expect(
      chats[1]!.body.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('ECHO hi')),
    ).toBe(true);
  });

  it.runIf(apiKind === 'ollama')(
    'the global stop (W31) cancels a local-model run in flight: no fallback and no rerun',
    async () => {
      const stub = await make();
      stubs.push(stub);
      const { owner, api: call } = await boot();
      const ep = await addEndpoint(call, 'My stub', apiKind, stub.url);
      const agent = seedAgent(s!.db, { providerId: ep.providerId, trust: 'trusted' });
      setModel(agent, ep.providerId, toolModel);
      const chat = seedChat(s!.db, { userIds: [owner.id], agentIds: [agent] });
      const switched: unknown[] = [];
      s!.bus.subscribe((ev) => {
        if (ev.type === 'provider.switched') switched.push(ev.data);
      });
      await send(call, chat, 'hang on a moment');
      const run = await until(
        () =>
          s!.db
            .prepare("SELECT id, queue_item_id FROM runs WHERE agent_id = ? AND state = 'running'")
            .get(agent) as { id: string; queue_item_id: string } | undefined,
      );
      await until(() => stub.requests.some((r) => r.path === '/api/chat'));
      const report = await s!.killSwitch.stopAll({ kind: 'owner', userId: owner.id }, 'test');
      expect(report.items).toContainEqual(
        expect.objectContaining({ kind: 'run', runId: run.id, outcome: 'cancelled' }),
      );
      const ended = await until(
        () =>
          s!.db.prepare("SELECT state FROM runs WHERE id = ? AND state != 'running'").get(run.id) as
            | { state: string }
            | undefined,
      );
      expect(ended.state).toBe('cancelled');
      expect(
        (
          s!.db.prepare('SELECT state FROM queue_items WHERE id = ?').get(run.queue_item_id) as {
            state: string;
          }
        ).state,
      ).toBe('cancelled');
      expect(switched).toEqual([]);
      expect(stub.requests.filter((r) => r.path === '/api/chat')).toHaveLength(1);
    },
  );

  it('degraded mode: a model without tools runs chat only and says tools are off', async () => {
    const stub = await make();
    stubs.push(stub);
    const { owner, api: call } = await boot();
    const ep = await addEndpoint(call, 'My stub', apiKind, stub.url);
    const agent = seedAgent(s!.db, { providerId: ep.providerId, trust: 'trusted' });
    setModel(agent, ep.providerId, plainModel);
    const chat = seedChat(s!.db, { userIds: [owner.id], agentIds: [agent] });
    await send(call, chat, 'just chat');
    expect((await finalReply(chat)).body).toBe('local: just chat');
    const run = await until(
      () =>
        s!.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND state = 'done'").get(agent) as
          | { id: string }
          | undefined,
    );
    const thinking = s!.db
      .prepare("SELECT data FROM run_events WHERE run_id = ? AND type = 'thinking'")
      .all(run.id) as { data: string }[];
    expect(thinking.map((t) => t.data).join(' ')).toContain('Tools are off');
    // the models list now says chat only for it
    const models = await call('GET', `/api/m/local/endpoints/${ep.id}/models`);
    expect(models.json.models.find((m: any) => m.id === plainModel).tools).toBe(false);
    expect(TOOLS_OFF_NOTE).toMatch(/chat only/);
  });
});

describe('safe-net: only owner-configured local endpoints', () => {
  it('refuses an agent-supplied local URL, accepts the owner-configured one, warns on a LAN address', async () => {
    const stub = await ollamaStub();
    stubs.push(stub);
    // the ordinary outbound path (what any agent tool uses) refuses loopback
    await expect(createSafeNet().fetch(`${stub.url}/api/tags`)).rejects.toBeInstanceOf(SsrfError);
    // the local-model path refuses an origin the owner never configured
    await expect(fetchLocalModel(`${stub.url}/api/tags`, { allowed: [] })).rejects.toThrow(
      /not an owner-configured/,
    );
    await expect(
      fetchLocalModel(`${stub.url}/api/tags`, { allowed: ['http://127.0.0.1:1'] }),
    ).rejects.toThrow(/not an owner-configured/);
    // and accepts exactly the configured one
    const ok = await fetchLocalModel(`${stub.url}/api/tags`, { allowed: [stub.origin] });
    expect(ok.status).toBe(200);
    // classification: loopback fine, LAN with a warning, public / metadata / names refused
    expect(classifyLocalModelUrl('http://127.0.0.1:11434')).toMatchObject({ ok: true, scope: 'loopback' });
    expect(classifyLocalModelUrl('http://localhost:11434')).toMatchObject({ ok: true, scope: 'loopback' });
    const lan = classifyLocalModelUrl('http://192.168.1.20:1234/v1');
    expect(lan).toMatchObject({ ok: true, scope: 'lan' });
    expect((lan as { warning?: string }).warning).toMatch(/local network/);
    for (const bad of [
      'http://8.8.8.8:11434',
      'http://169.254.169.254/',
      'http://example.com:11434',
      'http://user:pw@127.0.0.1:11434',
      'file:///etc/passwd',
    ])
      expect(classifyLocalModelUrl(bad).ok, bad).toBe(false);
  });

  it('only an owner session can configure an endpoint: agents (run bearer), automation and members cannot', async () => {
    const stub = await ollamaStub();
    stubs.push(stub);
    const { api: call } = await boot();
    const agent = seedAgent(s!.db);
    const body = { name: 'sneaky', api: 'ollama', url: stub.url };
    const run = api(seedRunToken(s!.db, agent).token);
    expect((await run('POST', '/api/m/local/endpoints', body)).status).toBe(401);
    const auto = api(seedAutomationToken(s!.db, agent));
    expect([401, 403]).toContain((await auto('POST', '/api/m/local/endpoints', body)).status);
    const member = api(seedUser(s!.db, 'member', 'M').token);
    expect((await member('POST', '/api/m/local/endpoints', body)).status).toBe(403);
    expect((await call('GET', '/api/m/local/endpoints')).json.endpoints).toEqual([]);
    // no tool exposes the endpoint list to agents
    const tools = s!.tools.list().map((t: { name: string }) => t.name);
    expect(tools.some((n: string) => n.startsWith('local'))).toBe(false);
    // the owner can; a LAN address is stored with its warning; a public one is refused
    expect((await call('POST', '/api/m/local/endpoints', body)).status).toBe(200);
    const lan = await call('POST', '/api/m/local/endpoints', {
      name: 'Box',
      api: 'openai',
      url: 'http://10.1.2.3:1234',
    });
    expect(lan.json.endpoint).toMatchObject({ warning: 'lan', url: 'http://10.1.2.3:1234/v1' });
    expect(
      (await call('POST', '/api/m/local/endpoints', { name: 'x', api: 'ollama', url: 'http://1.1.1.1' }))
        .status,
    ).toBe(400);
  });

  it('detects a local endpoint on the usual loopback ports', async () => {
    const stub = await ollamaStub();
    stubs.push(stub);
    const dead = await deadUrl();
    const { api: call } = await boot([
      { api: 'ollama', url: stub.url, name: 'Ollama' },
      { api: 'openai', url: `${dead}/v1`, name: 'LM Studio' },
    ]);
    const r = await call('GET', '/api/m/local/detect');
    expect(r.json.found).toEqual([{ name: 'Ollama', api: 'ollama', url: stub.url, models: 2 }]);
  });
});

describe('offline fallback for routines', () => {
  async function setup() {
    const local = await ollamaStub();
    stubs.push(local);
    const dead = await deadUrl();
    const { owner, api: call } = await boot();
    const primary = await addEndpoint(call, 'Remote box (down)', 'openai', `${dead}/v1`);
    const fallback = await addEndpoint(call, 'Ollama', 'ollama', local.url);
    const agent = seedAgent(s!.db, { providerId: primary.providerId, trust: 'trusted' });
    setModel(agent, primary.providerId, 'big');
    seedChat(s!.db, { userIds: [owner.id], agentIds: [agent] });
    const put = await call('PUT', `/api/m/provider-ops/agents/${agent}`, {
      fallback: [{ providerId: fallback.providerId, model: 'chatty:latest' }],
      accountId: null,
      compactPct: null,
      compactTokens: null,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    return { call, agent, fallback };
  }
  async function routine(call: ReturnType<typeof api>, agent: string, runEvenOffline: boolean) {
    const r = await call('POST', '/api/m/routines/routines', {
      agentId: agent,
      name: 'Morning check',
      prompt: 'Check things.',
      trigger: { kind: 'manual', spec: {} },
      runEvenOffline,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.routine.runEvenOffline).toBe(runEvenOffline);
    expect((await call('POST', `/api/m/routines/routines/${r.json.routine.id}/run`)).status).toBe(202);
    return r.json.routine.id as string;
  }

  it('a routine marked "run even offline" falls back to the local model and says so in its result', async () => {
    const { call, agent, fallback } = await setup();
    const id = await routine(call, agent, true);
    const fire = await until(
      () =>
        s!.db.prepare("SELECT * FROM routines_fire WHERE routine_id = ? AND result != 'pending'").get(id) as
          | any
          | undefined,
    );
    expect(fire.result).toBe('ok');
    // the endpoint's name, never its raw provider id
    expect(fire.note).toBe('primary offline: ran on Ollama · chatty:latest');
    expect(fire.note).not.toContain(fallback.providerId);
    const activity = await call('GET', '/api/m/routines/activity?limit=5');
    expect(activity.json.fires[0].note).toContain('primary offline');
    const runs = s!.db
      .prepare('SELECT provider_id, state FROM runs WHERE agent_id = ? ORDER BY started_at')
      .all(agent) as { provider_id: string; state: string }[];
    expect(runs.map((r) => r.provider_id)).toEqual([expect.stringMatching(/^local:/), fallback.providerId]);
    expect(runs.map((r) => r.state)).toEqual(['failed', 'done']);
  });

  it('one not marked is held (per W3), not failed and not switched', async () => {
    const { call, agent } = await setup();
    const id = await routine(call, agent, false);
    const held = await until(
      () =>
        s!.db.prepare("SELECT resume_at FROM queue_items WHERE agent_id = ? AND state = 'held'").get(agent) as
          | { resume_at: number }
          | undefined,
    );
    expect(held.resume_at).toBeGreaterThan(Date.now());
    await new Promise((r) => setTimeout(r, 100));
    const fire = s!.db.prepare('SELECT result, note FROM routines_fire WHERE routine_id = ?').get(id) as any;
    expect(fire.result).toBe('pending');
    expect(fire.note).toMatch(/^held: /);
    const runs = s!.db.prepare('SELECT provider_id FROM runs WHERE agent_id = ?').all(agent) as any[];
    expect(runs).toHaveLength(1);
    // the Brain picker names the down endpoint and reads it "not reachable" (reachable: false), not "not installed"
    const brains = (await call('GET', '/api/v1/providers')).json.providers as any[];
    const down = brains.find((p) => p.displayName === 'Remote box (down)');
    expect(down.status).toMatchObject({ installed: false, reachable: false });
    expect(down.status.hint).toMatch(
      /^Remote box \(down\) \(http:\/\/127\.0\.0\.1:\d+\/v1\) is not answering$/,
    );
    expect(brains.find((p) => p.displayName === 'Ollama').status).toMatchObject({ installed: true });
  });
});

/**
 * A provider shaped like the cloud CLI adapters (claude, codex, opencode, ACP): it has no `offline` kind of its own and
 * reports a lost network the way they do, as a `crash` carrying the CLI's network error text.
 */
function cloudLike(mode: 'net-down' | 'net-drop-after-text') {
  const calls: string[] = [];
  const adapter: ProviderAdapter = {
    id: 'acp:cloudlike',
    displayName: 'Cloud CLI',
    detect: async () => ({ installed: true, signedIn: true }),
    capabilities: () => ({
      resume: true,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: false,
      contextReport: false,
    }),
    listModels: async () => [{ id: 'big' }],
    async *runTurn(input) {
      calls.push(input.runId);
      if (mode === 'net-drop-after-text') yield { type: 'text.delta', text: 'Working on it' };
      yield {
        type: 'error',
        kind: 'crash',
        message: 'API Error: Unable to connect to API (getaddrinfo ENOTFOUND api.example.invalid)',
      };
      yield { type: 'done', stop: 'error' };
    },
  };
  const mod = defineModule({
    id: 'w34cloudlike',
    register(app) {
      app.providers.register(adapter);
    },
  });
  return { calls, mod };
}

describe('offline fallback when the primary is a cloud CLI that lost the network', () => {
  async function setup(mode: 'net-down' | 'net-drop-after-text') {
    const local = await ollamaStub();
    stubs.push(local);
    const cloud = cloudLike(mode);
    const { owner, api: call } = await boot([], [cloud.mod]);
    const fallback = await addEndpoint(call, 'Ollama', 'ollama', local.url);
    const agent = seedAgent(s!.db, { providerId: 'acp:cloudlike', trust: 'trusted' });
    setModel(agent, 'acp:cloudlike', 'big');
    seedChat(s!.db, { userIds: [owner.id], agentIds: [agent] });
    const put = await call('PUT', `/api/m/provider-ops/agents/${agent}`, {
      fallback: [{ providerId: fallback.providerId, model: 'chatty:latest' }],
      accountId: null,
      compactPct: null,
      compactTokens: null,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    return { call, agent, fallback, cloud };
  }
  async function fire(call: ReturnType<typeof api>, agent: string, runEvenOffline: boolean) {
    const r = await call('POST', '/api/m/routines/routines', {
      agentId: agent,
      name: 'Morning check',
      prompt: 'Check things.',
      trigger: { kind: 'manual', spec: {} },
      runEvenOffline,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await call('POST', `/api/m/routines/routines/${r.json.routine.id}/run`)).status).toBe(202);
    return r.json.routine.id as string;
  }
  const runsOf = (agent: string) =>
    s!.db
      .prepare('SELECT provider_id, state FROM runs WHERE agent_id = ? ORDER BY started_at')
      .all(agent) as { provider_id: string; state: string }[];

  it('a "run even offline" routine falls back to the local model when the cloud CLI cannot reach its API', async () => {
    const { call, agent, fallback } = await setup('net-down');
    const id = await fire(call, agent, true);
    const done = await until(
      () =>
        s!.db.prepare("SELECT * FROM routines_fire WHERE routine_id = ? AND result != 'pending'").get(id) as
          | any
          | undefined,
    );
    expect(done.result).toBe('ok');
    expect(done.note).toBe('primary offline: ran on Ollama · chatty:latest');
    expect(runsOf(agent)).toEqual([
      { provider_id: 'acp:cloudlike', state: 'failed' },
      { provider_id: fallback.providerId, state: 'done' },
    ]);
  });

  it('an unmarked item on a cloud CLI without network is held, not failed', async () => {
    const { call, agent } = await setup('net-down');
    await fire(call, agent, false);
    const held = await until(
      () =>
        s!.db.prepare("SELECT resume_at FROM queue_items WHERE agent_id = ? AND state = 'held'").get(agent) as
          | { resume_at: number }
          | undefined,
    );
    expect(held.resume_at).toBeGreaterThan(Date.now());
    expect(runsOf(agent)).toHaveLength(1);
  });

  it('a network error after the turn already wrote text is a crash: no rerun on the fallback, no hold', async () => {
    const { call, agent, cloud } = await setup('net-drop-after-text');
    const id = await fire(call, agent, true);
    const done = await until(
      () =>
        s!.db.prepare("SELECT * FROM routines_fire WHERE routine_id = ? AND result != 'pending'").get(id) as
          | any
          | undefined,
    );
    expect(done.result).not.toBe('ok');
    await new Promise((r) => setTimeout(r, 100));
    expect(runsOf(agent)).toEqual([{ provider_id: 'acp:cloudlike', state: 'failed' }]);
    expect(cloud.calls).toHaveLength(1);
    expect(
      s!.db.prepare("SELECT 1 FROM queue_items WHERE agent_id = ? AND state = 'held'").get(agent),
    ).toBeFalsy();
  });
});

describe.runIf(process.env.PASABOT_LIVE === 'ollama')('live: a real Ollama on 127.0.0.1:11434', () => {
  it('one real turn', async () => {
    const a = new LocalModelAdapter({
      id: 'live',
      name: 'Ollama',
      api: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      origin: 'http://127.0.0.1:11434',
      scope: 'loopback',
      tools: 'auto',
    });
    const models = await a.models();
    expect(models.length).toBeGreaterThan(0);
    const ev = await turn(a, 'Reply with the single word: pong', { model: models[0]!.id });
    expect(ev.find((e) => e.type === 'text.final')).toBeTruthy();
    expect(ev.at(-1)).toEqual({ type: 'done', stop: 'end' });
  }, 120_000);
});
