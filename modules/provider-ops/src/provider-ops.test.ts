/**
 * W3 done-criteria through a booted server (real orchestrator, queue and dispatcher; scripted Fake brains):
 * rate limit → fallback with a switch notice and a reseed, the primary retried after the reset; no fallback → held
 * then resumed; context 90 % → reseed and the next turn starts a new native session; two empty compactions → stop +
 * notify; usage totals per agent; switching the agent's provider keeps the chat; per-agent accounts reach the CLI.
 */
import { rmSync } from 'node:fs';
import type { ProviderAdapter, TurnInput } from '@pasabot/core';
import { FakeProvider, type Script } from '@pasabot/provider-fake';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { createProviderOpsModule } from './server.js';

let s: TestServer | null = null;
afterEach(async () => {
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

/** A Fake brain under another provider id, recording every turn's input. */
function scripted(id: string, script: (input: TurnInput, n: number) => Script, nativeCompaction = false) {
  const inputs: TurnInput[] = [];
  const inner = new FakeProvider({ script: (i) => script(i, inputs.length - 1), deltaMs: 1 });
  const a: ProviderAdapter & { inputs: TurnInput[] } = {
    id: id as ProviderAdapter['id'],
    displayName: id,
    inputs,
    detect: () => inner.detect(),
    capabilities: () => ({ ...inner.capabilities(), nativeCompaction }),
    runTurn(input, signal) {
      inputs.push(input);
      return inner.runTurn(input, signal);
    },
  };
  return a;
}
const reply = (text: string, usage?: { used: number; window: number }, ref?: string): Script => [
  { event: { type: 'session', nativeRef: ref ?? `s-${Math.random().toString(36).slice(2, 8)}` } },
  { event: { type: 'text.final', text } },
  {
    event: {
      type: 'usage',
      inputTokens: 100,
      outputTokens: 10,
      ...(usage ? { contextUsed: usage.used, contextWindow: usage.window } : {}),
    },
  },
  { event: { type: 'done', stop: 'end' } },
];
const limited = (retryAfterMs?: number): Script => [
  { event: { type: 'session', nativeRef: 'primary-1' } },
  {
    event: {
      type: 'error',
      kind: 'rate_limit',
      message: 'usage limit reached',
      ...(retryAfterMs ? { retryAfterMs } : {}),
    },
  },
  { event: { type: 'done', stop: 'error' } },
];

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
const finals = (chatId: string) =>
  s!.db
    .prepare(
      "SELECT author_kind, body, blocks FROM messages WHERE chat_id = ? AND status = 'final' ORDER BY created_at, id",
    )
    .all(chatId) as { author_kind: string; body: string; blocks: string }[];
const runs = (agentId: string) =>
  s!.db
    .prepare('SELECT provider_id, state FROM runs WHERE agent_id = ? ORDER BY started_at, id')
    .all(agentId) as {
    provider_id: string;
    state: string;
  }[];
const notices = (chatId: string) =>
  finals(chatId)
    .filter((m) => m.author_kind === 'system')
    .flatMap((m) => JSON.parse(m.blocks) as { kind: string; data: { kind: string } }[])
    .filter((b) => b.kind === 'provider-ops.notice')
    .map((b) => b.data);

describe('provider-ops', () => {
  it('rate limit → fallback with a notice and a reseed; primary retried after the reset', async () => {
    let now = Date.now();
    let primaryLimited = true;
    const primary = scripted('acp:primary', (i) =>
      i.user.text === 'go' && primaryLimited ? limited(60_000) : reply(`primary: ${i.user.text}`),
    );
    const backup = scripted('acp:backup', (i) => reply(`backup: ${i.user.text}`));
    const mod = createProviderOpsModule({ now: () => now, checkMs: 0 });
    s = await bootTestServer({ modules: [mod], providers: [primary, backup] });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:primary' });
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const call = api(owner.token);
    expect(
      (
        await call('PUT', `/api/m/provider-ops/agents/${agent}`, {
          fallback: [{ providerId: 'acp:backup' }],
          accountId: null,
          compactPct: null,
          compactTokens: null,
        })
      ).status,
    ).toBe(200);
    // an unknown provider in the chain is refused
    expect(
      (
        await call('PUT', `/api/m/provider-ops/agents/${agent}`, {
          fallback: [{ providerId: 'nope' }],
          accountId: null,
          compactPct: null,
          compactTokens: null,
        })
      ).status,
    ).toBe(400);

    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'hello' });
    await until(() => finals(chat).some((m) => m.body === 'primary: hello'));
    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'go' });
    await until(() => finals(chat).some((m) => m.body === 'backup: go'));
    expect(runs(agent).map((r) => `${r.provider_id}:${r.state}`)).toEqual([
      'acp:primary:done',
      'acp:primary:failed',
      'acp:backup:done',
    ]);
    // switch notice in the chat
    expect(notices(chat)).toContainEqual(
      expect.objectContaining({
        kind: 'switched',
        reason: 'rate_limit',
        from: 'acp:primary',
        to: 'acp:backup',
      }),
    );
    // the backup's new session is reseeded with our transcript (not the turn's own text again)
    const seed = backup.inputs[0]!.seed!;
    expect(seed.recent.map((m) => m.body)).toEqual(['hello', 'primary: hello']);
    expect(backup.inputs[0]!.nativeRef).toBeUndefined();
    // the limit is remembered: the next message goes straight to the fallback
    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'again' });
    await until(() => finals(chat).some((m) => m.body === 'backup: again'));
    expect((await call('GET', '/api/m/provider-ops/usage')).json.limits).toEqual([
      expect.objectContaining({ providerId: 'acp:primary', reason: 'rate_limit' }),
    ]);
    // the reset passes; the usage check clears it and the primary is retried (with a "back on" notice)
    primaryLimited = false;
    now += 61_000;
    expect((await call('POST', '/api/m/provider-ops/check')).json.cleared).toBe(1);
    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'go' });
    await until(() => finals(chat).some((m) => m.body === 'primary: go'));
    expect(notices(chat)).toContainEqual(expect.objectContaining({ kind: 'back', to: 'acp:primary' }));
    // the primary's old session missed the backup's turns: it is never resumed; a new one is reseeded with them
    const back = primary.inputs.at(-1)!;
    expect(back.nativeRef).toBeUndefined();
    expect(back.seed?.recent.map((m) => m.body)).toEqual(
      expect.arrayContaining(['backup: go', 'again', 'backup: again']),
    );
    const open = s.db
      .prepare(
        'SELECT provider_id FROM provider_sessions WHERE agent_id = ? AND ended_at IS NULL ORDER BY started_at',
      )
      .all(agent) as { provider_id: string }[];
    expect(open.map((r) => r.provider_id)).toEqual(['acp:primary']);
  });

  it('a session of one account is never resumed on another account of the same provider', async () => {
    let failA = true;
    const brain = scripted('acp:multi', (i) =>
      failA && !i.account ? limited(60_000) : reply(`${i.account?.label ?? 'default'}: ${i.user.text}`),
    );
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 0 })],
      providers: [brain],
    });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:multi' });
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const call = api(owner.token);
    const acct = (await call('POST', '/api/m/provider-ops/accounts', { providerId: 'acp:multi', label: 'B' }))
      .json.id;
    failA = false;
    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'one' });
    await until(() => finals(chat).some((m) => m.body === 'default: one'));
    await call('PUT', `/api/m/provider-ops/agents/${agent}`, {
      fallback: [{ providerId: 'acp:multi', accountId: acct }],
      accountId: null,
      compactPct: null,
      compactTokens: null,
    });
    failA = true;
    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'two' });
    await until(() => finals(chat).some((m) => m.body === 'B: two'));
    const retry = brain.inputs.at(-1)!;
    expect(retry.account?.id).toBe(acct);
    // account B never saw the default account's session id: it starts fresh, reseeded
    expect(retry.nativeRef).toBeUndefined();
    expect(retry.seed?.recent.map((m) => m.body)).toEqual(['one', 'default: one']);
  });

  it('no fallback: the item is held until the reset, then resumes', async () => {
    let calls = 0;
    const flaky = scripted('acp:flaky', (i) => (calls++ === 0 ? limited(400) : reply(`ok: ${i.user.text}`)));
    s = await bootTestServer({ modules: [createProviderOpsModule({ checkMs: 0 })], providers: [flaky] });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:flaky' });
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    await api(owner.token)('POST', `/api/v1/chats/${chat}/messages`, { text: 'later' });
    const held = await until(
      () =>
        s!.db
          .prepare("SELECT state, resume_at FROM queue_items WHERE agent_id = ? AND state = 'held'")
          .get(agent) as { state: string; resume_at: number } | undefined,
    );
    expect(held.resume_at).toBeGreaterThan(Date.now() - 50);
    await until(() => finals(chat).some((m) => m.body === 'ok: later'));
    expect(
      (s.db.prepare('SELECT state FROM queue_items WHERE agent_id = ?').get(agent) as { state: string })
        .state,
    ).toBe('done');
  });

  it('a limit with no reset time and no fallback is held until the next usage check, never failed', async () => {
    let calls = 0;
    const brain = scripted('acp:noreset', (i) => (calls++ === 0 ? limited() : reply(`ok: ${i.user.text}`)));
    const now = Date.now();
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 60_000 })],
      providers: [brain],
    });
    const notes: string[] = [];
    s.bus.subscribe((ev) => {
      if (ev.type === 'notification') notes.push((ev.data as { text: string }).text);
    });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:noreset' });
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    await api(owner.token)('POST', `/api/v1/chats/${chat}/messages`, { text: 'later' });
    const held = await until(
      () =>
        s!.db.prepare("SELECT resume_at FROM queue_items WHERE agent_id = ? AND state = 'held'").get(agent) as
          | { resume_at: number }
          | undefined,
    );
    // the policy's own limit (the usage check, 60 s here) decides when it runs again
    expect(held.resume_at).toBeGreaterThanOrEqual(now + 60_000);
    expect(held.resume_at).toBeLessThan(now + 120_000);
    expect(notes.some((t) => t.includes('run failed'))).toBe(false);
  });

  it('a fallback that is limited too holds the item instead of failing it', async () => {
    const primary = scripted('acp:p1', () => limited(60_000));
    const backup = scripted('acp:p2', () => limited());
    s = await bootTestServer({
      modules: [createProviderOpsModule({ checkMs: 60_000 })],
      providers: [primary, backup],
    });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:p1' });
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const call = api(owner.token);
    await call('PUT', `/api/m/provider-ops/agents/${agent}`, {
      fallback: [{ providerId: 'acp:p2' }],
      accountId: null,
      compactPct: null,
      compactTokens: null,
    });
    await call('POST', `/api/v1/chats/${chat}/messages`, { text: 'hi' });
    const held = await until(
      () =>
        s!.db.prepare("SELECT resume_at FROM queue_items WHERE agent_id = ? AND state = 'held'").get(agent) as
          | { resume_at: number }
          | undefined,
    );
    expect(held.resume_at).toBeGreaterThan(Date.now() + 30_000);
    expect(backup.inputs).toHaveLength(1);
    // both ends of the chain are booked as limited
    expect(
      (await call('GET', '/api/m/provider-ops/usage')).json.limits.map(
        (l: { providerId: string }) => l.providerId,
      ),
    ).toEqual(expect.arrayContaining(['acp:p1', 'acp:p2']));
  });

  it("a compaction is measured in its own chat: another chat's turns never stop it", async () => {
    // chat A compacts at 90 %; chat B runs long at 88 % and 87 %: under per-agent bookkeeping those turns would
    // count as two empty compactions of A and stop compaction for the agent everywhere
    const usedBy: Record<string, number[]> = { A: [90_000, 20_000], B: [88_000, 87_000] };
    const brain = scripted('acp:two', (i) => {
      const [chatName] = i.user.text.split(':');
      const u = usedBy[chatName!]!.shift() ?? 10_000;
      return reply(`${i.user.text} done`, { used: u, window: 100_000 });
    });
    s = await bootTestServer({ modules: [createProviderOpsModule({ checkMs: 0 })], providers: [brain] });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:two' });
    const a = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const b = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const call = api(owner.token);
    for (const [chat, text] of [
      [a, 'A:1'],
      [b, 'B:1'],
      [b, 'B:2'],
      [a, 'A:2'],
    ] as const) {
      await call('POST', `/api/v1/chats/${chat}/messages`, { text });
      await until(() => finals(chat).some((m) => m.body === `${text} done`));
    }
    expect([...notices(a), ...notices(b)].some((n) => n.kind === 'stopped')).toBe(false);
    expect((await call('GET', '/api/m/provider-ops/settings')).json.agents[0].compactionStopped).toBeNull();
    // B's own first compaction was measured on B's next turn (one empty), not on anything in A
    expect((await call('GET', '/api/m/provider-ops/settings')).json.agents[0].noGain).toBe(1);
  });

  it('context 90 % → reseed and a new native session; two empty compactions stop and notify', async () => {
    const used = [90_000, 88_000, 87_000, 86_000];
    const brain = scripted('acp:ctx', (i, n) =>
      reply(`turn ${n + 1}`, { used: used[n] ?? 10_000, window: 100_000 }, i.nativeRef ?? `ctx-${n + 1}`),
    );
    s = await bootTestServer({ modules: [createProviderOpsModule({ checkMs: 0 })], providers: [brain] });
    const notes: string[] = [];
    s.bus.subscribe((ev) => {
      if (ev.type === 'notification') notes.push((ev.data as { text: string }).text);
    });
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { providerId: 'acp:ctx' });
    const chat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const call = api(owner.token);
    for (let n = 1; n <= 4; n++) {
      await call('POST', `/api/v1/chats/${chat}/messages`, { text: `m${n}` });
      await until(() => finals(chat).some((m) => m.body === `turn ${n}`));
    }
    const [t1, t2, t3, t4] = brain.inputs;
    expect(t1!.nativeRef).toBeUndefined();
    // turn 1 hit 90 % ≥ 80 %: its session was ended; turn 2 starts a new one, reseeded
    expect(t2!.nativeRef).toBeUndefined();
    expect(t2!.seed?.recent.map((m) => m.body)).toContain('turn 1');
    // turn 2 freed only 2 %: compacted again (one empty); turn 3 freed 1 %: two empty → stop + notify
    expect(t3!.nativeRef).toBeUndefined();
    expect(t4!.nativeRef).toBe('ctx-3');
    expect(notices(chat).filter((n) => n.kind === 'compacted')).toHaveLength(2);
    expect(notices(chat)).toContainEqual(expect.objectContaining({ kind: 'stopped' }));
    expect(notes.some((t) => t.includes('compaction stopped'))).toBe(true);
    const settings = (await call('GET', '/api/m/provider-ops/settings')).json.agents[0];
    expect(settings.compactionStopped).toBeTruthy();
    // the owner resumes compaction
    await call('POST', `/api/m/provider-ops/agents/${agent}/compaction/resume`);
    expect((await call('GET', '/api/m/provider-ops/settings')).json.agents[0].compactionStopped).toBeNull();
    // the gauge reads the chat's latest context use
    const ctx = (await call('GET', `/api/m/provider-ops/chats/${chat}/context`)).json.context;
    expect(ctx).toMatchObject({ agentId: agent, used: 86_000, window: 100_000, pct: 86 });
  });

  it('usage totals per agent (owner only), gauge needs chat access, accounts reach the CLI, switch keeps the chat', async () => {
    const a = scripted('acp:a', (i) => reply(`a: ${i.user.text}`, { used: 1000, window: 100_000 }));
    const b = scripted('acp:b', (i) => reply(`b: ${i.user.text}`, { used: 1000, window: 100_000 }));
    s = await bootTestServer({ modules: [createProviderOpsModule({ checkMs: 0 })], providers: [a, b] });
    const owner = seedUser(s.db);
    const member = seedUser(s.db, 'member', 'M');
    const one = seedAgent(s.db, { providerId: 'acp:a', slug: 'tala' });
    const two = seedAgent(s.db, { providerId: 'acp:a', slug: 'ligaya' });
    const c1 = seedChat(s.db, { userIds: [owner.id], agentIds: [one] });
    const c2 = seedChat(s.db, { userIds: [owner.id], agentIds: [two] });
    const call = api(owner.token);
    // a second account for provider a, used by agent one
    const acct = (await call('POST', '/api/m/provider-ops/accounts', { providerId: 'acp:a', label: 'Work' }))
      .json.id;
    expect(
      (
        await call('PUT', `/api/m/provider-ops/agents/${one}`, {
          fallback: [],
          accountId: acct,
          compactPct: 95,
          compactTokens: null,
        })
      ).status,
    ).toBe(200);
    // an account of another provider is refused
    expect(
      (
        await call('PUT', `/api/m/provider-ops/agents/${two}`, {
          fallback: [{ providerId: 'acp:b', accountId: acct }],
          accountId: null,
          compactPct: null,
          compactTokens: null,
        })
      ).status,
    ).toBe(400);
    for (const t of ['x', 'y']) {
      await call('POST', `/api/v1/chats/${c1}/messages`, { text: t });
      await until(() => finals(c1).some((m) => m.body === `a: ${t}`));
    }
    await call('POST', `/api/v1/chats/${c2}/messages`, { text: 'z' });
    await until(() => finals(c2).some((m) => m.body === 'a: z'));
    expect(a.inputs[0]!.account?.label).toBe('Work');
    // the account's config dir is outside $PASABOT_HOME, which the runner sandbox hides from every CLI
    const dir = a.inputs[0]!.account!.configDir!;
    expect(dir.startsWith(`${s.home}/`)).toBe(false);
    expect(dir.startsWith(`${s.home}-accounts/`)).toBe(true);
    expect(a.inputs[2]!.account).toBeUndefined();
    // the owner sees where to sign in, and whether the CLI is signed in there
    const listed = (await call('GET', '/api/m/provider-ops/settings')).json.accounts[0];
    expect(listed).toMatchObject({ id: acct, configDir: dir, signIn: null });
    expect((await call('GET', `/api/m/provider-ops/accounts/${acct}/status`)).json.status).toMatchObject({
      installed: true,
    });

    await until(
      () => (s!.db.prepare('SELECT count(*) AS n FROM provider_ops_usage').get() as { n: number }).n === 3,
    );
    const u = (await call('GET', '/api/m/provider-ops/usage')).json;
    expect(u.agents).toEqual([
      expect.objectContaining({ agentId: one, name: 'tala', runs: 2, input: 200, output: 20 }),
      expect.objectContaining({ agentId: two, name: 'ligaya', runs: 1, input: 100, output: 10 }),
    ]);
    expect(u.providers).toEqual([expect.objectContaining({ providerId: 'acp:a', runs: 3 })]);
    const m = api(member.token);
    expect((await m('GET', '/api/m/provider-ops/usage')).status).toBe(403);
    expect((await m('GET', `/api/m/provider-ops/chats/${c1}/context`)).status).toBe(404);
    expect((await call('GET', `/api/m/provider-ops/chats/${c1}/context`)).json.context.pct).toBe(1);

    // switch agent two to provider b through the core agent route: the chat continues, reseeded
    expect((await call('PATCH', `/api/v1/agents/${two}`, { providerId: 'acp:b' })).status).toBe(200);
    await call('POST', `/api/v1/chats/${c2}/messages`, { text: 'after switch' });
    await until(() => finals(c2).some((m) => m.body === 'b: after switch'));
    expect(b.inputs[0]!.seed?.recent.map((x) => x.body)).toEqual(['z', 'a: z']);
  });
});
