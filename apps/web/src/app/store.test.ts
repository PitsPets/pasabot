/**
 * Store + live socket: a revoked session drops every record and the resume cursor; a `gap` rebuilds approvals,
 * running runs and streams from REST, re-cursors at the welcome seq and subscribes to chats made meanwhile.
 * Runs in node with a fake WebSocket, fetch and sessionStorage (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

let rest: Record<string, unknown> = {};
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:1', hash: '' });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('fetch', async (path: string) => {
    const key = Object.keys(rest).find((k) => path === k);
    const body = key ? rest[key] : { error: 'not_found' };
    return new Response(JSON.stringify(body), { status: key ? 200 : 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const owner = { id: 'u-owner', kind: 'owner', displayName: 'Owner' };
const chat = (id: string) => ({
  id,
  kind: 'direct',
  title: id,
  sectionId: null,
  taskOwnerAgentId: null,
  settings: {},
  createdAt: 1,
  archivedAt: null,
  members: [{ kind: 'agent', id: 'a1', role: 'member' }],
});
const approval = (id: string, state = 'pending') => ({
  id,
  runId: 'r1',
  agentId: 'a1',
  tier: 2,
  summary: 's',
  action: null,
  state,
  decidedBy: null,
  decidedAt: null,
  expiresAt: 9,
});
const agent = { id: 'a1', name: 'Tala', archivedAt: null };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function serve(o: { chats: string[]; approvals: unknown[]; queue?: unknown[] }) {
  rest = {
    '/api/v1/agents': { agents: [agent] },
    '/api/v1/chats': { chats: o.chats.map(chat) },
    '/api/v1/approvals?state=pending': { approvals: o.approvals },
    '/api/v1/providers': { providers: [] },
    '/api/v1/agents/a1/queue': { items: o.queue ?? [] },
  };
}

describe('store + live', () => {
  it('a revoked session (bye) drops records and the resume cursor; the next sign-in loads afresh', async () => {
    const store = await import('./store.js');
    serve({ chats: ['c1'], approvals: [approval('ap1')] });
    store.live.start();
    await settle();
    const ws1 = FakeSocket.last!;
    expect(ws1.sent[0]).toEqual({ t: 'hello', v: 1 });
    ws1.frame({ t: 'welcome', serverId: 's', seq: 10, user: owner });
    await settle();
    ws1.frame({
      t: 'ev',
      seq: 11,
      topic: 'chat:c1',
      type: 'message.created',
      data: { id: 'm1', chatId: 'c1', authorKind: 'user', status: 'final', createdAt: 1, runId: null },
    });
    await settle();
    expect(store.getState().loaded).toBe(true);
    expect(Object.keys(store.getState().approvals)).toEqual(['ap1']);
    expect(store.getState().messages.c1).toHaveLength(1);
    expect(storage.get('pasabot.lastSeq')).toBe('11');

    ws1.frame({ t: 'bye', reason: 'session_revoked' });
    await settle();
    const s = store.getState();
    expect(s.me).toBeNull();
    expect(s.loaded).toBe(false);
    expect(s.agents).toEqual({});
    expect(s.chats).toEqual({});
    expect(s.messages).toEqual({});
    expect(s.approvals).toEqual({});
    expect(storage.has('pasabot.lastSeq')).toBe(false);
    expect(location.hash).toBe('#/login');

    // someone signs in again in this tab: no resume from the old cursor, everything reloads for the new user
    serve({ chats: ['c2'], approvals: [] });
    store.live.start();
    await settle();
    const ws2 = FakeSocket.last!;
    expect(ws2).not.toBe(ws1);
    expect(ws2.sent[0]).toEqual({ t: 'hello', v: 1 });
    ws2.frame({ t: 'welcome', serverId: 's', seq: 20, user: { ...owner, id: 'u-other' } });
    await settle();
    expect(Object.keys(store.getState().chats)).toEqual(['c2']);
    expect(store.getState().approvals).toEqual({});
    const sub = ws2.sent.find((f) => f.t === 'sub');
    expect(sub.topics).toContain('chat:c2');
    expect(sub.topics).not.toContain('chat:c1');
    store.resetStore();
  });

  it('gap: stale pending approvals and running runs go, chats made meanwhile get subscribed, cursor = welcome seq', async () => {
    const store = await import('./store.js');
    serve({ chats: ['c1'], approvals: [approval('ap1'), approval('ap2')] });
    store.live.start();
    await settle();
    const ws1 = FakeSocket.last!;
    ws1.frame({ t: 'welcome', serverId: 's', seq: 10, user: owner });
    await settle();
    ws1.frame({
      t: 'ev',
      seq: 12,
      topic: 'agent:a1',
      type: 'run.started',
      data: { id: 'r1', agentId: 'a1' },
    });
    ws1.frame({
      t: 'ev',
      seq: 13,
      topic: 'agent:a1',
      type: 'approval.resolved',
      data: approval('ap2', 'denied'),
    });
    ws1.frame({ t: 'live', topic: 'run:r1', type: 'message.delta', data: { messageId: 'm9', text: 'hal' } });
    await settle();
    expect(store.agentStatus(store.getState(), 'a1')).toBe('waiting');

    // the phone sleeps; ap1 is approved elsewhere, the run finishes, a new chat appears; resume is impossible
    ws1.onclose?.();
    serve({ chats: ['c1', 'c3'], approvals: [] });
    await new Promise((r) => setTimeout(r, 900));
    await settle();
    const ws2 = FakeSocket.last!;
    expect(ws2).not.toBe(ws1);
    expect(ws2.sent[0]).toEqual({ t: 'hello', v: 1, resumeFrom: 13 });
    ws2.frame({ t: 'welcome', serverId: 's', seq: 50, user: owner });
    ws2.frame({ t: 'gap', from: 13 });
    await settle();

    const s = store.getState();
    expect(s.approvals.ap1).toBeUndefined(); // no longer pending on the server
    expect(s.approvals.ap2?.state).toBe('denied'); // a decision already known stays
    expect(s.running.a1).toBeNull();
    expect(s.streams).toEqual({});
    expect(store.agentStatus(s, 'a1')).toBe('idle');
    expect(storage.get('pasabot.lastSeq')).toBe('50');
    const subs = ws2.sent.filter((f) => f.t === 'sub').flatMap((f) => f.topics);
    expect(subs).toContain('chat:c3');
    store.resetStore();
  });

  it('a finished run drops the live text still held for its reply', async () => {
    const store = await import('./store.js');
    serve({ chats: ['c1'], approvals: [] });
    store.live.start();
    await settle();
    const ws = FakeSocket.last!;
    ws.frame({ t: 'welcome', serverId: 's', seq: 10, user: owner });
    await settle();
    const ev = (seq: number, topic: string, type: string, data: unknown) =>
      ws.frame({ t: 'ev', seq, topic, type, data });
    ev(11, 'chat:c1', 'message.created', {
      id: 'm9',
      chatId: 'c1',
      authorKind: 'agent',
      authorId: 'a1',
      status: 'streaming',
      createdAt: 1,
      runId: 'r1',
      blocks: [],
    });
    ws.frame({
      t: 'live',
      topic: 'run:r1',
      type: 'message.delta',
      data: { messageId: 'm9', text: 'half a sen' },
    });
    await settle();
    expect(store.getState().streams.m9).toBe('half a sen');
    ev(12, 'agent:a1', 'run.finished', { id: 'r1', agentId: 'a1', state: 'interrupted' });
    await settle();
    expect(store.getState().streams).toEqual({});
    store.resetStore();
  });
  it('live frames the shell does not draw (browser.frame) are re-dispatched for module components', async () => {
    const seen: { type: string; data: unknown }[] = [];
    const target = new EventTarget();
    target.addEventListener('pasabot:event', (e) => seen.push((e as CustomEvent).detail));
    vi.stubGlobal('window', target);
    const store = await import('./store.js');
    serve({ chats: [], approvals: [] });
    store.live.start();
    await settle();
    const ws = FakeSocket.last!;
    ws.frame({ t: 'welcome', serverId: 's', seq: 1, user: owner });
    await settle();
    ws.frame({ t: 'live', topic: 'owner', type: 'browser.frame', data: { profileId: 'p1', data: 'AA==' } });
    expect(seen).toEqual([{ type: 'browser.frame', data: { profileId: 'p1', data: 'AA==' } }]);
    store.resetStore();
  });

  it('a chat load that answers after live updates never puts the older snapshot back', async () => {
    const store = await import('./store.js');
    const msg = (id: string, createdAt: number, body: string) => ({
      id,
      chatId: 'c1',
      authorKind: 'agent',
      authorId: null,
      replyTo: null,
      body,
      blocks: [],
      status: 'final',
      runId: null,
      createdAt,
      editedAt: null,
    });
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((r) => {
          answer = r;
        }),
    );
    const load = store.loadMessages('c1');
    // while the request is out: the first card is settled and a second message arrives
    store.upsertMessage({ ...msg('m1', 1, 'question 1'), editedAt: 5, body: 'answered' } as never);
    store.upsertMessage(msg('m2', 2, 'question 2') as never);
    answer(
      new Response(JSON.stringify({ messages: [msg('m0', 0, 'gone soon'), msg('m1', 1, 'question 1')] }), {
        status: 200,
      }),
    );
    await load;
    expect(store.getState().messages.c1?.map((m) => [m.id, m.body])).toEqual([
      ['m0', 'gone soon'],
      ['m1', 'answered'],
      ['m2', 'question 2'],
    ]);
    store.resetStore();
  });
});
