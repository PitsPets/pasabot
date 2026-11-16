/**
 * What a helper asks the owner is the owner's (chat/view.ts, deny by default): in a group chat with a member and a
 * guest, the approval's message reaches them as one neutral line ("Tala is waiting for the owner’s OK.", then "got
 * the OK" / "was not allowed"), never the tool, its arguments, a preview, the nonce or who decided, on every path:
 * the message list, a module route, the chat port and search, the live socket (no `approval.*` event at all), a
 * socket's replay, and the run's tool activity. Owner-only block kinds (a budget alert, a screen helper card, a
 * module's own kind) and owner-only event types never reach them either.
 */
import { asSystem, type PasaBotModule, ulid } from '@pasabot/core';
import type { MessageDTO } from '@pasabot/protocol';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { createChatPort } from '../chat/port.js';
import { DROP, viewEvent, viewMessage, viewPayload } from '../chat/view.js';

const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const WAITING = 'Tala is waiting for the owner’s OK.';
const APPROVED = 'Tala got the OK.';
const REFUSED = 'Tala was not allowed.';
const SECRET_ARG = 'owner-diary-2026.txt';
const TOOL_ARG = 'sk-tool-result-77';

describe('approval details reach the owner only', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let guest: { id: string; token: string };
  let agentId = '';
  let group = '';
  let firstId = '';
  let firstNonce = '';
  let first: Promise<unknown>;
  let guestSeq = 0;
  let memberWs: Awaited<ReturnType<typeof connectWs>>;
  const runId = 'RUNAPV00000000000000000001';
  const api = async (path: string, tok = owner.token) => {
    const r = await fetch(`${s.url}${path}`, { headers: { authorization: `Bearer ${tok}` } });
    return {
      status: r.status,
      text: await r.clone().text(),
      json: (await r.json().catch(() => ({}))) as any,
    };
  };
  const probe: PasaBotModule = {
    id: 'apvprobe',
    register(app) {
      app.http.route({
        method: 'GET',
        url: '/msg/:id',
        auth: 'session',
        handler: (ctx) => {
          const m = app.chats.message(asSystem('test: a module reads a message'), (ctx.params as any).id);
          const row = app.raw.prepare('SELECT * FROM approvals ORDER BY rowid LIMIT 1').get() as any;
          // a module that hands out an approval as it is stored: the serialiser still leaves it out
          const approval = {
            id: row.id,
            tier: row.tier,
            state: row.state,
            expiresAt: row.expires_at,
            action: JSON.parse(row.action),
            nonce: row.nonce,
          };
          return { message: m, list: [m], approval, approvals: [approval] };
        },
      });
    },
  };
  const messages = async (tok: string) =>
    (await api(`/api/v1/chats/${group}/messages`, tok)).json.messages as MessageDTO[];
  // nothing of the approval is in what a non-owner got (people's own messages left out)
  const nothingOf = (x: unknown) => {
    const t = JSON.stringify(x);
    expect(t).not.toContain(SECRET_ARG);
    expect(t).not.toContain(TOOL_ARG);
    expect(t).not.toContain('Bash');
    expect(t).not.toContain('core.approval');
    expect(t).not.toContain('approval.requested');
    expect(t).not.toContain('approval.resolved');
    expect(t).not.toContain('budget.cap');
    expect(t).not.toContain('computer.live');
    expect(t).not.toContain('Spend cap');
    if (firstNonce) expect(t).not.toContain(firstNonce);
    expect(t).not.toContain(owner.id);
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()], modules: [probe] });
    owner = seedUser(s.db, 'owner');
    member = seedUser(s.db, 'member', 'Mia');
    guest = seedUser(s.db, 'guest', 'Gio');
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await r.json()) as any;
    };
    const a = await post('/api/v1/agents', { name: 'Tala', providerId: 'fake', trustLevel: 'standard' });
    agentId = a.agent?.id ?? a.id;
    group = (
      await post('/api/v1/chats', {
        kind: 'channel',
        title: 'Shop',
        agentIds: [agentId],
        userIds: [member.id, guest.id],
      })
    ).chat.id;

    // the member's socket is on the group chat while the helper asks the owner
    memberWs = await connectWs(s.url);
    memberWs.send({ t: 'hello', v: 1, token: member.token });
    await memberWs.next((f) => f.t === 'welcome');
    memberWs.send({ t: 'sub', topics: [`chat:${group}`, 'global'] });
    memberWs.send({ t: 'ping', n: 1 });
    await memberWs.next((f) => f.t === 'pong');
    // a guest socket notes where it was, to replay from there later
    const gws = await connectWs(s.url);
    gws.send({ t: 'hello', v: 1, token: guest.token });
    guestSeq = (await gws.next((f) => f.t === 'welcome')).seq;
    gws.close();

    // the owner's turn in the group: the helper ran a tool and now asks the owner before a Bash command
    s.db
      .prepare(
        "INSERT INTO queue_items (id, agent_id, chat_id, seq, priority, kind, payload, source, state, created_at) VALUES ('QAPV', ?, ?, 1, 0, 'message', '{}', '{}', 'done', 0)",
      )
      .run(agentId, group);
    s.db
      .prepare(
        "INSERT INTO runs (id, queue_item_id, agent_id, provider_id, state, started_at) VALUES (?, 'QAPV', ?, 'fake', 'running', 0)",
      )
      .run(runId, agentId);
    const ev = s.db.prepare('INSERT INTO run_events (run_id, n, type, data) VALUES (?, ?, ?, ?)');
    ev.run(
      runId,
      1,
      'tool.call',
      JSON.stringify({ name: 'Read', input: { file_path: `/Users/o/${SECRET_ARG}` } }),
    );
    ev.run(runId, 2, 'tool.result', JSON.stringify({ name: 'Read', output: TOOL_ARG }));
    first = s.approvals.request({
      runId,
      agentId,
      tier: 2,
      action: { tool: 'Bash', input: { command: `cat ~/${SECRET_ARG}` } },
      summary: `Tala wants to: Bash cat ~/${SECRET_ARG}`,
    });
    const row = await waitFor(
      async () => s.db.prepare("SELECT id, nonce FROM approvals WHERE state = 'pending'").get() as any,
    );
    firstId = row.id;
    firstNonce = row.nonce;
    // owner-only kinds in the group: a module's budget alert (system), a screen helper card on a helper's message,
    // and a helper's question with an owner-only part beside it
    const put = (authorKind: string, body: string, blocks: unknown[]) => {
      const id = ulid();
      s.db
        .prepare(
          "INSERT INTO messages (id, chat_id, author_kind, author_id, body, blocks, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'final', ?)",
        )
        .run(
          id,
          group,
          authorKind,
          authorKind === 'agent' ? agentId : null,
          body,
          JSON.stringify(blocks),
          Date.now(),
        );
      const m = createChatPort(s.db).message(asSystem('test: read back'), id)!;
      s.bus.publish(`chat:${group}`, 'message.created', m);
      return id;
    };
    put('system', 'Spend cap reached: 40 of 40', [{ kind: 'budget.cap', v: 1, data: { spent: 40 } }]);
    put('agent', 'Spend cap is near', [{ kind: 'computer.live', v: 1, data: { agentId } }]);
    put('agent', 'Which one?', [
      { kind: 'richchat.ask', v: 1, data: { promptId: 'p1', question: 'Which one?' } },
      { kind: 'computer.live', v: 1, data: { agentId } },
    ]);
    // owner-only events on the chat topic
    s.bus.publish(`chat:${group}`, 'computer.frame' as never, { png: SECRET_ARG } as never);
    s.bus.publish(`chat:${group}`, 'card.changed', { id: 'c1', chatId: group, state: 'open' } as never);
    const marker = s.bus.publish('global', 'chat.created', { id: 'marker' });
    await memberWs.next((f) => f.t === 'ev' && f.seq === marker);
  });
  afterAll(async () => {
    memberWs?.close();
    await s.cleanup();
  });

  it('the owner gets the whole card: tool, arguments, nonce; and every owner-only block', async () => {
    const ms = await messages(owner.token);
    const card = ms.find((m) => m.id === `apv-${firstId}`)!;
    expect(card.blocks[0]).toMatchObject({ kind: 'core.approval', data: { id: firstId, nonce: firstNonce } });
    expect(JSON.stringify(card)).toContain(SECRET_ARG);
    expect(ms.some((m) => m.blocks.some((b) => b.kind === 'budget.cap'))).toBe(true);
    const act = await api(`/api/v1/runs/${runId}/activity`);
    expect(act.json.events.length).toBe(2);
    expect(act.text).toContain(TOOL_ARG);
  });

  it('the message list: a member and a guest get the neutral waiting line and no owner-only part', async () => {
    for (const tok of [member.token, guest.token]) {
      const r = await api(`/api/v1/chats/${group}/messages`, tok);
      expect(r.status).toBe(200);
      nothingOf(r.json);
      const ms = r.json.messages as MessageDTO[];
      expect(ms.find((m) => m.id === `apv-${firstId}`)).toMatchObject({ body: WAITING, blocks: [] });
      // the budget alert and the helper's screen card are not there at all; the helper's question is, alone
      expect(ms.some((m) => m.body.startsWith('Spend cap'))).toBe(false);
      expect(ms.find((m) => m.body === 'Which one?')!.blocks.map((b) => b.kind)).toEqual(['richchat.ask']);
    }
  });

  it('a module route, and an approval a module hands out: never the details, never the approval', async () => {
    for (const tok of [member.token, guest.token]) {
      const r = await api(`/api/m/apvprobe/msg/apv-${firstId}`, tok);
      expect(r.status).toBe(200);
      nothingOf(r.json);
      expect(r.json.message).toMatchObject({ body: WAITING, blocks: [] });
      expect(r.json.approval).toBeNull();
      expect(r.json.approvals).toEqual([]);
    }
    expect((await api(`/api/m/apvprobe/msg/apv-${firstId}`)).text).toContain(firstNonce);
  });

  it('the run’s tool activity: a member and a guest get the run’s state only, no tool, argument or result', async () => {
    for (const tok of [member.token, guest.token]) {
      const r = await api(`/api/v1/runs/${runId}/activity`, tok);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ run: { id: runId }, events: [] });
      nothingOf(r.json);
    }
  });

  it('the chat port and search: no details read back, nothing found by the action’s words', () => {
    const chats = createChatPort(s.db);
    for (const u of [member, guest]) {
      expect(chats.message({ kind: 'user', id: u.id }, `apv-${firstId}`)).toMatchObject({
        body: WAITING,
        blocks: [],
      });
      for (const text of [SECRET_ARG.split('-')[1]!, 'Spend'])
        expect(chats.search({ reader: { kind: 'user', id: u.id, userKind: 'member' } as any, text })).toEqual(
          [],
        );
    }
    // a helper reading the chat back (for anyone's turn) never gets the approval's words
    expect(JSON.stringify(chats.recent(asSystem('test'), group, 50))).not.toContain(SECRET_ARG);
    expect(
      chats.search({ reader: { kind: 'user', id: owner.id, userKind: 'owner' } as any, text: 'cat' }).length,
    ).toBeGreaterThan(0);
  });

  it('the live socket: the member got the neutral line and never an approval event or an owner-only part', () => {
    const frames = memberWs.frames;
    nothingOf(frames);
    expect(frames.some((f: any) => f.type === 'approval.requested' || f.type === 'computer.frame')).toBe(
      false,
    );
    expect(frames.some((f: any) => f.type === 'card.changed')).toBe(false);
    const card = frames.filter((f: any) => f.data?.id === `apv-${firstId}`);
    expect(card.at(-1).data).toMatchObject({ body: WAITING, blocks: [] });
  });

  it('a socket’s replay: the guest catching up gets the same', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: guest.token, resumeFrom: guestSeq });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: [`chat:${group}`] });
    ws.send({ t: 'ping', n: 2 });
    await ws.next((f) => f.t === 'pong');
    const replayed = ws.frames.filter((f: any) => f.t === 'ev');
    expect(replayed.find((f: any) => f.data?.id === `apv-${firstId}`)?.data).toMatchObject({ body: WAITING });
    nothingOf(ws.frames);
    ws.close();
  });

  it('decided: "got the OK" and "was not allowed", live and in the list, never who decided', async () => {
    s.approvals.decide(firstId, 'approved', owner.id);
    await first;
    await waitFor(async () =>
      memberWs.frames.find((f: any) => f.data?.id === `apv-${firstId}` && f.data.body === APPROVED),
    );
    const second = s.approvals.request({
      runId,
      agentId,
      tier: 2,
      action: { tool: 'Bash', input: { command: `rm ~/${SECRET_ARG}` } },
      summary: `Tala wants to: Bash rm ~/${SECRET_ARG}`,
    });
    const row = await waitFor(
      async () => s.db.prepare("SELECT id FROM approvals WHERE state = 'pending'").get() as any,
    );
    s.approvals.decide(row.id, 'denied', owner.id);
    await second;
    await waitFor(async () =>
      memberWs.frames.find((f: any) => f.data?.id === `apv-${row.id}` && f.data.body === REFUSED),
    );
    for (const tok of [member.token, guest.token]) {
      const ms = await messages(tok);
      expect(ms.find((m) => m.id === `apv-${firstId}`)).toMatchObject({ body: APPROVED, blocks: [] });
      expect(ms.find((m) => m.id === `apv-${row.id}`)).toMatchObject({ body: REFUSED, blocks: [] });
      nothingOf(ms);
    }
    nothingOf(memberWs.frames);
  });

  it('viewEvent / viewPayload: deny by default for anyone but the owner', () => {
    const deps = { db: s.db };
    const apv = { id: 'a1', tier: 2, state: 'pending', expiresAt: 1, action: { tool: 'Bash' }, nonce: 'n' };
    for (const kind of ['member', 'guest', 'link', 'automation', 'run', 'channel', 'anonymous']) {
      const v = { kind };
      expect(viewEvent('approval.requested', apv, v, deps)).toBe(DROP);
      expect(viewEvent('approval.resolved', apv, v, deps)).toBe(DROP);
      expect(viewEvent('notification', { text: 'x' }, v, deps)).toBe(DROP);
      expect(viewEvent('run.event', { runId }, v, deps)).toBe(DROP);
      expect(viewEvent('browser.frame', {}, v, deps)).toBe(DROP);
      expect(viewEvent('some.module.event', {}, v, deps)).toBe(DROP);
      expect(viewEvent('chat.created', { id: 'c' }, v, deps)).toEqual({ id: 'c' });
      expect(viewPayload({ a: apv, b: [apv, 1] }, v, deps)).toEqual({ a: null, b: [1] });
      const msg = {
        id: 'm1',
        chatId: group,
        authorKind: 'system' as const,
        authorId: null,
        replyTo: null,
        body: 'Tala wants to: Bash ls',
        blocks: [{ kind: 'core.approval' as const, v: 1, data: { ...apv, agentId } }],
        status: 'final' as const,
        runId,
        createdAt: 1,
        editedAt: null,
      };
      expect(viewMessage(msg, v, deps)).toMatchObject({ body: WAITING, blocks: [] });
      expect(viewMessage({ ...msg, blocks: [{ kind: 'mod.own', v: 1, data: {} }] }, v, deps)).toBeNull();
      // a person's own words stay, without an owner-only block
      expect(
        viewMessage({ ...msg, authorKind: 'user', blocks: [{ kind: 'mod.own', v: 1, data: {} }] }, v, deps),
      ).toMatchObject({ body: msg.body, blocks: [] });
    }
    expect(viewEvent('approval.requested', apv, { kind: 'owner' }, deps)).toBe(apv);
  });
});
