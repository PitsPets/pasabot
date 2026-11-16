/**
 * W32 budgets through a booted server (real orchestrator, queue, dispatcher; scripted Fake brain): usage of two agents
 * and two models rolls up; a model without a price is "price not set" and adds no number; an agent at its daily cap
 * is stopped mid-task with the clean message and a raise/keep card, its next message waits, and only the owner can
 * raise; the global cap does the same for every agent; a routine fire at the cap is refused before it runs.
 */
import type { PasaBotModule, ProviderEvent, QueueService } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  FakeProvider,
  seedAgent,
  seedChat,
  seedRunToken,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { CodexMapper } from '../../../providers/codex/src/index.js';
import { createBudgetModule } from './server.js';

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
const api = (token: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${s!.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
/** a turn that reports `input` tokens and ends at once */
const quick = (input: number, output = 0, cache = 0) =>
  JSON.stringify({
    fakeScript: [
      { event: { type: 'text.final', text: 'done' } },
      { event: { type: 'usage', inputTokens: input, outputTokens: output, cacheTokens: cache } },
      { event: { type: 'done', stop: 'end' } },
    ],
  });
/** a long task that reports its usage half way, then keeps working for 5 s */
const longTask = (input: number) =>
  JSON.stringify({
    fakeScript: [
      { event: { type: 'text.delta', text: 'Working on part one' } },
      { event: { type: 'usage', inputTokens: input, outputTokens: 0 } },
      { after: 5000, event: { type: 'text.delta', text: ' and part two' } },
      { event: { type: 'text.final', text: 'Working on part one and part two' } },
      { event: { type: 'done', stop: 'end' } },
    ],
  });

let capturedQueue: QueueService | null = null;
/** who started each stand-in workflow run (the workflows module is not booted here) */
const flowRuns = new Map<string, string>();
const capture: PasaBotModule = {
  id: 'capturetest',
  register(app) {
    capturedQueue = app.queue;
    flowRuns.clear();
    app.flows.set({
      list: () => [],
      start: async () => {
        throw new Error('not in this test');
      },
      runState: (id) =>
        flowRuns.has(id) ? { state: 'running', error: null, startedBy: flowRuns.get(id)! } : null,
    });
  },
};
/** a Fake script made of what the real Codex adapter's line mapper emits for these JSONL lines */
const viaCodex = (lines: { after?: number; line: Record<string, unknown> }[]) => {
  const m = new CodexMapper();
  const script: { after?: number; event: ProviderEvent }[] = [];
  for (const l of lines)
    for (const [i, event] of m.map(l.line).entries())
      script.push({ ...(i === 0 && l.after ? { after: l.after } : {}), event });
  return JSON.stringify({ fakeScript: [...script, { event: { type: 'done', stop: 'end' } }] });
};

async function boot() {
  s = await bootTestServer({
    modules: [createBudgetModule({ stopGraceMs: 100 }), capture],
    providers: [new FakeProvider({ deltaMs: 1 })],
    dispatcher: { pollMs: 5 },
  });
  const owner = seedUser(s.db);
  const member = seedUser(s.db, 'member', 'Mia');
  const agent = (slug: string, model: string | null) => {
    const id = seedAgent(s!.db, { slug });
    s!.db.prepare('UPDATE agents SET name = ?, model = ? WHERE id = ?').run(slug, model, id);
    const chat = seedChat(s!.db, { userIds: [owner.id], agentIds: [id] });
    return { id, chat };
  };
  return { owner, member, agent, o: api(owner.token), m: api(member.token) };
}
/** an agent's run bearer (its seeded run row is left out of `runsOf`) */
const seeded = new Set<string>();
function bearerFor(agentId: string) {
  const { token, runId } = seedRunToken(s!.db, agentId);
  seeded.add(runId);
  return token;
}
const runsOf = (agentId: string) =>
  (
    s!.db.prepare('SELECT id, state FROM runs WHERE agent_id = ? ORDER BY started_at, id').all(agentId) as {
      id: string;
      state: string;
    }[]
  ).filter((r) => !seeded.has(r.id));
const messages = (chatId: string) =>
  s!.db
    .prepare(
      'SELECT author_kind, body, blocks, status FROM messages WHERE chat_id = ? ORDER BY created_at, id',
    )
    .all(chatId) as { author_kind: string; body: string; blocks: string; status: string }[];
const cards = (chatId: string) =>
  messages(chatId)
    .filter((m) => m.author_kind === 'system')
    .flatMap((m) => JSON.parse(m.blocks) as { kind: string; data: any }[])
    .filter((b) => b.kind === 'budget.cap')
    .map((b) => b.data);
async function sendAndWait(
  o: ReturnType<typeof api>,
  a: { id: string; chat: string },
  text: string,
  n: number,
) {
  const r = await o('POST', `/api/v1/chats/${a.chat}/messages`, { text });
  expect(r.status).toBeLessThan(300);
  return until(() => {
    const rs = runsOf(a.id);
    return rs.length >= n && rs[n - 1]!.state !== 'running' && rs;
  });
}

describe('budget: costs', () => {
  it('usage of two agents and two models rolls up; a model with no price shows "price not set" and adds nothing', async () => {
    const { agent, o, m } = await boot();
    const a = agent('tala', 'small');
    const b = agent('ligaya', 'big');
    const c = agent('dalisay', 'unpriced');
    const costs: unknown[] = [];
    s!.bus.subscribe((ev) => ev.type === 'budget.cost' && costs.push(ev.data));
    expect(
      (
        await o('PUT', '/api/m/budget/prices', {
          providerId: 'fake',
          model: 'small',
          inputPerM: 1,
          outputPerM: 2,
          cachedPerM: 0.5,
          currency: 'USD',
        })
      ).status,
    ).toBe(200);
    await o('PUT', '/api/m/budget/prices', {
      providerId: 'fake',
      model: 'big',
      inputPerM: 10,
      outputPerM: 20,
      cachedPerM: 0,
      currency: 'USD',
    });
    // members and agents never edit prices
    expect(
      (
        await m('PUT', '/api/m/budget/prices', {
          providerId: 'fake',
          model: 'x',
          inputPerM: 0,
          outputPerM: 0,
          cachedPerM: 0,
        })
      ).status,
    ).toBe(403);
    const bearer = bearerFor(a.id);
    expect((await api(bearer)('GET', '/api/m/budget/summary')).status).toBe(401);

    await sendAndWait(o, a, quick(1_000_000, 500_000, 200_000), 1); // 1 + 1 + 0.1 = 2.1 USD
    await sendAndWait(o, a, quick(500_000), 2); // 0.5
    await sendAndWait(o, b, quick(100_000, 10_000), 1); // 1 + 0.2 = 1.2
    await sendAndWait(o, c, quick(7_000, 3_000), 1); // price not set
    await until(() => costs.length === 4);

    const sum = (await o('GET', '/api/m/budget/summary?period=today')).json;
    const byAgent = Object.fromEntries(sum.agents.map((x: any) => [x.name, x]));
    expect(byAgent.tala).toMatchObject({
      runs: 2,
      input: 1_500_000,
      output: 500_000,
      cache: 200_000,
      unpricedRuns: 0,
    });
    expect(byAgent.tala.costs).toEqual([{ currency: 'USD', amount: 2.6 }]);
    expect(byAgent.ligaya.costs).toEqual([{ currency: 'USD', amount: 1.2 }]);
    expect(byAgent.dalisay).toMatchObject({ runs: 1, costs: [], unpricedRuns: 1 });
    const byModel = Object.fromEntries(sum.models.map((x: any) => [x.model, x]));
    expect(byModel.small.cost).toEqual({ currency: 'USD', amount: 2.6 });
    expect(byModel.big.cost).toEqual({ currency: 'USD', amount: 1.2 });
    expect(byModel.unpriced.cost).toBeNull();
    expect(sum.totals).toEqual([{ currency: 'USD', amount: 3.8 }]);
    expect(sum.unpriced).toEqual({ runs: 1, input: 7_000, output: 3_000, cache: 0 });
    // this month includes today
    expect((await o('GET', '/api/m/budget/summary?period=month')).json.totals).toEqual([
      { currency: 'USD', amount: 3.8 },
    ]);
    // the price table lists the unpriced model with no price, never a guessed one
    const prices = (await o('GET', '/api/m/budget/prices')).json.prices;
    expect(prices.find((p: any) => p.model === 'unpriced')).toEqual({
      providerId: 'fake',
      model: 'unpriced',
      price: null,
    });
    // per task, and the cost event W31 receipts read
    const tasks = (await o('GET', '/api/m/budget/tasks')).json.tasks;
    expect(tasks).toHaveLength(4);
    expect(tasks.find((t: any) => t.model === 'unpriced').cost).toBeNull();
    expect(costs).toContainEqual(
      expect.objectContaining({ model: 'big', cost: { amount: 1.2, currency: 'USD' } }),
    );
  });
});

describe('budget: caps', () => {
  it('an agent at its daily cap stops mid-task cleanly with a raise/keep card; its next message waits; only the owner raises', async () => {
    const { agent, o, m } = await boot();
    const a = agent('tala', null);
    await o('PUT', '/api/m/budget/prices', {
      providerId: 'fake',
      model: '',
      inputPerM: 1,
      outputPerM: 1,
      cachedPerM: 0,
      currency: 'USD',
    });
    expect((await m('PUT', '/api/m/budget/caps', { scope: a.id, period: 'day', amount: 100 })).status).toBe(
      403,
    );
    expect(
      (await o('PUT', '/api/m/budget/caps', { scope: a.id, period: 'day', amount: 0.5, currency: 'USD' }))
        .status,
    ).toBe(200);

    const t0 = Date.now();
    await sendAndWait(o, a, longTask(1_000_000), 1);
    // stopped well before the 5 s the task still wanted, cancelled (not failed), and what it wrote is kept
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(runsOf(a.id)[0]!.state).toBe('cancelled');
    const reply = messages(a.chat).find((x) => x.author_kind === 'agent')!;
    expect(reply.body).toBe('Working on part one');
    const card = await until(() => cards(a.chat)[0]);
    expect(card).toMatchObject({
      scope: 'agent',
      period: 'day',
      cap: 0.5,
      // 1 USD reported input + the 19 streamed characters (~5 output tokens) the mid-run estimate counts
      spent: 1.000005,
      currency: 'USD',
      reason: 'stopped',
      state: 'open',
    });
    expect(messages(a.chat).find((x) => x.author_kind === 'system')!.body).toContain(
      'stopped; what it wrote so far is kept',
    );

    // the next message waits (held), it does not run
    await o('POST', `/api/v1/chats/${a.chat}/messages`, { text: 'hello again' });
    const held = await until(() => s!.queue.list(a.id).find((i) => i.state === 'held'));
    expect(held.error).toMatch(/^budget: agent daily cap reached/);
    expect(runsOf(a.id)).toHaveLength(1);
    // one open card per cap and agent: the stopped card already asks, so waiting work adds no second one
    await o('POST', `/api/v1/chats/${a.chat}/messages`, { text: 'and again' });
    await until(() => s!.queue.list(a.id).filter((i) => i.state === 'held').length === 2);
    expect(cards(a.chat)).toHaveLength(1);

    // W39: the owner's decision bar lists the open card (owner only)
    const open = await o('GET', '/api/m/budget/alerts');
    expect(open.json.alerts).toEqual([
      expect.objectContaining({
        alertId: card.alertId,
        agentName: card.agentName,
        chatId: a.chat,
        state: 'open',
      }),
    ]);
    expect((await m('GET', '/api/m/budget/alerts')).status).toBe(403);
    // only an owner session raises: members 403, an agent's run bearer 401; a "raise" must be higher
    expect((await m('POST', `/api/m/budget/alerts/${card.alertId}/raise`, { amount: 5 })).status).toBe(403);
    const bearer = bearerFor(a.id);
    expect(
      (await api(bearer)('POST', `/api/m/budget/alerts/${card.alertId}/raise`, { amount: 5 })).status,
    ).toBe(401);
    expect(
      (await api(bearer)('PUT', '/api/m/budget/caps', { scope: a.id, period: 'day', amount: 5 })).status,
    ).toBe(401);
    expect((await o('POST', `/api/m/budget/alerts/${card.alertId}/raise`, { amount: 0.4 })).json.error).toBe(
      'not_a_raise',
    );
    const raised = await o('POST', `/api/m/budget/alerts/${card.alertId}/raise`, { amount: 5 });
    expect(raised.json).toMatchObject({ state: 'raised', cap: { amount: 5, currency: 'USD' } });
    // the waiting messages run now, and every open card of that cap shows the decision
    await until(
      () =>
        runsOf(a.id).length === 3 && runsOf(a.id).every((r) => r.state === 'done' || r.state === 'cancelled'),
    );
    expect(
      messages(a.chat)
        .filter((x) => x.author_kind === 'agent')
        .map((x) => x.body),
    ).toContain('echo: hello again');
    expect(cards(a.chat).every((c) => c.state === 'raised' && c.newCap === 5)).toBe(true);
    expect((await o('POST', `/api/m/budget/alerts/${card.alertId}/keep`)).status).toBe(409);
    // decided: nothing open is left for the bar
    expect((await o('GET', '/api/m/budget/alerts')).json.alerts).toEqual([]);
  });

  it('the global cap stops every agent; "keep" leaves the work waiting', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', null);
    const b = agent('ligaya', null);
    await o('PUT', '/api/m/budget/prices', {
      providerId: 'fake',
      model: '',
      inputPerM: 1,
      outputPerM: 1,
      cachedPerM: 0,
      currency: 'USD',
    });
    await o('PUT', '/api/m/budget/caps', { scope: 'global', period: 'day', amount: 1, currency: 'USD' });
    await sendAndWait(o, a, quick(600_000), 1);
    await sendAndWait(o, b, quick(600_000), 1); // ran: 0.6 < 1 when it started; now 1.2 in all
    expect(cards(b.chat)[0]).toMatchObject({ scope: 'global', reason: 'reached', spent: 1.2 });
    await o('POST', `/api/v1/chats/${a.chat}/messages`, { text: 'more please' });
    const held = await until(() => s!.queue.list(a.id).find((i) => i.state === 'held'));
    expect(held.error).toMatch(/^budget: global daily cap reached/);
    const card = await until(() => cards(a.chat)[0]);
    expect(card).toMatchObject({ scope: 'global', reason: 'held', state: 'open' });
    const kept = await o('POST', `/api/m/budget/alerts/${card.alertId}/keep`);
    expect(kept.json.state).toBe('kept');
    expect(cards(a.chat)[0].state).toBe('kept');
    expect(cards(b.chat)[0].state).toBe('kept'); // every open card of that cap settles
    await new Promise((r) => setTimeout(r, 100));
    expect(s!.queue.get(held.id)!.state).toBe('held');
    expect(runsOf(a.id)).toHaveLength(1);
    // the caps view shows the spend against the cap
    const caps = (await o('GET', '/api/m/budget/caps')).json;
    expect(caps.global.day).toEqual({ amount: 1, currency: 'USD', spent: 1.2 });
  });

  it('a routine fire at the cap is refused before it runs (skipped: budget), never failed', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', null);
    await o('PUT', '/api/m/budget/prices', {
      providerId: 'fake',
      model: '',
      inputPerM: 1,
      outputPerM: 1,
      cachedPerM: 0,
      currency: 'USD',
    });
    await o('PUT', '/api/m/budget/caps', { scope: a.id, period: 'month', amount: 0.1, currency: 'USD' });
    await sendAndWait(o, a, quick(200_000), 1);
    const refused: any[] = [];
    s!.bus.subscribe((ev) => ev.type === 'queue.refused' && refused.push(ev.data));
    const { item } = capturedQueue!.enqueue({
      agentId: a.id,
      chatId: a.chat,
      kind: 'routine',
      payload: { text: 'nightly digest' },
      source: { sender: { kind: 'system', id: null, name: 'routine', trust: 'guarded' } },
    });
    const done = await until(() => {
      const q = s!.queue.get(item.id);
      return q && q.state !== 'queued' && q.state !== 'leased' && q;
    });
    expect(done.state).toBe('cancelled');
    expect(done.error).toMatch(/^budget: agent monthly cap reached/);
    expect(refused).toEqual([
      expect.objectContaining({ itemId: item.id, kind: 'routine', reason: done.error }),
    ]);
    expect(runsOf(a.id)).toHaveLength(1);
  });
});

