/**
 * Wave 5 cross-feature proof (W22 free starter + routines; lives here because a module may not import another
 * module, and this package already wires routines for W34's offline fallback): a routine on the rate-limited free
 * model records `skipped: rate limited`, is reported once per busy window, never stacks as pending or held, and the
 * next fire after the reset runs. Port 0 on 127.0.0.1, a temp home, a Fake brain as OpenCode, a stub installer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, TurnInput } from '@pasabot/core';
import { createProviderOpsModule } from '@pasabot/mod-provider-ops/server';
import { createRoutinesModule } from '@pasabot/mod-routines/server';
import { createTemplatesModule } from '@pasabot/mod-templates/server';
import { FakeProvider, type Script } from '@pasabot/provider-fake';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const tmp = mkdtempSync(join(tmpdir(), 'pasabot-free-routines-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let s: TestServer | null = null;
afterEach(async () => {
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
function api(token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s!.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
}
const reply = (text: string): Script => [
  { event: { type: 'session', nativeRef: `s-${Math.random().toString(36).slice(2, 8)}` } },
  { event: { type: 'text.final', text } },
  { event: { type: 'done', stop: 'end' } },
];
const limited: Script = [
  { event: { type: 'error', kind: 'rate_limit', message: '429 Too Many Requests' } },
  { event: { type: 'done', stop: 'error' } },
];
function fakeOpenCode(script: () => Script, id = 'opencode', displayName = 'OpenCode (fake)') {
  const inner = new FakeProvider({ script: () => script(), deltaMs: 1 });
  const a: ProviderAdapter & { inputs: TurnInput[] } = {
    id: id as ProviderAdapter['id'],
    displayName,
    inputs: [],
    detect: async () => ({ installed: true, version: '0.0.0-fake', signedIn: 'unknown' }),
    capabilities: () => inner.capabilities(),
    runTurn(input, signal) {
      a.inputs.push(input);
      return inner.runTurn(input, signal);
    },
  };
  return a;
}
/** a stub installer: never downloads, writes a placeholder binary into the temp dir */
const stubInstaller = (_app: unknown, binDir: string) => ({
  describe: () => ({
    what: 'OpenCode CLI',
    where: join(binDir, 'opencode'),
    from: 'https://example.invalid/r',
  }),
  async install({ consent }: { consent: boolean }) {
    if (!consent) throw new Error('no consent');
    const bin = join(tmp, `opencode-${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { binPath: bin, version: 'v0.0.0-stub' };
  },
});
const notifications = () =>
  (s!.db.prepare("SELECT data FROM events WHERE type = 'notification'").all() as { data: string }[]).map(
    (x) => String(JSON.parse(x.data).text ?? ''),
  );

describe('free-model routines skip and report (never stack, never "Running" while held)', () => {
  it('a fire that hits the limit records "skipped: rate limited", reports once, and the next fire runs', async () => {
    let clock = Date.now();
    let mode: 'limited' | 'ok' = 'limited';
    const brain = fakeOpenCode(() => (mode === 'limited' ? limited : reply('done')));
    s = await bootTestServer({
      providers: [new FakeProvider()],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-r'),
          installer: stubInstaller,
          makeOpenCode: () => brain,
          now: () => clock,
        }),
        createRoutinesModule(),
      ],
    });
    const call = api(seedUser(s.db).token);
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const model = 'opencode/big-pickle';
    const a = await call('POST', '/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    await call('POST', '/api/m/templates/starter/agents', { agentId: a.json.agent.id, model });
    const r = await call('POST', '/api/m/routines/routines', {
      agentId: a.json.agent.id,
      name: 'Morning check',
      prompt: 'Check things.',
      trigger: { kind: 'manual', spec: {} },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.routine.id as string;
    const fires = () =>
      s!.db
        .prepare('SELECT result, error, note FROM routines_fire WHERE routine_id = ? ORDER BY at, id')
        .all(id) as {
        result: string;
        error: string | null;
        note: string | null;
      }[];
    // 1) the first fire reaches the model, gets the 429 and is skipped (the core's hold is released and refused)
    expect((await call('POST', `/api/m/routines/routines/${id}/run`)).status).toBe(202);
    await until(() => fires()[0]?.result === 'skipped');
    expect(fires()[0]!.error).toMatch(/^rate limited: The free model is busy or out of quota, try again at /);
    expect(fires()[0]!.note).toBeNull();
    // 2) two more fires while the free model is closed never reach it and never stack
    for (let i = 0; i < 2; i++) {
      expect((await call('POST', `/api/m/routines/routines/${id}/run`)).status).toBe(202);
      await until(() => fires().length === i + 2 && fires()[i + 1]!.result === 'skipped');
    }
    expect(brain.inputs).toHaveLength(1);
    const open = s.db
      .prepare(
        "SELECT count(*) AS n FROM queue_items WHERE agent_id = ? AND state IN ('queued', 'held', 'running')",
      )
      .get(a.json.agent.id) as { n: number };
    expect(open.n).toBe(0);
    expect(fires().filter((f) => f.result === 'pending')).toEqual([]);
    // the Activity feed reads skipped (never pending, which the page shows as "Running")
    const act = await call('GET', '/api/m/routines/activity?limit=10');
    expect(act.json.fires.map((f: { result: string }) => f.result)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    // reported once for the whole busy window
    expect(notifications().filter((t) => t.includes('A routine was skipped'))).toHaveLength(1);
    // 3) after the reset the next fire runs as usual
    clock += 16 * 60_000;
    mode = 'ok';
    expect((await call('POST', `/api/m/routines/routines/${id}/run`)).status).toBe(202);
    await until(() => fires().length === 4 && fires()[3]!.result !== 'pending');
    expect(fires()[3]!.result).toBe('ok');
    expect(brain.inputs).toHaveLength(2);
  }, 30_000);

  it('a routine on another brain is never refused by the free-model gate', async () => {
    const brain = fakeOpenCode(() => limited);
    s = await bootTestServer({
      providers: [new FakeProvider({ deltaMs: 1 })],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-o'),
          installer: stubInstaller,
          makeOpenCode: () => brain,
        }),
        createRoutinesModule(),
      ],
    });
    const call = api(seedUser(s.db).token);
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const free = await call('POST', '/api/v1/agents', {
      name: 'Free',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });
    await call('POST', `/api/v1/chats/${free.json.chatId}/messages`, { text: 'close the gate' });
    await until(
      () => (s!.db.prepare("SELECT 1 FROM queue_items WHERE state = 'held'").get() as unknown) ?? false,
    );
    expect((await call('GET', '/api/m/templates/starter')).json.busyUntil).toBeGreaterThan(Date.now());
    const other = await call('POST', '/api/v1/agents', { name: 'Other', providerId: 'fake' });
    const r = await call('POST', '/api/m/routines/routines', {
      agentId: other.json.agent.id,
      name: 'Other check',
      prompt: 'Hi.',
      trigger: { kind: 'manual', spec: {} },
    });
    await call('POST', `/api/m/routines/routines/${r.json.routine.id}/run`);
    const f = await until(
      () =>
        s!.db
          .prepare("SELECT result FROM routines_fire WHERE routine_id = ? AND result != 'pending'")
          .get(r.json.routine.id) as { result: string } | undefined,
    );
    expect(f.result).toBe('ok');
  }, 30_000);
});

describe('the free-model gate asks the provider policy (fallback chains, configured brains)', () => {
  const setFallback = async (call: ReturnType<typeof api>, agentId: string, fallback: unknown[]) => {
    const put = await call('PUT', `/api/m/provider-ops/agents/${agentId}`, {
      fallback,
      accountId: null,
      compactPct: null,
      compactTokens: null,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
  };
  const runRoutine = async (call: ReturnType<typeof api>, agentId: string) => {
    const r = await call('POST', '/api/m/routines/routines', {
      agentId,
      name: 'Morning check',
      prompt: 'Check things.',
      trigger: { kind: 'manual', spec: {} },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await call('POST', `/api/m/routines/routines/${r.json.routine.id}/run`)).status).toBe(202);
    return until(
      () =>
        s!.db
          .prepare("SELECT result, error FROM routines_fire WHERE routine_id = ? AND result != 'pending'")
          .get(r.json.routine.id) as { result: string; error: string | null } | undefined,
    );
  };
  const closeGate = async (call: ReturnType<typeof api>, chatId: string) => {
    await call('POST', `/api/v1/chats/${chatId}/messages`, { text: 'close the gate' });
    await until(
      () => (s!.db.prepare("SELECT 1 FROM queue_items WHERE state = 'held'").get() as unknown) ?? false,
    );
    expect((await call('GET', '/api/m/templates/starter')).json.busyUntil).toBeGreaterThan(Date.now());
  };

  it('a free-model agent with a usable fallback still runs its routine while the free model is limited', async () => {
    const brain = fakeOpenCode(() => limited);
    s = await bootTestServer({
      providers: [new FakeProvider({ deltaMs: 1 })],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-f'),
          installer: stubInstaller,
          makeOpenCode: () => brain,
        }),
        createProviderOpsModule({ checkMs: 60_000 }),
        createRoutinesModule(),
      ],
    });
    const call = api(seedUser(s.db).token);
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const model = 'opencode/big-pickle';
    // agent A: the free model first, a fallback brain behind it
    const a = await call('POST', '/api/v1/agents', { name: 'Bida', providerId: 'opencode', model });
    await setFallback(call, a.json.agent.id, [{ providerId: 'fake' }]);
    // another free-model agent with no fallback gets the 429: the free gate closes, and its turn is held
    const lone = await call('POST', '/api/v1/agents', { name: 'Lone', providerId: 'opencode', model });
    await closeGate(call, lone.json.chatId);
    const before = brain.inputs.length;
    const f = await runRoutine(call, a.json.agent.id);
    expect(f.error).toBeNull();
    expect(f.result).toBe('ok');
    expect(brain.inputs).toHaveLength(before);
  }, 30_000);

  it('an agent whose paid primary once fell back to the free model is judged by its primary, not its last run', async () => {
    let clock = Date.now();
    let freeMode: 'ok' | 'limited' = 'ok';
    let paidMode: 'ok' | 'limited' = 'limited';
    const brain = fakeOpenCode(() => (freeMode === 'limited' ? limited : reply('free answer')));
    const paid = fakeOpenCode(
      () =>
        paidMode === 'limited'
          ? [
              { event: { type: 'error', kind: 'rate_limit', message: 'usage limit', retryAfterMs: 60_000 } },
              { event: { type: 'done', stop: 'error' } },
            ]
          : reply('paid answer'),
      'acp:paid',
      'Paid brain (fake)',
    );
    s = await bootTestServer({
      providers: [new FakeProvider({ deltaMs: 1 }), paid],
      modules: [
        createTemplatesModule({
          binDir: join(tmp, 'bin-p'),
          installer: stubInstaller,
          makeOpenCode: () => brain,
          now: () => clock,
        }),
        createProviderOpsModule({ checkMs: 60_000, now: () => clock }),
        createRoutinesModule(),
      ],
    });
    const call = api(seedUser(s.db).token);
    await call('POST', '/api/m/templates/starter/install', { consent: true });
    const model = 'opencode/big-pickle';
    // agent B: a paid primary with the free model as its fallback
    const b = await call('POST', '/api/v1/agents', { name: 'Bayani', providerId: 'acp:paid' });
    await setFallback(call, b.json.agent.id, [{ providerId: 'opencode', model }]);
    // the paid brain hits its usage limit, so this one turn runs on the free fallback
    await call('POST', `/api/v1/chats/${b.json.chatId}/messages`, { text: 'hello' });
    await until(() => brain.inputs.length === 1);
    await until(
      () =>
        (s!.db
          .prepare("SELECT 1 FROM queue_items WHERE agent_id = ? AND state = 'done'")
          .get(b.json.agent.id) as unknown | undefined) ?? false,
    );
    // the paid limit resets; then the free model is limited by another agent's turn
    clock += 2 * 60_000;
    paidMode = 'ok';
    freeMode = 'limited';
    const lone = await call('POST', '/api/v1/agents', { name: 'Lone', providerId: 'opencode', model });
    await call('POST', `/api/v1/chats/${lone.json.chatId}/messages`, { text: 'close the gate' });
    await until(
      () => (s!.db.prepare("SELECT 1 FROM queue_items WHERE state = 'held'").get() as unknown) ?? false,
    );
    expect((await call('GET', '/api/m/templates/starter')).json.busyUntil).toBeGreaterThan(clock);
    // B's routine runs on its healthy primary: never refused as "on the free model"
    const f = await runRoutine(call, b.json.agent.id);
    expect(f.error).toBeNull();
    expect(f.result).toBe('ok');
    expect(paid.inputs.at(-1)?.user.text).toContain('Check things.');
  }, 30_000);
});
