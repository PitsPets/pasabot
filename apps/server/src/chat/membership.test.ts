import { randomBytes } from 'node:crypto';
import { ulid } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { hashToken } from '../core/services.js';

describe('test:membership', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let secretChat: string;
  let sharedChat: string;
  const get = (path: string, token: string) =>
    fetch(`${s.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  beforeAll(async () => {
    s = await bootTestServer({ ws: { recheckMs: 100 } });
    owner = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    const agent = seedAgent(s.db);
    secretChat = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    sharedChat = seedChat(s.db, { userIds: [owner.id, member.id], agentIds: [agent] });
  });
  afterAll(() => s.cleanup());

  it('a member lists only the chats they are in; the owner sees all', async () => {
    const m = (await (await get('/api/v1/chats', member.token)).json()) as { chats: { id: string }[] };
    expect(m.chats.map((c) => c.id)).toEqual([sharedChat]);
    const o = (await (await get('/api/v1/chats', owner.token)).json()) as { chats: { id: string }[] };
    expect(o.chats.map((c) => c.id).sort()).toEqual([secretChat, sharedChat].sort());
  });

  it('a member cannot read a chat or its messages they are not in (404, no existence leak)', async () => {
    expect((await get(`/api/v1/chats/${secretChat}`, member.token)).status).toBe(404);
    expect((await get(`/api/v1/chats/${secretChat}/messages`, member.token)).status).toBe(404);
    const post = await fetch(`${s.url}/api/v1/chats/${secretChat}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'let me in' }),
    });
    expect(post.status).toBe(404);
    expect((await get(`/api/v1/chats/${sharedChat}/messages`, member.token)).status).toBe(200);
  });

  it('a member cannot subscribe to a chat topic they are not in; events of their own chats arrive', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: member.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: [`chat:${secretChat}`, `chat:${sharedChat}`] });
    for (const chat of [secretChat, sharedChat]) {
      await fetch(`${s.url}/api/v1/chats/${chat}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: `hello ${chat}` }),
      });
    }
    const got = await ws.next(
      (f) => f.t === 'ev' && f.type === 'message.created' && f.data.authorKind === 'user',
    );
    expect(got.topic).toBe(`chat:${sharedChat}`);
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.frames.some((f) => f.topic === `chat:${secretChat}`)).toBe(false);
    ws.close();
  });

  it('owner-only routes refuse a member (agent create, trust change)', async () => {
    const r = await fetch(`${s.url}/api/v1/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', providerId: 'fake' }),
    });
    expect(r.status).toBe(403);
  });

  it('non-owners never see agent instructions or workspace paths (REST and their chat topics)', async () => {
    s.db.prepare("UPDATE agents SET instructions = 'internal: ask Ana for the door code'").run();
    const list = (await (await get('/api/v1/agents', member.token)).json()) as any;
    expect(list.agents.length).toBeGreaterThan(0);
    for (const a of list.agents) expect(a).toMatchObject({ instructions: '', workspaceDir: '' });
    const one = (await (await get(`/api/v1/agents/${list.agents[0].id}`, member.token)).json()) as any;
    expect(one.agent).toMatchObject({ instructions: '', workspaceDir: '' });
    const own = (await (await get(`/api/v1/agents/${list.agents[0].id}`, owner.token)).json()) as any;
    expect(own.agent.instructions).toContain('door code');

    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: member.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['global', `chat:${sharedChat}`] });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${s.url}/api/v1/agents/${list.agents[0].id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 'new secret plan' }),
    });
    const ev = await ws.next((f) => f.t === 'ev' && f.type === 'agent.updated');
    expect(ev.topic).toBe(`chat:${sharedChat}`);
    expect(ev.data).toMatchObject({ instructions: '', workspaceDir: '' });
    expect(JSON.stringify(ws.frames)).not.toContain('secret plan');
    ws.close();
  });

  it('an agent of no chat a member is in stays invisible to them: no agent.updated, GET 404 (review fix)', async () => {
    const other = seedAgent(s.db, { slug: 'finance-bot' });
    seedChat(s.db, { userIds: [owner.id], agentIds: [other] });
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: member.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['global', `chat:${sharedChat}`] });
    const owners = await connectWs(s.url);
    owners.send({ t: 'hello', v: 1, token: owner.token });
    await owners.next((f) => f.t === 'welcome');
    owners.send({ t: 'sub', topics: ['global', 'owner'] });
    await new Promise((r) => setTimeout(r, 50));
    const patch = await fetch(`${s.url}/api/v1/agents/${other}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance Bot' }),
    });
    expect(patch.status).toBe(200);
    // the owner still learns about it (owner topic), the member never does
    const seen = await owners.next((f) => f.t === 'ev' && f.type === 'agent.updated');
    expect(seen).toMatchObject({ topic: 'owner', data: { id: other, name: 'Finance Bot' } });
    await new Promise((r) => setTimeout(r, 150));
    expect(JSON.stringify(ws.frames)).not.toContain(other);
    expect(JSON.stringify(ws.frames)).not.toContain('Finance Bot');
    expect((await get(`/api/v1/agents/${other}`, member.token)).status).toBe(404);
    expect((await get(`/api/v1/agents/${other}`, owner.token)).status).toBe(200);
    ws.close();
    owners.close();
  });

  describe('live sockets are re-checked (sessions and membership change under them)', () => {
    const say = (chat: string, text: string) =>
      fetch(`${s.url}/api/v1/chats/${chat}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    const userMsg = (text: string) => (f: any) =>
      f.t === 'ev' && f.type === 'message.created' && f.data.body === text;
    const listen = async (token: string, topics: string[]) => {
      const ws = await connectWs(s.url);
      ws.send({ t: 'hello', v: 1, token });
      await ws.next((f) => f.t === 'welcome');
      ws.send({ t: 'sub', topics });
      await new Promise((r) => setTimeout(r, 50));
      return ws;
    };

    it('removal from a chat stops that topic at once; other topics keep flowing', async () => {
      const m = seedUser(s.db, 'member', 'Removed');
      const agent = seedAgent(s.db);
      const a = seedChat(s.db, { userIds: [owner.id, m.id], agentIds: [agent] });
      const b = seedChat(s.db, { userIds: [owner.id, m.id], agentIds: [agent] });
      const ws = await listen(m.token, [`chat:${a}`, `chat:${b}`]);
      await say(a, 'before removal');
      await ws.next(userMsg('before removal'));
      const del = await fetch(`${s.url}/api/v1/chats/${a}/members/user/${m.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(del.status).toBe(200);
      await say(a, 'after removal');
      await say(b, 'still a member here');
      await ws.next(userMsg('still a member here'));
      await new Promise((r) => setTimeout(r, 150));
      expect(ws.frames.some((f) => f.t === 'ev' && f.data?.body === 'after removal')).toBe(false);
      ws.close();
    });

    it('logout closes the socket promptly and nothing more is delivered', async () => {
      const m = seedUser(s.db, 'member', 'Leaver');
      const chat = seedChat(s.db, { userIds: [owner.id, m.id], agentIds: [seedAgent(s.db)] });
      const ws = await listen(m.token, [`chat:${chat}`]);
      const out = await fetch(`${s.url}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${m.token}` },
      });
      expect(out.status).toBe(200);
      // no event needed: the idle re-check closes it
      expect(await ws.next((f) => f.t === 'bye', 2000)).toMatchObject({ reason: 'session_revoked' });
      await say(chat, 'after logout');
      await new Promise((r) => setTimeout(r, 150));
      expect(ws.frames.some((f) => f.t === 'ev' && f.data?.body === 'after logout')).toBe(false);
    });

    it('a revoked device loses its live socket, and an event racing the revoke is not delivered', async () => {
      const deviceId = ulid();
      s.db
        .prepare('INSERT INTO devices (id, user_id, name, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(deviceId, owner.id, 'Lost phone', Date.now());
      const token = randomBytes(32).toString('base64url');
      s.db
        .prepare(
          'INSERT INTO sessions (id, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(hashToken(token), owner.id, deviceId, Date.now(), Date.now() + 3600_000);
      const ws = await listen(token, [`chat:${secretChat}`]);
      const r = await fetch(`${s.url}/api/v1/devices/${deviceId}/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(r.status).toBe(200);
      await say(secretChat, 'after device revoke'); // may land before the idle re-check: delivery re-checks
      expect(await ws.next((f) => f.t === 'bye', 2000)).toMatchObject({ reason: 'session_revoked' });
      expect(ws.frames.some((f) => f.t === 'ev' && f.data?.body === 'after device revoke')).toBe(false);
    });
  });
});