describe('budget: real providers report usage only at the end of a turn', () => {
  const price = (o: ReturnType<typeof api>) =>
    o('PUT', '/api/m/budget/prices', {
      providerId: 'fake',
      model: '',
      inputPerM: 1000,
      outputPerM: 1000,
      cachedPerM: 0,
      currency: 'USD',
    });

  it('a Codex-shaped turn (usage only at turn.completed) is still stopped mid-task from what it streamed, and booked', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', null);
    await price(o); // 1 token = 0.001 USD
    await o('PUT', '/api/m/budget/caps', { scope: a.id, period: 'day', amount: 0.5, currency: 'USD' });
    const big = 'x'.repeat(3000); // ~750 tokens streamed: 0.75 USD, past the 0.5 cap long before the turn ends
    const t0 = Date.now();
    await sendAndWait(
      o,
      a,
      viaCodex([
        { line: { type: 'thread.started', thread_id: 'th-1' } },
        {
          line: {
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'Reading the files' },
          },
        },
        {
          line: {
            type: 'item.started',
            item: { id: 'c1', type: 'command_execution', command: `cat <<'EOF' > plan.md\n${big}\nEOF` },
          },
        },
        {
          after: 5000,
          line: {
            type: 'item.completed',
            item: { id: 'c1', type: 'command_execution', aggregated_output: 'ok', exit_code: 0 },
          },
        },
        {
          line: {
            type: 'turn.completed',
            usage: { input_tokens: 40_000, cached_input_tokens: 0, output_tokens: 9_000 },
          },
        },
      ]),
      1,
    );
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(runsOf(a.id)[0]!.state).toBe('cancelled');
    expect(await until(() => cards(a.chat)[0])).toMatchObject({ reason: 'stopped', scope: 'agent' });
    // the cut run never reported usage: it is booked at its estimate, so the cap keeps counting it
    const tasks = (await o('GET', '/api/m/budget/tasks')).json.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ estimated: true, state: 'cancelled' });
    expect(tasks[0].output).toBeGreaterThanOrEqual(750);
    expect((await o('GET', '/api/m/budget/caps')).json.agents[0].day.spent).toBeGreaterThanOrEqual(0.75);
  });

  it('two agents under one global cap see each other’s live spend while both are working', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', null);
    const b = agent('ligaya', null);
    await price(o);
    await o('PUT', '/api/m/budget/caps', { scope: 'global', period: 'day', amount: 1, currency: 'USD' });
    const work = (n: number) =>
      viaCodex([
        { line: { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'y'.repeat(n) } } },
        { after: 5000, line: { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    // each streams ~600 tokens (0.6 USD): neither alone reaches 1 USD, together they do
    await o('POST', `/api/v1/chats/${a.chat}/messages`, { text: work(2400) });
    await until(() => runsOf(a.id)[0]);
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    await sendAndWait(o, b, work(2400), 1);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(runsOf(b.id)[0]!.state).toBe('cancelled');
  });

  it('a turn whose closing usage crosses the cap while the CLI is still exiting is never cut', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', null);
    await price(o);
    await o('PUT', '/api/m/budget/caps', { scope: a.id, period: 'day', amount: 0.5, currency: 'USD' });
    await sendAndWait(
      o,
      a,
      JSON.stringify({
        fakeScript: [
          { event: { type: 'text.final', text: 'All done.' } },
          { event: { type: 'usage', inputTokens: 2_000, outputTokens: 10 } },
          // the CLI shuts its MCP servers down for longer than the 100 ms grace
          { after: 600, event: { type: 'done', stop: 'end' } },
        ],
      }),
      1,
    );
    expect(runsOf(a.id)[0]!.state).toBe('done');
    expect(await until(() => cards(a.chat)[0])).toMatchObject({ reason: 'reached' });
    expect(messages(a.chat).find((x) => x.author_kind === 'agent')!.body).toBe('All done.');
  });
});

