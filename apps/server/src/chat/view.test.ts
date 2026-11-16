/**
 * The owner's cards never leave the server for anyone else (chat/view.ts): a member or a guest of a group chat gets
 * the failed reply as one neutral line and no owner notice at all, on every path (the message list, a module route,
 * the chat port, search, the live socket and a socket's replay).
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
import { createChatPort } from './port.js';
import { DROP, viewEvent, viewMessage, viewPayload } from './view.js';

const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const NEUTRAL = 'Tala couldn’t finish this reply.';
const SECRET = 'Not logged in. Please run /login';

describe('the owner’s cards reach the owner only', () => {
  let s: TestServer;
  const fake = new FakeProvider();
  let owner = '';
  let member: { id: string; token: string };
  let guest: { id: string; token: string };
  let agentId = '';
  let group = '';
  let replyId = '';
  let noticeId = '';
  let guestSeq = 0;
  const api = async (path: string, body?: unknown, tok = owner) => {
    const r = await fetch(`${s.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${tok}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      text: await r.clone().text(),
      json: (await r.json().catch(() => ({}))) as any,
    };
  };
  // a module route that hands out messages as the system reads them: the server's own serialiser still applies
  const probe: PasaBotModule = {
    id: 'viewprobe',
    register(app) {
      app.http.route({
        method: 'GET',
        url: '/msg/:id',
        auth: 'session',
        handler: (ctx) => {
          const m = app.chats.message(asSystem('test: a module reads a message'), (ctx.params as any).id);
          return { message: m, list: [m], nested: { at: { message: m } } };
        },
      });
    },
  };
  const ws1: { frames: any[]; close(): void }[] = [];

  beforeAll(async () => {
    s = await bootTestServer({ providers: [fake], modules: [probe] });
    owner = seedUser(s.db, 'owner').token;
    member = seedUser(s.db, 'member', 'Mia');
    guest = seedUser(s.db, 'guest', 'Gio');
    const r = await api('/api/v1/agents', { name: 'Tala', providerId: 'fake', trustLevel: 'standard' });
    expect(r.status).toBe(201);
    agentId = r.json.agent?.id ?? r.json.id ?? r.json.agentId;
    const g = await api('/api/v1/chats', {
      kind: 'channel',
      title: 'Shop',
      agentIds: [agentId],
      userIds: [member.id, guest.id],
    });
    expect(g.status).toBe(201);
    group = g.json.chat.id;

    // the member's socket is on the group chat while the reply fails
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: member.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: [`chat:${group}`, 'global'] });
    ws.send({ t: 'ping', n: 1 });
    await ws.next((f) => f.t === 'pong');
    ws1.push(ws);
    // a guest socket notes where it was, to replay from there later
    const gws = await connectWs(s.url);
    gws.send({ t: 'hello', v: 1, token: guest.token });
    guestSeq = (await gws.next((f) => f.t === 'welcome')).seq;
    gws.close();

    // the owner's turn in the group fails on a signed-out brain: the reply carries the owner's card
    const text = JSON.stringify({
      fakeScript: [
        { event: { type: 'error', kind: 'auth', message: SECRET } },
        { event: { type: 'done', stop: 'error' } },
      ],
    });
    expect((await api(`/api/v1/chats/${group}/messages`, { text })).status).toBeLessThan(300);
    const reply = await waitFor(async () =>
      ((await api(`/api/v1/chats/${group}/messages`)).json.messages as MessageDTO[]).find(
        (m) => m.authorKind === 'agent' && m.blocks.some((b) => b.kind === 'core.card'),
      ),
    );
    replyId = reply.id;
    // and an owner notice lands in the group too (a module's card, whatever chat it names)
    noticeId = s.cards.forModule('viewprobe').post({
      chatId: group,
      card: {
        variant: 'info',
        title: { text: 'Spend cap reached: 40 of 40 (owner only)' },
        actions: [{ id: 'later', label: { key: 'core:card.action.notNow' }, settle: 'later' }],
        source: 'viewprobe',
      },
    })!.id;
    const marker = s.bus.publish('global', 'chat.created', { id: 'marker' });
    await ws.next((f) => f.t === 'ev' && f.seq === marker);
  });
  afterAll(async () => {
    for (const w of ws1) w.close();
    await s.cleanup();
  });

  // (the owner's own message holds the test script, so people's messages are left out of the check)
  const noCardIn = (x: unknown) => {
    const t = JSON.stringify(x, (_k, v) => (v && v.authorKind === 'user' ? undefined : v));
    expect(t).not.toContain('core.card');
    expect(t).not.toContain('Not logged in');
    expect(t).not.toContain('Spend cap');
    expect(t).not.toContain('core:card.');
    expect(t).not.toContain('signin');
  };

  it('the owner still gets the card on the reply and the notice', async () => {
    const ms = (await api(`/api/v1/chats/${group}/messages`)).json.messages as MessageDTO[];
    expect(ms.find((m) => m.id === replyId)!.blocks.some((b) => b.kind === 'core.card')).toBe(true);
    expect(ms.some((m) => m.blocks.some((b) => (b.data as any)?.id === noticeId))).toBe(true);
  });

  it('the message list: a member and a guest get the neutral line for the failed reply and no notice', async () => {
    for (const tok of [member.token, guest.token]) {
      const r = await api(`/api/v1/chats/${group}/messages`, undefined, tok);
      expect(r.status).toBe(200);
      noCardIn(r.json);
      const reply = (r.json.messages as MessageDTO[]).find((m) => m.id === replyId)!;
      expect(reply).toMatchObject({ body: NEUTRAL, blocks: [] });
      expect(r.json.messages.length).toBeGreaterThan(0);
    }
  });

  it('a module route: the shared serialiser applies to every response a member or guest gets', async () => {
    for (const tok of [member.token, guest.token]) {
      const r = await api(`/api/m/viewprobe/msg/${replyId}`, undefined, tok);
      expect(r.status).toBe(200);
      noCardIn(r.json);
      expect(r.json.message).toMatchObject({ id: replyId, body: NEUTRAL, blocks: [] });
      expect(r.json.nested.at.message.body).toBe(NEUTRAL);
      const n = await api(`/api/m/viewprobe/msg/${(await noticeMessage()).id}`, undefined, tok);
      noCardIn(n.json);
      expect(n.json).toEqual({ message: null, list: [], nested: { at: { message: null } } });
    }
    const own = await api(`/api/m/viewprobe/msg/${replyId}`);
    expect(own.text).toContain('core.card');
  });
  const noticeMessage = async () =>
    ((await api(`/api/v1/chats/${group}/messages`)).json.messages as MessageDTO[]).find((m) =>
      m.blocks.some((b) => (b.data as any)?.id === noticeId),
    )!;

  it('the chat port and search: a person who is not the owner gets no card and finds none', async () => {
    const n = await noticeMessage();
    const chats = createChatPort(s.db);
    for (const u of [member, guest]) {
      expect(chats.message({ kind: 'user', id: u.id }, replyId)).toMatchObject({ body: NEUTRAL, blocks: [] });
      expect(chats.message({ kind: 'user', id: u.id }, n.id)).toBeNull();
      const hits = chats.search({
        reader: { kind: 'user', id: u.id, userKind: 'member' } as any,
        text: 'Spend',
      });
      expect(hits).toEqual([]);
    }
    const ownerId = (s.db.prepare("SELECT id FROM users WHERE kind = 'owner'").get() as { id: string }).id;
    expect(
      chats.search({ reader: { kind: 'user', id: ownerId, userKind: 'owner' } as any, text: 'Spend' }).length,
    ).toBe(1);
  });

  it('the live socket: the member got the failed reply as the neutral line, and never a card or a notice', () => {
    const frames = ws1[0]!.frames;
    noCardIn(frames);
    const updates = frames.filter((f) => f.data?.id === replyId);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1).data).toMatchObject({ body: NEUTRAL, blocks: [] });
  });

  it('a socket’s replay: the guest catching up gets the same', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: guest.token, resumeFrom: guestSeq });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: [`chat:${group}`] });
    ws.send({ t: 'ping', n: 2 });
    await ws.next((f) => f.t === 'pong');
    const replayed = ws.frames.filter((f: any) => f.t === 'ev');
    expect(replayed.some((f: any) => f.data?.id === replyId)).toBe(true);
    noCardIn(ws.frames);
    ws.close();
  });

  it('viewPayload: any shape, any depth; the owner gets it unchanged; non-owners never get a card block', () => {
    const card = { kind: 'core.card', v: 1, data: { id: ulid(), variant: 'ok', source: 'core.approval' } };
    const msg = (o: Partial<MessageDTO>): MessageDTO => ({
      id: ulid(),
      chatId: ulid(),
      authorKind: 'system',
      authorId: null,
      replyTo: null,
      body: 'Needs your OK: send 40 to Bank',
      blocks: [card] as never,
      status: 'final',
      runId: null,
      createdAt: 1,
      editedAt: null,
      ...o,
    });
    const deps = { db: s.db };
    const notice = msg({});
    expect(viewMessage(notice, { kind: 'owner' }, deps)).toBe(notice);
    for (const kind of ['member', 'guest', 'automation', 'anonymous']) {
      expect(viewMessage(notice, { kind }, deps)).toBeNull();
      expect(viewPayload(notice, { kind }, deps)).toBe(DROP);
      const out = viewPayload(
        { a: [notice, { x: { blocks: [card, { kind: 'richchat.ask' }, { kind: 'mod.own' }] } }], b: notice },
        { kind },
        deps,
      );
      // deny by default: only the shared kinds stay, a module's own kind is the owner's
      expect(out).toEqual({ a: [{ x: { blocks: [{ kind: 'richchat.ask' }] } }], b: null });
      // a helper's file handed to the chat: its plain words, never the card
      const file = msg({
        authorKind: 'agent',
        blocks: [{ ...card, data: { ...card.data, variant: 'result' } }] as never,
      });
      expect(viewMessage(file, { kind }, deps)).toMatchObject({ body: file.body, blocks: [] });
    }
  });

  it('helper threads: the request and its thread, the status line and the full answers are the owner’s', () => {
    const deps = { db: s.db };
    const base = (o: Partial<MessageDTO>): MessageDTO => ({
      id: ulid(),
      chatId: ulid(),
      authorKind: 'agent',
      authorId: agentId,
      replyTo: null,
      body: 'Count the pens',
      blocks: [],
      status: 'final',
      runId: null,
      createdAt: 1,
      editedAt: null,
      ...o,
    });
    const thread = { kind: 'collab.thread', v: 1, data: { from: agentId, to: ulid(), kind: 'delegate' } };
    const task = { kind: 'collab.task', v: 1, data: { taskId: ulid(), fromChatId: ulid() } };
    const request = base({ blocks: [thread, task] as never });
    const status = base({
      authorKind: 'system',
      authorId: null,
      body: '',
      blocks: [
        { kind: 'collab.status', v: 1, data: { batchId: ulid(), phase: 'working', items: [] } },
      ] as never,
    });
    const report = base({
      body: 'Sabi ni Ligaya: twelve pens',
      runId: ulid(),
      blocks: [
        { kind: 'collab.report', v: 1, data: { mode: 'report', items: [{ answer: 'secret answer' }] } },
      ] as never,
    });
    const answer = base({ body: 'twelve pens, and the owner’s address', runId: ulid(), replyTo: request.id });
    const fallback = base({
      authorKind: 'system',
      authorId: null,
      body: 'Ligaya finished: twelve pens',
      blocks: [{ kind: 'collab.report', v: 1, data: { mode: 'fallback', items: [] } }] as never,
    });
    const note = base({
      authorKind: 'system',
      authorId: null,
      body: 'Stopped here',
      blocks: [{ kind: 'collab.note', v: 1, data: { key: 'stopped' } }] as never,
    });
    // the request is in the database (a reply in its thread finds it)
    s.db
      .prepare(
        "INSERT INTO messages (id, chat_id, author_kind, author_id, body, blocks, status, created_at) VALUES (?, ?, 'agent', ?, ?, ?, 'final', 1)",
      )
      .run(request.id, group, agentId, request.body, JSON.stringify(request.blocks));
    const ownerReply = base({ authorKind: 'user', authorId: null, body: 'shorter', replyTo: request.id });
    const deeper = base({ body: 'shorter now', runId: ulid(), replyTo: ownerReply.id });
    s.db
      .prepare(
        "INSERT INTO messages (id, chat_id, author_kind, author_id, reply_to, body, status, created_at) VALUES (?, ?, 'user', NULL, ?, 'shorter', 'final', 2)",
      )
      .run(ownerReply.id, group, request.id);
    for (const m of [request, status, report, fallback, note, answer, ownerReply, deeper])
      expect(viewMessage(m, { kind: 'owner' }, deps)).toBe(m);
    for (const kind of ['member', 'guest', 'automation', 'channel']) {
      // what one helper asked another for the owner, and everything said in that thread: nothing at all (the
      // owner may share the chat later)
      expect(viewMessage(request, { kind }, deps)).toBeNull();
      expect(viewMessage(answer, { kind }, deps)).toBeNull();
      expect(viewMessage(ownerReply, { kind }, deps)).toBeNull();
      expect(viewMessage(deeper, { kind }, deps)).toBeNull();
      expect(JSON.stringify(viewPayload({ m: [request, answer] }, { kind }, deps))).not.toContain('address');
      // the status line is an owner notice: nothing at all
      expect(viewMessage(status, { kind }, deps)).toBeNull();
      // the server's own report card: its words (what the asker would have said), never the full answers
      expect(viewMessage(fallback, { kind }, deps)).toEqual({ ...fallback, blocks: [] });
      // the asker's report reads as its words, without the full answers
      expect(viewMessage(report, { kind }, deps)).toEqual({ ...report, blocks: [] });
      expect(JSON.stringify(viewPayload({ m: [report, fallback] }, { kind }, deps))).not.toContain(
        'secret answer',
      );
      expect(viewMessage(note, { kind }, deps)).toBe(note);
      // the event that the owner's chats list refetches on never reaches anyone else
      expect(viewEvent('collab.tasks', { at: 1 }, { kind }, deps)).toBe(DROP);
    }
  });
});
