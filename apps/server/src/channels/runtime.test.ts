/**
 * W4b binding runtime against the reference FakeChannel (no network, no accounts): inbound → agent reply out,
 * strangers dropped + counted, link codes, owner trust cap, approvals, restart without duplicates.
 */
import type { ChannelAdapter, InboundMessage, TurnInput } from '@pasabot/core';
import { echoScript, FakeProvider, type Script } from '@pasabot/provider-fake';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelsModule } from '../../../../modules/channels/src/server.js';
import {
  bootTestServer,
  FakeChannel,
  FakeChannelPlatform,
  seedAgent,
  seedUser,
  type TestServer,
  tempHome,
} from '../../../../packages/testkit/src/index.js';
import { approvalShortId, CHANNEL_TEXT } from './runtime.js';

/** A FakeChannel platform that can redeliver a message it already delivered (what a platform does after a restart). */
class ReplayPlatform extends FakeChannelPlatform {
  readonly seen: InboundMessage[] = [];
  private mine = new Set<(m: InboundMessage) => void>();
  override listen(fn: (m: InboundMessage) => void) {
    const wrapped = (m: InboundMessage) => {
      this.seen.push(m);
      fn(m);
    };
    this.mine.add(fn);
    const off = super.listen(wrapped);
    return () => {
      this.mine.delete(fn);
      return off();
    };
  }
  replay(m: InboundMessage) {
    for (const l of this.mine) l(m);
  }
}

const script = (input: TurnInput): Script => {
  const t = input.user.text;
  const done = { event: { type: 'done', stop: 'end' } } as const;
  if (t.includes('NEED_T3'))
    return [
      { expectPermission: { tool: 'Write', input: { file_path: '/etc/pasabot-x' }, decision: 'deny' } },
      { event: { type: 'text.final', text: 'no write' } },
      done,
    ];
  if (t.includes('NEED_DIARY'))
    return [
      { expectPermission: { tool: 'Bash', input: { command: 'cat ~/owner-diary.txt' }, decision: 'allow' } },
      { event: { type: 'text.final', text: 'done reading' } },
      done,
    ];
  if (t.includes('NEED_T2'))
    return [
      { expectPermission: { tool: 'Bash', input: { command: 'ls' }, decision: 'allow' } },
      { event: { type: 'text.final', text: 'ran it' } },
      done,
    ];
  if (t.includes('SIGNED_OUT'))
    return [
      { event: { type: 'error', kind: 'auth', message: 'Not logged in. Please run /login' } },
      { event: { type: 'done', stop: 'error' } },
    ];
  if (t.includes('SLOW')) return [{ after: 60_000, event: { type: 'text.final', text: 'late' } }, done];
  const m = /```\n([\s\S]*?)\n```/.exec(t);
  return echoScript((m?.[1] ?? t).slice(0, 40), 1);
};

let open: TestServer[] = [];
afterEach(async () => {
  for (const s of open) await s.cleanup().catch(() => {});
  open = [];
});