describe('budget: one currency, and the spend a cap cannot see', () => {
  it('a cap and a price in different currencies are refused; unpriced models are listed on the caps view', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', 'unpriced');
    const usd = (model: string, currency = 'USD') =>
      o('PUT', '/api/m/budget/prices', {
        providerId: 'fake',
        model,
        inputPerM: 1,
        outputPerM: 1,
        cachedPerM: 0,
        currency,
      });
    expect((await usd('small')).status).toBe(200);
    expect((await usd('local', 'PHP')).status).toBe(200); // no cap yet: mixed prices are allowed
    const mixed = await o('PUT', '/api/m/budget/caps', {
      scope: a.id,
      period: 'day',
      amount: 5,
      currency: 'USD',
    });
    expect(mixed.status).toBe(409);
    expect(mixed.json.error).toBe('currency_mismatch');
    expect((await usd('local')).status).toBe(200);
    expect(
      (await o('PUT', '/api/m/budget/caps', { scope: a.id, period: 'day', amount: 5, currency: 'USD' }))
        .status,
    ).toBe(200);
    // with a USD cap, no price and no other cap may use another currency
    expect((await usd('big', 'PHP')).json.error).toBe('currency_mismatch');
    expect(
      (await o('PUT', '/api/m/budget/caps', { scope: 'global', period: 'month', amount: 9, currency: 'PHP' }))
        .json.error,
    ).toBe('currency_mismatch');
    // a model with no price adds nothing to any cap: the caps view says so
    await sendAndWait(o, a, quick(7_000), 1);
    expect((await o('GET', '/api/m/budget/caps')).json.uncovered).toEqual([
      { providerId: 'fake', model: 'unpriced' },
    ]);
  });
});

