/**
 * W23 done-criterion: a guest invited to one chat sees only it (on top of the W0b chat_members filtering), plus the
 * invite rules (single use, expiry, revoke, owner-only), per-chat roles, disabling, member agent import, and that
 * no other module can use the PeoplePort.
 */
import { asSystem, defineModule, type ModuleHost } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  FakeProvider,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { createPeopleModule } from './server.js';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.cleanup();
});

let clock = Date.now();
async function boot(extra: Parameters<typeof bootTestServer>[0] = {}) {
  clock = Date.now();
  const s = await bootTestServer({
    providers: [new FakeProvider({ deltaMs: 1 })],
    modules: [createPeopleModule({ now: () => clock }), ...(extra.modules ?? [])],
  });
  servers.push(s);
  const owner = seedUser(s.db, 'owner', 'Diwa');
  return { s, owner };
}
const api = (s: TestServer, token: string | null, path: string, init: RequestInit = {}) =>
  fetch(`${s.url}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
const json = (b: unknown) => JSON.stringify(b);

async function invite(s: TestServer, ownerToken: string, body: unknown) {
  const r = await api(s, ownerToken, '/api/m/people/invites', { method: 'POST', body: json(body) });
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; token: string; path: string; expiresAt: number };
}
async function accept(s: TestServer, token: string, displayName = 'Bisita', origin?: string) {
  return api(s, null, '/hooks/people/accept', {
    method: 'POST',
    body: json({ token, displayName, password: 'guest password 1' }),
    headers: origin ? { origin } : {},
  });
}

describe('people: invites and guests', () => {
  it('a guest invited to one chat sees only that chat (REST + WS)', async () => {
    const { s, owner } = await boot();
    const agent = seedAgent(s.db);
    const open = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
    const other = seedAgent(s.db);
    const hidden = seedChat(s.db, { userIds: [owner.id], agentIds: [other] });
    const inv = await invite(s, owner.token, { kind: 'guest', chats: [{ chatId: open, role: 'member' }] });
    expect(inv.path).toBe(`/#/join?invite=${inv.token}`);

    // the accept page's preview, then accept (no Origin = a native client gets the token in the body)
    const pre = await api(s, null, '/hooks/people/invite', {
      method: 'POST',
      body: json({ token: inv.token }),
    });
    expect(pre.status).toBe(200);
    expect(await pre.json()).toMatchObject({ kind: 'guest', invitedBy: 'Diwa', chats: [{ role: 'member' }] });
    const r = await accept(s, inv.token);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/pasabot_session=.*HttpOnly; Secure; SameSite=Strict/);
    const body = (await r.json()) as { user: { id: string; kind: string }; token: string };
    expect(body.user.kind).toBe('guest');
    const guest = body.token;

    const chats = (await (await api(s, guest, '/api/v1/chats')).json()) as { chats: { id: string }[] };
    expect(chats.chats.map((c) => c.id)).toEqual([open]);
    expect((await api(s, guest, `/api/v1/chats/${open}/messages`)).status).toBe(200);
    // only the agents of the guest's own chats, never the owner's whole team
    const agents = (await (await api(s, guest, '/api/v1/agents')).json()) as { agents: { id: string }[] };
    expect(agents.agents.map((a) => a.id)).toEqual([agent]);
    expect([403, 404]).toContain((await api(s, guest, `/api/v1/chats/${hidden}/messages`)).status);
    // the guest may write in the chat they were added to as a member
    const post = await api(s, guest, `/api/v1/chats/${open}/messages`, {
      method: 'POST',
      body: json({ text: 'hello from the guest' }),
    });
    expect(post.status).toBeLessThan(300);

    // WS: the hidden chat's topic is refused, the open one is not
    const ws = await connectWs(s.url);
    try {
      ws.send({ t: 'hello', v: 1, token: guest });
      await ws.next((f) => f.t === 'welcome');
      ws.send({ t: 'sub', topics: [`chat:${hidden}`, `chat:${open}`] });
      s.bus.publish(`chat:${hidden}`, 'notification', { level: 'info', text: 'secret' });
      s.bus.publish(`chat:${open}`, 'notification', { level: 'info', text: 'visible' });
      const ev = (await ws.next((f) => f.t === 'ev')) as { topic: string };
      expect(ev.topic).toBe(`chat:${open}`);
    } finally {
      ws.close();
    }

    // guests manage nothing and import no agents
    for (const [m, p] of [
      ['GET', '/api/m/people/people'],
      ['GET', '/api/m/people/invites'],
      ['GET', '/api/m/people/agents'],
      ['POST', `/api/m/people/agents/${agent}/open`],
    ] as const)
      expect((await api(s, guest, p, { method: m })).status).toBe(403);
    expect(
      (
        await api(s, guest, '/api/m/people/invites', {
          method: 'POST',
          body: json({ kind: 'member', chats: [] }),
        })
      ).status,
    ).toBe(403);
  });

  it('an invite is single use, expires, and can be revoked; a page gets the cookie only', async () => {
    const { s, owner } = await boot();
    const chat = seedChat(s.db, { userIds: [owner.id] });
    const a = await invite(s, owner.token, { kind: 'guest', chats: [{ chatId: chat, role: 'observer' }] });
    const first = await accept(s, a.token, 'Ana', s.url);
    expect(first.status).toBe(200);
    expect((await first.json()) as object).not.toHaveProperty('token'); // a page: HttpOnly cookie only
    expect((await accept(s, a.token, 'Ana again')).status).toBe(404); // replay

    const b = await invite(s, owner.token, { kind: 'member', chats: [], expiresInHours: 1 });
    clock += 2 * 3600_000;
    expect((await accept(s, b.token)).status).toBe(404); // expired
    clock = Date.now();

    const c = await invite(s, owner.token, { kind: 'member', chats: [] });
    expect((await api(s, owner.token, `/api/m/people/invites/${c.id}`, { method: 'DELETE' })).status).toBe(
      200,
    );
    expect((await accept(s, c.token)).status).toBe(404); // revoked

    // a guest invite must name a chat; a made-up chat is refused
    expect(
      (
        await api(s, owner.token, '/api/m/people/invites', {
          method: 'POST',
          body: json({ kind: 'guest', chats: [] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(s, owner.token, '/api/m/people/invites', {
          method: 'POST',
          body: json({ kind: 'guest', chats: [{ chatId: '01NOPE', role: 'member' }] }),
        })
      ).status,
    ).toBe(400);
    // a member invited by a seeded member session cannot mint invites either
    const m = seedUser(s.db, 'member', 'M');
    expect(
      (
        await api(s, m.token, '/api/m/people/invites', {
          method: 'POST',
          body: json({ kind: 'member', chats: [] }),
        })
      ).status,
    ).toBe(403);
    // control characters in a name are refused and the invite stays usable
    const d = await invite(s, owner.token, { kind: 'member', chats: [] });
    expect((await accept(s, d.token, 'Evil‮name')).status).toBe(400);
    expect((await accept(s, d.token, 'Fine name')).status).toBe(200);
    // the invite token is stored only as a hash
    const rows = s.db.prepare('SELECT token_hash FROM people_invite').all() as { token_hash: string }[];
    expect(rows.every((r) => r.token_hash !== a.token && r.token_hash.length === 64)).toBe(true);
  });

  it('an observer reads but cannot write; the owner changes roles, removes, and disables', async () => {
    const { s, owner } = await boot();
    const chat = seedChat(s.db, { userIds: [owner.id] });
    const inv = await invite(s, owner.token, { kind: 'guest', chats: [{ chatId: chat, role: 'observer' }] });
    const g = (await (await accept(s, inv.token, 'Lito')).json()) as { user: { id: string }; token: string };
    const write = () =>
      api(s, g.token, `/api/v1/chats/${chat}/messages`, { method: 'POST', body: json({ text: 'hi' }) });
    expect((await write()).status).toBe(403);

    const people = (await (await api(s, g.token, `/api/m/people/chats/${chat}/people`)).json()) as {
      people: { userId: string; role: string }[];
    };
    expect(people.people.map((p) => [p.userId, p.role])).toEqual([
      [owner.id, 'member'],
      [g.user.id, 'observer'],
    ]);

    expect(
      (
        await api(s, owner.token, `/api/m/people/chats/${chat}/people/${g.user.id}`, {
          method: 'PUT',
          body: json({ role: 'member' }),
        })
      ).status,
    ).toBe(200);
    expect((await write()).status).toBeLessThan(300);
    // the guest cannot promote anyone, nor change the owner
    expect(
      (
        await api(s, g.token, `/api/m/people/chats/${chat}/people/${g.user.id}`, {
          method: 'PUT',
          body: json({ role: 'member' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(s, owner.token, `/api/m/people/chats/${chat}/people/${owner.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(403);

    expect(
      (await api(s, owner.token, `/api/m/people/chats/${chat}/people/${g.user.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(200);
    const after = (await (await api(s, g.token, '/api/v1/chats')).json()) as { chats: unknown[] };
    expect(after.chats).toEqual([]);

    expect(
      (await api(s, owner.token, `/api/m/people/people/${g.user.id}/disable`, { method: 'POST' })).status,
    ).toBe(200);
    expect((await api(s, g.token, '/api/v1/me')).status).toBe(401); // every session ended
    expect(
      (await api(s, owner.token, `/api/m/people/people/${owner.id}/disable`, { method: 'POST' })).status,
    ).toBe(404); // never the owner
    const list = (await (await api(s, owner.token, '/api/m/people/people')).json()) as {
      people: { kind: string; disabledAt: number | null }[];
    };
    expect(list.people.map((p) => [p.kind, p.disabledAt !== null])).toEqual([
      ['owner', false],
      ['guest', true],
    ]);
    const audit = s.db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'people.%' ORDER BY at")
      .all() as {
      action: string;
    }[];
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['people.joined', 'people.chat_role', 'people.chat_removed', 'people.disabled']),
    );
  });

  it("the owner's agent list never carries the built-in team builder's internal prompt", async () => {
    const { s, owner } = await boot();
    const builder = seedAgent(s.db, { slug: 'tala' });
    const plain = seedAgent(s.db, { slug: 'lira' });
    s.db
      .prepare('UPDATE agents SET instructions = ? WHERE id = ?')
      .run('INTERNAL PROMPT: call orchestrator_answer', builder);
    s.db.prepare('UPDATE agents SET instructions = ? WHERE id = ?').run('Be kind.', plain);
    // the orchestrator module records its agent under this setting (ORCHESTRATOR_AGENT_SETTING)
    s.db
      .prepare("INSERT INTO settings (key, value) VALUES ('module:orchestrator:agentId', ?)")
      .run(JSON.stringify(builder));
    const r = await api(s, owner.token, '/api/m/people/agents');
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain('orchestrator_answer');
    const agents = (JSON.parse(text) as { agents: { id: string; instructions?: string }[] }).agents;
    expect(agents.find((a) => a.id === builder)?.instructions).toBe('');
    expect(agents.find((a) => a.id === plain)?.instructions).toBe('Be kind.');
  });

  it('members import shared agents into their own direct chat; never unshared ones', async () => {
    const { s, owner } = await boot();
    const shared = seedAgent(s.db, { slug: 'tala' });
    const secret = seedAgent(s.db, { slug: 'lihim' });
    const inv = await invite(s, owner.token, { kind: 'member', chats: [] });
    const m = (await (await accept(s, inv.token, 'Maya')).json()) as { user: { id: string }; token: string };
    expect(
      (
        await api(s, owner.token, `/api/m/people/agents/${shared}/share`, {
          method: 'PUT',
          body: json({ shared: true }),
        })
      ).status,
    ).toBe(200);
    const list = (await (await api(s, m.token, '/api/m/people/agents')).json()) as {
      agents: { id: string; instructions?: string }[];
    };
    expect(list.agents.map((a) => a.id)).toEqual([shared]);
    expect(list.agents[0]).not.toHaveProperty('instructions');
    expect((await api(s, m.token, `/api/m/people/agents/${secret}/open`, { method: 'POST' })).status).toBe(
      404,
    );
    const opened = (await (
      await api(s, m.token, `/api/m/people/agents/${shared}/open`, { method: 'POST' })
    ).json()) as {
      chatId: string;
    };
    const again = (await (
      await api(s, m.token, `/api/m/people/agents/${shared}/open`, { method: 'POST' })
    ).json()) as {
      chatId: string;
    };
    expect(again.chatId).toBe(opened.chatId);
    const chats = (await (await api(s, m.token, '/api/v1/chats')).json()) as { chats: { id: string }[] };
    expect(chats.chats.map((c) => c.id)).toEqual([opened.chatId]);
    // the member's own turn: the queue item's sender is the member, never the owner (7.4)
    const sent = await api(s, m.token, `/api/v1/chats/${opened.chatId}/messages`, {
      method: 'POST',
      body: json({ text: 'kumusta' }),
    });
    expect(sent.status).toBeLessThan(300);
    const src = s.db.prepare('SELECT source FROM queue_items WHERE chat_id = ?').get(opened.chatId) as {
      source: string;
    };
    expect(JSON.parse(src.source).sender).toMatchObject({ kind: 'member', id: m.user.id });
    // the owner sees the member's chat too (one owner, every chat)
    const ownerChats = (await (await api(s, owner.token, '/api/v1/chats')).json()) as {
      chats: { id: string }[];
    };
    expect(ownerChats.chats.map((c) => c.id)).toContain(opened.chatId);
  });

  describe('review fixes', () => {
    const until = async <T>(f: () => T | null | undefined | false, ms = 8000): Promise<T> => {
      const t0 = Date.now();
      for (;;) {
        const v = f();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const slow = (text: string) =>
      json({
        text: json({
          fakeScript: [
            { after: 20_000, event: { type: 'text.final', text } },
            { event: { type: 'done', stop: 'end' } },
          ],
        }),
        mode: 'queue',
      });
    async function memberWithDirect(extra: Parameters<typeof bootTestServer>[0] = {}) {
      const { s, owner } = await boot(extra);
      const agent = seedAgent(s.db, { slug: 'tala' });
      const inv = await invite(s, owner.token, { kind: 'member', chats: [] });
      const m = (await (await accept(s, inv.token, 'Maya')).json()) as {
        user: { id: string };
        token: string;
      };
      await api(s, owner.token, `/api/m/people/agents/${agent}/share`, {
        method: 'PUT',
        body: json({ shared: true }),
      });
      const { chatId } = (await (
        await api(s, m.token, `/api/m/people/agents/${agent}/open`, { method: 'POST' })
      ).json()) as { chatId: string };
      return { s, owner, agent, m, chatId };
    }
    const itemsOf = (s: TestServer, userId: string) =>
      s.db
        .prepare("SELECT state FROM queue_items WHERE json_extract(source, '$.sender.id') = ? ORDER BY seq")
        .all(userId) as { state: string }[];

    it("a member's direct chat is never the agent's own main chat, even with the owner's archived", async () => {
      let chats: ModuleHost['chats'] | null = null;
      const grab = defineModule({
        id: 'grab',
        register(app: ModuleHost) {
          chats = app.chats;
        },
      });
      const { s, owner } = await boot({ modules: [grab] });
      const agent = seedAgent(s.db, { slug: 'tala' });
      const mine = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
      expect(chats!.ownChat(agent)).toBe(mine);
      s.db.prepare('UPDATE chats SET archived_at = ? WHERE id = ?').run(Date.now(), mine);
      const inv = await invite(s, owner.token, { kind: 'member', chats: [] });
      const m = (await (await accept(s, inv.token, 'Maya')).json()) as {
        user: { id: string };
        token: string;
      };
      await api(s, owner.token, `/api/m/people/agents/${agent}/share`, {
        method: 'PUT',
        body: json({ shared: true }),
      });
      const { chatId } = (await (
        await api(s, m.token, `/api/m/people/agents/${agent}/open`, { method: 'POST' })
      ).json()) as { chatId: string };
      // a routine's "agent's own chat" lookup skips the member's chat and opens a fresh owner chat instead
      expect(chats!.ownChat(agent)).toBeNull();
      const fresh = chats!.ownChat(agent, { create: true });
      expect(fresh).not.toBe(chatId);
      expect(chats!.isMember(fresh!, { kind: 'user', id: m.user.id })).toBe(false);
      // a member chat made before the fix (no moduleChat flag) is skipped too
      s.db
        .prepare("UPDATE chats SET settings = json_remove(settings, '$.moduleChat') WHERE id = ?")
        .run(chatId);
      s.db.prepare('UPDATE chats SET archived_at = ? WHERE id = ?').run(Date.now(), fresh);
      expect(chats!.ownChat(agent)).toBeNull();
    });

    it('unsharing an agent cuts members off: their chat with it closes and their turns there stop', async () => {
      const { s, owner, agent, m, chatId } = await memberWithDirect();
      for (const t of ['one', 'two', 'three'])
        expect(
          (await api(s, m.token, `/api/v1/chats/${chatId}/messages`, { method: 'POST', body: slow(t) }))
            .status,
        ).toBeLessThan(300);
      await until(() => itemsOf(s, m.user.id).some((i) => i.state === 'running'));

      const r = await api(s, owner.token, `/api/m/people/agents/${agent}/share`, {
        method: 'PUT',
        body: json({ shared: false }),
      });
      expect(await r.json()).toEqual({ ok: true, closed: 1 });
      // every turn the member asked for there is cancelled (the running one aborted)
      await until(() => itemsOf(s, m.user.id).every((i) => i.state === 'cancelled'));
      // the member lost the chat, the agent, and cannot write there any more
      expect(((await (await api(s, m.token, '/api/v1/chats')).json()) as { chats: unknown[] }).chats).toEqual(
        [],
      );
      expect(
        ((await (await api(s, m.token, '/api/v1/agents')).json()) as { agents: unknown[] }).agents,
      ).toEqual([]);
      expect((await api(s, m.token, `/api/v1/agents/${agent}`)).status).toBe(404);
      expect([403, 404]).toContain(
        (
          await api(s, m.token, `/api/v1/chats/${chatId}/messages`, {
            method: 'POST',
            body: json({ text: 'hi' }),
          })
        ).status,
      );
      expect((await api(s, m.token, `/api/m/people/agents/${agent}/open`, { method: 'POST' })).status).toBe(
        404,
      );
      // the owner keeps the history (archived)
      expect((await api(s, owner.token, `/api/v1/chats/${chatId}/messages`)).status).toBe(200);
      // sharing again gives the member a new chat
      await api(s, owner.token, `/api/m/people/agents/${agent}/share`, {
        method: 'PUT',
        body: json({ shared: true }),
      });
      const again = (await (
        await api(s, m.token, `/api/m/people/agents/${agent}/open`, { method: 'POST' })
      ).json()) as { chatId: string };
      expect(again.chatId).not.toBe(chatId);
    });

    it("disabling a person cancels their queued and running turns; the queue refuses a disabled sender's item", async () => {
      const { s, owner, m, chatId } = await memberWithDirect();
      for (const t of ['one', 'two', 'three'])
        await api(s, m.token, `/api/v1/chats/${chatId}/messages`, { method: 'POST', body: slow(t) });
      await until(() => itemsOf(s, m.user.id).some((i) => i.state === 'running'));
      expect(itemsOf(s, m.user.id)).toHaveLength(3);
      expect(
        (await api(s, owner.token, `/api/m/people/people/${m.user.id}/disable`, { method: 'POST' })).status,
      ).toBe(200);
      await until(() => itemsOf(s, m.user.id).every((i) => i.state === 'cancelled'));
      const replies = s.db
        .prepare("SELECT body FROM messages WHERE chat_id = ? AND author_kind = 'agent' AND status = 'final'")
        .all(chatId);
      expect(replies).toEqual([]);

      // the dispatch-time check: an item whose member sender (or origin) is disabled never runs
      const row = (src: unknown) =>
        ({ id: 'x', agent_id: 'a', kind: 'chat', payload: '{}', source: json(src) }) as Parameters<
          typeof s.queue.admitRefusal
        >[0];
      expect(s.queue.admitRefusal(row({ sender: { kind: 'member', id: m.user.id } }))).toMatch(/turned off/);
      expect(
        s.queue.admitRefusal(
          row({ sender: { kind: 'agent', id: 'ag' }, origin: { kind: 'member', id: m.user.id } }),
        ),
      ).toMatch(/turned off/);
      expect(s.queue.admitRefusal(row({ sender: { kind: 'owner', id: owner.id } }))).toBeNull();
      // turned back on, their items run again
      await api(s, owner.token, `/api/m/people/people/${m.user.id}/enable`, { method: 'POST' });
      expect(s.queue.admitRefusal(row({ sender: { kind: 'member', id: m.user.id } }))).toBeNull();
    });
  });

  it('no other module can use the PeoplePort', async () => {
    let caught: unknown = null;
    const spy = defineModule({
      id: 'spy',
      register(app: ModuleHost) {
        try {
          app.people.signIn(asSystem('spy'), 'x', { ip: '', userAgent: '' });
        } catch (e) {
          caught = e;
        }
      },
    });
    await boot({ modules: [spy] });
    expect((caught as { code?: string })?.code).toBe('people_forbidden');
  });
});