async function boot(platform: ReplayPlatform, home?: string) {
  const s = await bootTestServer({
    modules: [createChannelsModule()],
    providers: [new FakeProvider({ script, deltaMs: 1 })],
    channels: [new FakeChannel(platform)],
    channelRuntime: { backoffBaseMs: 20, backoffMaxMs: 100, editMs: 5, statusPollMs: 20, previewMax: 60 },
    dispatcher: { pollMs: 5 },
    ...(home ? { home } : {}),
  });
  open.push(s);
  return s;
}
async function until<T>(
  f: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  ms = 5000,
) {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const api = (s: TestServer, token: string, method: string, path: string, body?: unknown) =>
  fetch(`${s.url}/api/m/channels${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

interface Ctx {
  s: TestServer;
  p: ReplayPlatform;
  owner: { id: string; token: string };
  agent: string;
  binding: string;
}
async function setup(
  o: { trust?: 'guarded' | 'standard' | 'trusted'; allowed?: string[] } = {},
): Promise<Ctx> {
  const p = new ReplayPlatform();
  const s = await boot(p);
  const owner = seedUser(s.db);
  const agent = seedAgent(s.db, { trust: o.trust ?? 'trusted' });
  const r = await api(s, owner.token, 'POST', '/bindings', {
    kind: 'fake',
    agentId: agent,
    secrets: { token: p.token },
    ...(o.allowed ? { allowedSenders: o.allowed } : {}),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const binding = ((await r.json()) as { binding: { id: string } }).binding.id;
  await until(() => statusOf(s, binding) === 'connected');
  return { s, p, owner, agent, binding };
}
const statusOf = (s: TestServer, id: string) =>
  (s.db.prepare('SELECT status FROM channels_binding WHERE id = ?').get(id) as { status: string } | undefined)
    ?.status;
const items = (s: TestServer) =>
  s.db.prepare("SELECT * FROM queue_items WHERE kind = 'message' ORDER BY created_at").all() as any[];

async function link(c: Ctx) {
  const r = await api(c.s, c.owner.token, 'POST', `/bindings/${c.binding}/link`);
  const { code } = (await r.json()) as { code: string };
  await c.p.deliver({ from: 'owner', place: 'dm', text: `/link ${code}` });
  await until(() => c.p.botTexts(c.p.places.dm).some((t) => t.startsWith('Linked.')));
  return code;
}
const replyDone = (c: Ctx, place: string, needle: string) =>
  until(() => c.p.botTexts(place).some((t) => t.includes(needle)));

describe('channel binding runtime', () => {
  it('notify transport: via channel:<id> goes to the owner DM only; unlinked / unknown bindings reject', async () => {
    const c = await setup();
    // nobody linked yet: nothing is sent and the caller hears why
    await expect(
      c.s.notifier.notify({ level: 'info', title: 'Digest', body: 'x', via: [`channel:${c.binding}`] }),
    ).rejects.toThrow(/no owner is linked/);
    await expect(
      c.s.notifier.notify({ level: 'info', title: 'Digest', via: ['channel:nope'] }),
    ).rejects.toThrow(/does not exist/);
    await link(c);
    await c.s.notifier.notify({
      level: 'info',
      title: 'Digest',
      body: 'three new things',
      via: [`channel:${c.binding}`],
    });
    expect(c.p.botTexts(c.p.places.dm)).toContain('Digest\nthree new things');
    // a notification without `via` never reaches the channel
    await c.s.notifier.notify({ level: 'info', title: 'In-app only' });
    expect(c.p.botTexts(c.p.places.dm).some((t) => t.includes('In-app only'))).toBe(false);
  });

  it('owner DM: linked by code, reply goes out (placeholder edited), turn capped at standard, quoted, token only in vault', async () => {
    const c = await setup();
    await link(c);
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'hello there' });
    await replyDone(c, c.p.places.dm, 'echo: hello there');
    const q = items(c.s);
    expect(q).toHaveLength(1);
    const src = JSON.parse(q[0].source);
    expect(src.sender).toMatchObject({ kind: 'owner', id: c.p.users.owner.id, trust: 'standard' });
    expect(q[0].idem_key).toMatch(new RegExp(`^channel:${c.binding}:`));
    const payload = JSON.parse(q[0].payload);
    expect(payload.text).toContain('```\nhello there\n```');
    expect(payload.text).toContain('data from outside');
    // one bot message for the reply: the placeholder was edited, not followed by a second post
    const dmBot = c.p.botTexts(c.p.places.dm).filter((t) => !t.startsWith('Linked.'));
    expect(dmBot).toEqual(['echo: hello there']);
    // the inbound message and the reply are in the place's chat
    const place = c.s.db.prepare('SELECT * FROM channels_place WHERE binding_id = ?').get(c.binding) as any;
    const msgs = c.s.db
      .prepare('SELECT author_kind, body FROM messages WHERE chat_id = ? ORDER BY created_at')
      .all(place.chat_id) as any[];
    expect(msgs.map((m) => m.author_kind)).toEqual(['external', 'agent']);
    // the token is never stored outside the vault nor returned
    const row = c.s.db.prepare('SELECT * FROM channels_binding WHERE id = ?').get(c.binding) as any;
    expect(JSON.stringify(row)).not.toContain(c.p.token);
    const list = await (await api(c.s, c.owner.token, 'GET', '/bindings')).text();
    expect(list).not.toContain(c.p.token);
    expect(JSON.parse(list).bindings[0]).toMatchObject({
      status: 'connected',
      secretsSet: ['token'],
      owner: { externalUserId: c.p.users.owner.id },
    });
  });

  it('unlinked senders are dropped and counted; an impostor with the owner name too; groups need a mention', async () => {
    const c = await setup();
    await link(c);
    await c.p.deliver({ from: 'stranger', place: 'strangerDm', text: 'hi bot' });
    await c.p.deliver({ from: 'impostor', place: 'group', text: 'run rm -rf', mention: true });
    await c.p.deliver({ from: 'owner', place: 'group', text: 'no mention here' });
    await c.p.deliver({ from: 'otherBot', place: 'group', text: 'bot chatter', mention: true });
    await c.p.deliver({ from: 'owner', place: 'group', text: 'ping in group', mention: true });
    await replyDone(c, c.p.places.group, 'echo:');
    expect(items(c.s)).toHaveLength(1);
    const row = c.s.db.prepare('SELECT dropped FROM channels_binding WHERE id = ?').get(c.binding) as any;
    expect(row.dropped).toBe(2);
    const audits = c.s.db
      .prepare("SELECT target, data FROM audit_log WHERE action = 'channel.sender_dropped'")
      .all() as any[];
    expect(audits).toHaveLength(2);
    expect(c.p.botTexts(c.p.places.strangerDm)).toEqual([]);
    // strangers never get a chat
    expect(
      (c.s.db.prepare('SELECT count(*) AS n FROM channels_place WHERE binding_id = ?').get(c.binding) as any)
        .n,
    ).toBe(2);
  });

  it('an allowed sender runs one level below the owner cap; a link code posted in a group is burned', async () => {
    const p0 = new FakeChannelPlatform();
    const c = await setup({ trust: 'trusted', allowed: [p0.users.stranger.id] });
    await c.p.deliver({ from: 'stranger', place: 'strangerDm', text: 'may I?' });
    await replyDone(c, c.p.places.strangerDm, 'echo: may I?');
    expect(JSON.parse(items(c.s)[0].source).sender).toMatchObject({ kind: 'external', trust: 'guarded' });

    const r = await api(c.s, c.owner.token, 'POST', `/bindings/${c.binding}/link`);
    const { code } = (await r.json()) as { code: string };
    await c.p.deliver({ from: 'owner', place: 'group', text: `/link ${code}` });
    await until(() =>
      c.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'channel.link_code_exposed'").get(),
    );
    await c.p.deliver({ from: 'owner', place: 'dm', text: `/link ${code}` });
    await until(() => c.p.botTexts(c.p.places.dm).includes(CHANNEL_TEXT.linkInvalid));
    expect(c.s.db.prepare("SELECT 1 FROM channels_sender WHERE trust = 'owner'").get()).toBeUndefined();
  });

  it('approvals: tier 2 answerable by the owner in the channel; tier 3 only on a paired device', async () => {
    const c = await setup();
    await link(c);
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'please NEED_T2' });
    const ask = (await until(() =>
      c.p.botTexts(c.p.places.dm).find((t) => t.startsWith('Approval needed')),
    )) as string;
    const short = /\/approve (\w+)/.exec(ask)![1]!;
    // quoting the command inside a question is a normal message, never an answer
    await c.p.deliver({ from: 'owner', place: 'dm', text: `what does /approve ${short} do?` });
    await c.p.deliver({ from: 'owner', place: 'dm', text: `${ask}\nok?` });
    await until(() => items(c.s).length === 3);
    expect(c.s.db.prepare("SELECT 1 FROM approvals WHERE state = 'pending'").get()).toBeTruthy();
    expect(c.p.botTexts(c.p.places.dm)).not.toContain(CHANNEL_TEXT.approved(short));
    // the whole message, after an optional leading bot mention, is the answer
    await c.p.deliver({ from: 'owner', place: 'dm', text: `@pasabot_bot /approve ${short}` });
    await replyDone(c, c.p.places.dm, 'ran it');
    expect(c.p.botTexts(c.p.places.dm)).toContain(CHANNEL_TEXT.approved(short));

    await c.p.deliver({ from: 'owner', place: 'dm', text: 'now NEED_T3' });
    const ask3 = (await until(() =>
      c.p.botTexts(c.p.places.dm).find((t) => t.includes('only be approved in the PasaBot app')),
    )) as string;
    expect(ask3).not.toContain('/approve');
    const pending = (await until(() =>
      c.s.db.prepare("SELECT id, tier FROM approvals WHERE state = 'pending'").get(),
    )) as { id: string; tier: number };
    expect(pending.tier).toBe(3);
    await c.p.deliver({ from: 'owner', place: 'dm', text: `/approve ${approvalShortId(pending.id)}` });
    await until(() => c.p.botTexts(c.p.places.dm).includes(CHANNEL_TEXT.approvalDeviceOnly));
    expect((c.s.db.prepare('SELECT state FROM approvals WHERE id = ?').get(pending.id) as any).state).toBe(
      'pending',
    );
    c.s.approvals.decide(pending.id, 'denied', c.owner.id);
    await replyDone(c, c.p.places.dm, 'no write');
  });

  it('an approval asked in a group, or for someone else in a direct chat, goes out as the neutral line only', async () => {
    const p0 = new FakeChannelPlatform();
    const c = await setup({ trust: 'trusted', allowed: [p0.users.stranger.id] });
    await link(c);
    const neutral = 'Agent is waiting for the owner’s OK.';
    const leaks = (t: string) =>
      t.startsWith('Approval needed') ||
      t.includes('owner-diary') ||
      t.includes('Bash') ||
      t.includes('/approve');
    for (const [from, place, mention] of [
      ['owner', 'group', true],
      ['stranger', 'strangerDm', false],
    ] as const) {
      await c.p.deliver({ from, place, text: 'please NEED_DIARY', ...(mention ? { mention } : {}) });
      const pending = (await until(() =>
        c.s.db.prepare("SELECT id FROM approvals WHERE state = 'pending'").get(),
      )) as { id: string };
      const name = (c.s.db.prepare('SELECT name FROM agents WHERE id = ?').get(c.agent) as { name: string })
        .name;
      await until(() => c.p.botTexts(c.p.places[place]).includes(neutral.replace('Agent', name)));
      expect(c.p.botTexts(c.p.places[place]).some(leaks)).toBe(false);
      // the owner answers in the app; the helper goes on
      c.s.approvals.decide(pending.id, 'approved', c.owner.id);
      await replyDone(c, c.p.places[place], 'done reading');
      expect(c.p.botTexts(c.p.places[place]).some(leaks)).toBe(false);
    }
    // the owner's own direct chat still gets the whole prompt with its id
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'please NEED_DIARY' });
    await until(() =>
      c.p.botTexts(c.p.places.dm).some((t) => t.startsWith('Approval needed') && t.includes('/approve')),
    );
    const pending = c.s.db.prepare("SELECT id FROM approvals WHERE state = 'pending'").get() as {
      id: string;
    };
    c.s.approvals.decide(pending.id, 'approved', c.owner.id);
    await replyDone(c, c.p.places.dm, 'done reading');
  });

  it('a failed reply goes out as the plain failed line only: never the owner’s card, its words or the raw error', async () => {
    const c = await setup();
    await link(c);
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'SIGNED_OUT please' });
    const place = c.s.db.prepare('SELECT * FROM channels_place WHERE binding_id = ?').get(c.binding) as any;
    // the owner's card is on the reply in the app
    await until(() =>
      (
        c.s.db
          .prepare("SELECT blocks FROM messages WHERE chat_id = ? AND author_kind = 'agent'")
          .all(place.chat_id) as { blocks: string }[]
      ).some((m) => m.blocks.includes('core.card')),
    );
    await until(() => c.p.botTexts(c.p.places.dm).some((t) => t.includes(CHANNEL_TEXT.failed)));
    await new Promise((r) => setTimeout(r, 100));
    const out = c.p.botTexts(c.p.places.dm).filter((t) => !t.startsWith('Linked.'));
    expect(out.at(-1)).toBe(CHANNEL_TEXT.failed);
    for (const t of out) {
      expect(t).not.toContain('Not logged in');
      expect(t).not.toContain('sign in');
      expect(t).not.toContain('core.card');
    }
  });

  it('a turn typed in the web app in a channel chat stays in the app: no reply and no approval prompt go out', async () => {
    const c = await setup({ trust: 'standard' });
    await link(c);
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'from the phone' });
    await replyDone(c, c.p.places.dm, 'echo: from the phone');
    const before = c.p.botTexts(c.p.places.dm);
    const chatId = (
      c.s.db.prepare('SELECT chat_id FROM channels_place WHERE binding_id = ?').get(c.binding) as {
        chat_id: string;
      }
    ).chat_id;
    const r = await fetch(`${c.s.url}/api/v1/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'my bank balance NEED_T2' }),
    });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    const pending = (await until(() =>
      c.s.db.prepare("SELECT id FROM approvals WHERE state = 'pending'").get(),
    )) as { id: string };
    c.s.approvals.decide(pending.id, 'approved', c.owner.id);
    const reply = (await until(() =>
      c.s.db
        .prepare(
          "SELECT id FROM messages WHERE chat_id = ? AND author_kind = 'agent' AND status = 'final' AND body = 'ran it'",
        )
        .get(chatId),
    )) as { id: string };
    await new Promise((res) => setTimeout(res, 100));
    expect(c.p.botTexts(c.p.places.dm)).toEqual(before);
    expect(
      c.s.db.prepare('SELECT 1 FROM channels_delivery WHERE message_id = ?').get(reply.id),
    ).toBeUndefined();
  });

  it('switching the binding to another agent gives the place a new chat owned by that agent', async () => {
    const c = await setup();
    await link(c);
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'to agent A' });
    await replyDone(c, c.p.places.dm, 'echo: to agent A');
    const placeChat = () =>
      (
        c.s.db.prepare('SELECT chat_id FROM channels_place WHERE binding_id = ?').get(c.binding) as {
          chat_id: string;
        }
      ).chat_id;
    const oldChat = placeChat();
    const agentB = seedAgent(c.s.db, { slug: 'agent-b', trust: 'trusted' });
    const conn0 = c.s.channelRuntime.connection(c.binding);
    const r = await api(c.s, c.owner.token, 'PATCH', `/bindings/${c.binding}`, { agentId: agentB });
    expect(r.status).toBe(200);
    await until(() => {
      const now = c.s.channelRuntime.connection(c.binding);
      return now && now !== conn0 && statusOf(c.s, c.binding) === 'connected';
    });
    await c.p.deliver({ from: 'owner', place: 'dm', text: 'to agent B' });
    await replyDone(c, c.p.places.dm, 'echo: to agent B');
    const newChat = placeChat();
    expect(newChat).not.toBe(oldChat);
    const chat = c.s.db.prepare('SELECT task_owner_agent_id FROM chats WHERE id = ?').get(newChat) as any;
    expect(chat.task_owner_agent_id).toBe(agentB);
    const agents = c.s.db
      .prepare("SELECT member_id FROM chat_members WHERE chat_id = ? AND member_kind = 'agent'")
      .all(newChat) as any[];
    expect(agents.map((a) => a.member_id)).toEqual([agentB]);
    const q = items(c.s);
    expect(q.at(-1)).toMatchObject({ agent_id: agentB, chat_id: newChat });
    // the old conversation stays as history; the new agent does not inherit it
    expect(c.s.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(oldChat)).toBeTruthy();
    expect(
      (c.s.db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').get(newChat) as any).n,
    ).toBe(2);
    expect(
      c.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'channel.place_agent_changed'").get(),
    ).toBeTruthy();
  });

  it('a stream that ends at once is a failed attempt: the backoff keeps growing, no reconnect storm', async () => {
    let connects = 0;
    const flaky: ChannelAdapter<{ token: string }> = {
      kind: 'flaky',
      configSchema: new FakeChannel().configSchema,
      secretFields: ['token'],
      async connect() {
        connects++;
        return {
          inbound: (async function* () {})(),
          send: async () => ({ externalId: 'x' }),
          listPlaces: async () => [],
          status: () => 'connected',
          close: async () => {},
        };
      },
    };
    const s = await bootTestServer({
      modules: [createChannelsModule()],
      providers: [new FakeProvider({ script, deltaMs: 1 })],
      channels: [flaky],
      channelRuntime: { backoffBaseMs: 10, backoffMaxMs: 400, stableMs: 60_000, statusPollMs: 20 },
      dispatcher: { pollMs: 5 },
    });
    open.push(s);
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db);
    const r = await api(s, owner.token, 'POST', '/bindings', {
      kind: 'flaky',
      agentId: agent,
      secrets: { token: 'abc' },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    await until(() => connects >= 1);
    await new Promise((res) => setTimeout(res, 700));
    // 10, 20, 40, 80, 160, 320 ms between tries: about 7 connects; a reset-on-connect loop makes ~70
    expect(connects).toBeGreaterThanOrEqual(3);
    expect(connects).toBeLessThanOrEqual(9);
  });

  it('restart mid-conversation: a redelivered message runs once, no reply goes out twice, the next one is answered', async () => {
    const home = tempHome();
    try {
      const p = new ReplayPlatform();
      let s = await boot(p, home.dir);
      const owner = seedUser(s.db);
      const agent = seedAgent(s.db, { trust: 'standard' });
      const r = await api(s, owner.token, 'POST', '/bindings', {
        kind: 'fake',
        agentId: agent,
        secrets: { token: p.token },
      });
      const binding = ((await r.json()) as { binding: { id: string } }).binding.id;
      await until(() => statusOf(s, binding) === 'connected');
      const c: Ctx = { s, p, owner, agent, binding };
      await link(c);
      await p.deliver({ from: 'owner', place: 'dm', text: 'first message' });
      await replyDone(c, p.places.dm, 'echo: first message');
      const first = p.seen.find((m) => m.text === 'first message')!;
      const before = p.botTexts(p.places.dm).length;

      await s.cleanup();
      open = open.filter((x) => x !== s);
      s = await boot(p, home.dir);
      await until(() => statusOf(s, binding) === 'connected');
      c.s = s;
      // the platform redelivers the already-answered message after the restart
      p.replay(first);
      await p.deliver({ from: 'owner', place: 'dm', text: 'second message' });
      await replyDone(c, p.places.dm, 'echo: second message');
      await new Promise((res) => setTimeout(res, 100));
      expect(items(s)).toHaveLength(2);
      const texts = p.botTexts(p.places.dm);
      expect(texts.filter((t) => t.includes('echo: first message'))).toHaveLength(1);
      expect(texts.length).toBe(before + 1);
    } finally {
      home.cleanup();
    }
  });

  it('a reply interrupted by a restart: the placeholder is finished once after boot, never re-sent', async () => {
    const home = tempHome();
    try {
      const p = new ReplayPlatform();
      let s = await boot(p, home.dir);
      const owner = seedUser(s.db);
      const agent = seedAgent(s.db, { trust: 'standard' });
      const r = await api(s, owner.token, 'POST', '/bindings', {
        kind: 'fake',
        agentId: agent,
        secrets: { token: p.token },
      });
      const binding = ((await r.json()) as { binding: { id: string } }).binding.id;
      await until(() => statusOf(s, binding) === 'connected');
      const c: Ctx = { s, p, owner, agent, binding };
      await link(c);
      await p.deliver({ from: 'owner', place: 'dm', text: 'SLOW please' });
      await until(() => p.botTexts(p.places.dm).includes(CHANNEL_TEXT.working));
      await s.cleanup();
      open = open.filter((x) => x !== s);
      s = await boot(p, home.dir);
      await until(() => statusOf(s, binding) === 'connected');
      await until(() => !p.botTexts(p.places.dm).includes(CHANNEL_TEXT.working));
      await new Promise((res) => setTimeout(res, 100));
      const texts = p.botTexts(p.places.dm).filter((t) => !t.startsWith('Linked.'));
      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toBe(CHANNEL_TEXT.working);
      const d = s.db.prepare('SELECT state FROM channels_delivery').all() as any[];
      expect(d.every((x) => x.state === 'sent' || x.state === 'failed')).toBe(true);
    } finally {
      home.cleanup();
    }
  });

  it('a rejected token shows auth_failed and retries with backoff; removing the binding stops it', async () => {
    const p = new ReplayPlatform();
    const s = await boot(p);
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db);
    const r = await api(s, owner.token, 'POST', '/bindings', {
      kind: 'fake',
      agentId: agent,
      secrets: { token: 'wrong-token' },
    });
    const id = ((await r.json()) as { binding: { id: string } }).binding.id;
    await until(() => statusOf(s, id) === 'auth_failed');
    const row = s.db.prepare('SELECT last_error FROM channels_binding WHERE id = ?').get(id) as any;
    expect(row.last_error).not.toContain('wrong-token');
    // owner fixes the token: write-only PATCH, the runtime reconnects
    const fix = await api(s, owner.token, 'PATCH', `/bindings/${id}`, { secrets: { token: p.token } });
    expect(fix.status).toBe(200);
    await until(() => statusOf(s, id) === 'connected');
    expect((await api(s, owner.token, 'DELETE', `/bindings/${id}`)).status).toBe(204);
    await until(() => s.channelRuntime.connection(id) === null);
  });

  it('owner-only REST: a member gets 403; a bad token shape or unknown kind is 400', async () => {
    const p = new ReplayPlatform();
    const s = await boot(p);
    const member = seedUser(s.db, 'member', 'M');
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db);
    expect((await api(s, member.token, 'GET', '/bindings')).status).toBe(403);
    const bad = await api(s, owner.token, 'POST', '/bindings', {
      kind: 'nope',
      agentId: agent,
      secrets: { token: 'x' },
    });
    expect(bad.status).toBe(400);
    const extra = await api(s, owner.token, 'POST', '/bindings', {
      kind: 'fake',
      agentId: agent,
      secrets: { notAField: 'x' },
    });
    expect(extra.status).toBe(400);
  });
  it('an adapter can leave the owner an audit note (ChannelContext.audit): channel.<action>, bad names refused', async () => {
    const p = new ReplayPlatform();
    const fake = new FakeChannel(p);
    const noting: ChannelAdapter<any> = {
      kind: fake.kind,
      configSchema: fake.configSchema,
      secretFields: fake.secretFields,
      async connect(cfg, ctx) {
        ctx.audit?.('board.page_skipped', { reason: 'too_large' });
        ctx.audit?.('Bad Name!', { x: 1 });
        return fake.connect(cfg, ctx);
      },
    };
    const s = await bootTestServer({
      modules: [createChannelsModule()],
      providers: [new FakeProvider({ script, deltaMs: 1 })],
      channels: [noting],
      channelRuntime: { backoffBaseMs: 20, backoffMaxMs: 100, editMs: 5, statusPollMs: 20, previewMax: 60 },
      dispatcher: { pollMs: 5 },
    });
    open.push(s);
    const owner = seedUser(s.db);
    const agent = seedAgent(s.db, { trust: 'trusted' });
    const r = await api(s, owner.token, 'POST', '/bindings', {
      kind: 'fake',
      agentId: agent,
      secrets: { token: p.token },
    });
    const binding = ((await r.json()) as { binding: { id: string } }).binding.id;
    const rows = await until(() => {
      const a = s.db
        .prepare("SELECT action, target, data FROM audit_log WHERE action LIKE 'channel.board%'")
        .all() as any[];
      return a.length ? a : null;
    });
    expect(rows[0]).toMatchObject({ action: 'channel.board.page_skipped', target: binding });
    expect(JSON.parse(rows[0].data)).toEqual({ reason: 'too_large' });
    expect(s.db.prepare("SELECT 1 FROM audit_log WHERE action LIKE '%Bad%'").get()).toBeUndefined();
  });
});
