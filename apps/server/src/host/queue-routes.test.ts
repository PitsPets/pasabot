import { ulid } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

/** Queue REST and chat interrupts act on the caller's own items only (IDOR regression, ARCHITECTURE 3.1). */
describe('queue routes check the principal', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let ana: { id: string; token: string };
  let ben: { id: string; token: string };
  let agent: string;
  let shared: string;
  let secret: string;
  const call = (method: 'GET' | 'POST', path: string, token: string, body?: unknown) =>
    fetch(`${s.url}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const enqueue = (chatId: string, sender: { kind: string; id: string }) =>
    s.queue.enqueue({
      agentId: agent,
      chatId,
      kind: 'message',
      priority: 0,
      payload: { text: 'x' },
      source: { sender: { ...sender, name: sender.kind, trust: 'standard' } as never },
    }).item.id;

  beforeAll(async () => {
    s = await bootTestServer({ dispatcher: { autoStart: false } });
    owner = seedUser(s.db, 'owner', 'Owner');
    ana = seedUser(s.db, 'member', 'Ana');
    ben = seedUser(s.db, 'member', 'Ben');
    agent = seedAgent(s.db);
    shared = seedChat(s.db, { userIds: [owner.id, ana.id, ben.id], agentIds: [agent] });
    secret = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
  });
  afterAll(() => s.cleanup());

  it('a member sees only their own items in chats they belong to; the owner sees all', async () => {
    const mine = enqueue(shared, { kind: 'member', id: ana.id });
    const bens = enqueue(shared, { kind: 'member', id: ben.id });
    const owners = enqueue(secret, { kind: 'owner', id: owner.id });
    const list = (await (await call('GET', `/agents/${agent}/queue`, ana.token)).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).toEqual([mine]);
    const all = (await (await call('GET', `/agents/${agent}/queue`, owner.token)).json()) as {
      items: { id: string }[];
    };
    expect(all.items.map((i) => i.id)).toEqual(expect.arrayContaining([mine, bens, owners]));
  });

  it("a member cannot retry/skip/cancel someone else's item (404), only their own", async () => {
    const bens = enqueue(shared, { kind: 'member', id: ben.id });
    const owners = enqueue(secret, { kind: 'owner', id: owner.id });
    for (const verb of ['retry', 'skip', 'cancel']) {
      expect((await call('POST', `/queue/${bens}/${verb}`, ana.token)).status).toBe(404);
      expect((await call('POST', `/queue/${owners}/${verb}`, ana.token)).status).toBe(404);
    }
    expect(s.queue.get(bens)!.state).toBe('queued');
    expect(s.queue.get(owners)!.state).toBe('queued');
    const mine = enqueue(shared, { kind: 'member', id: ana.id });
    expect((await call('POST', `/queue/${mine}/cancel`, ana.token)).status).toBe(200);
    expect((await call('POST', `/queue/${bens}/cancel`, owner.token)).status).toBe(200);
  });

  it('pausing or resuming an agent queue is owner-only', async () => {
    expect((await call('POST', `/agents/${agent}/queue/pause`, ana.token)).status).toBe(403);
    expect(s.queue.isPaused(agent)).toBe(false);
    expect((await call('POST', `/agents/${agent}/queue/pause`, owner.token)).status).toBe(200);
    expect((await call('POST', `/agents/${agent}/queue/resume`, ana.token)).status).toBe(403);
    expect((await call('POST', `/agents/${agent}/queue/resume`, owner.token)).status).toBe(200);
  });

  it('removal from the chat ends access to your own items there', async () => {
    const mine = enqueue(shared, { kind: 'member', id: ben.id });
    s.db
      .prepare("DELETE FROM chat_members WHERE chat_id = ? AND member_kind = 'user' AND member_id = ?")
      .run(shared, ben.id);
    expect((await call('POST', `/queue/${mine}/cancel`, ben.token)).status).toBe(404);
    s.db
      .prepare(
        "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, 'user', ?, 'member')",
      )
      .run(shared, ben.id);
  });

  it("a member's interrupt does not cancel another member's running turn", async () => {
    const running = enqueue(shared, { kind: 'member', id: ana.id });
    s.orchestrator.running.set(shared, {
      runId: ulid(),
      agentId: agent,
      chatId: shared,
      adapter: {} as never,
      sender: { kind: 'member', id: ana.id, name: 'Ana', trust: 'standard' },
    } as never);
    const cancel = vi.spyOn(s.queue, 'cancel');
    try {
      const r = await call('POST', `/chats/${shared}/messages`, ben.token, {
        text: 'stop',
        mode: 'interrupt',
      });
      expect(r.status).toBe(201);
      expect(cancel).not.toHaveBeenCalled();
      expect(s.queue.get(running)!.state).toBe('queued');
    } finally {
      cancel.mockRestore();
      s.orchestrator.running.delete(shared);
    }
  });

  it('replyTo must name a message of the same chat', async () => {
    const hidden = ulid();
    s.db
      .prepare(
        "INSERT INTO messages (id, chat_id, author_kind, body, status, created_at) VALUES (?, ?, 'system', 'x', 'final', ?)",
      )
      .run(hidden, secret, Date.now());
    const r = await call('POST', `/chats/${shared}/messages`, ana.token, { text: 'hi', replyTo: hidden });
    expect(r.status).toBe(400);
  });
});