describe('budget: routine-started workflows', () => {
  it('at the cap, a step of a workflow a routine started is refused (skipped), a step of an owner-started one waits', async () => {
    const { agent, o } = await boot();
    const a = agent('tala', null);
    await o('PUT', '/api/m/budget/prices', {
      providerId: 'fake',
      model: '',
      inputPerM: 1,
      outputPerM: 1,
      cachedPerM: 0,
      currency: 'USD',
    });
    await o('PUT', '/api/m/budget/caps', { scope: a.id, period: 'month', amount: 0.1, currency: 'USD' });
    await sendAndWait(o, a, quick(200_000), 1);
    const refused: any[] = [];
    s!.bus.subscribe((ev) => ev.type === 'queue.refused' && refused.push(ev.data));
    flowRuns.set('wr-routine', 'routine:r1');
    flowRuns.set('wr-owner', 'user:owner');
    const step = (run: string) =>
      capturedQueue!.enqueue({
        agentId: a.id,
        chatId: a.chat,
        kind: 'workflow',
        payload: { text: 'step', workflowRunId: run, stepId: `${run}-s1` },
        source: {
          sender: { kind: 'system', id: null, name: 'routine', trust: 'guarded' },
          workflowRunId: run,
          stepId: `${run}-s1`,
        },
      }).item;
    const r1 = step('wr-routine');
    const r2 = step('wr-owner');
    const settled = (id: string) =>
      until(() => {
        const q = s!.queue.get(id);
        return q && q.state !== 'queued' && q.state !== 'leased' && q;
      });
    const d1 = await settled(r1.id);
    expect(d1.state).toBe('cancelled');
    expect(d1.error).toMatch(/^budget: agent monthly cap reached/);
    expect(refused).toEqual([
      expect.objectContaining({ itemId: r1.id, kind: 'workflow', workflowRunId: 'wr-routine' }),
    ]);
    expect((await settled(r2.id)).state).toBe('held');
    expect(runsOf(a.id)).toHaveLength(1);
  });
});
