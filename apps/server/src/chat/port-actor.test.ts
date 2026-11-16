import { asSystem, ChatAccessError, type ChatActor } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { createChatPort } from './port.js';

/**
 * The ChatPort checks the actor itself (ARCHITECTURE 5.5): a module that forgets a membership check cannot read
 * or change a chat for an agent or person who is not in it. `asSystem(...)` is the only way past.
 */
describe('ChatPort actor checks', () => {
  let s: TestServer;
  let port: ReturnType<typeof createChatPort>;
  let owner: { id: string };
  let member: { id: string };
  let outsider: { id: string };
  let watcher: { id: string };
  let lead = '';
  let helper = '';
  let stranger = '';
  let observerAgent = '';
  let chat = '';
  let msg = '';
  const agent = (id: string): ChatActor => ({ kind: 'agent', id });
  const user = (id: string): ChatActor => ({ kind: 'user', id });
  const sys = asSystem('test: setup');

  beforeAll(async () => {
    s = await bootTestServer({});
    port = createChatPort(s.db, s.bus, { blocks: s.blocks, redact: (t) => t });
    owner = seedUser(s.db, 'owner');
    member = seedUser(s.db, 'member', 'Member');
    outsider = seedUser(s.db, 'member', 'Outsider');
    watcher = seedUser(s.db, 'member', 'Watcher');
    lead = seedAgent(s.db);
    helper = seedAgent(s.db);
    stranger = seedAgent(s.db);
    observerAgent = seedAgent(s.db);
    chat = seedChat(s.db, { userIds: [owner.id, member.id], agentIds: [lead, helper] });
    const add = s.db.prepare(
      "INSERT INTO chat_members (chat_id, member_kind, member_id, role) VALUES (?, ?, ?, 'observer')",
    );
    add.run(chat, 'user', watcher.id);
    add.run(chat, 'agent', observerAgent);
    s.db.prepare("UPDATE chats SET kind = 'channel', task_owner_agent_id = ? WHERE id = ?").run(lead, chat);
    msg = port.post(sys, { chatId: chat, authorKind: 'agent', authorId: lead, body: 'secret plans' }).id;
    s.db
      .prepare(
        "INSERT INTO queue_items (id, agent_id, chat_id, seq, priority, kind, payload, source, state, created_at) VALUES ('Q1', ?, ?, 1, 0, 'message', '{}', '{}', 'done', 0)",
      )
      .run(lead, chat);
    s.db
      .prepare(
        "INSERT INTO runs (id, queue_item_id, agent_id, provider_id, state, started_at) VALUES ('RUN1', 'Q1', ?, 'fake', 'done', 0)",
      )
      .run(lead);
    port.post(sys, { chatId: chat, authorKind: 'agent', authorId: lead, body: 'run reply', runId: 'RUN1' });
  });
  afterAll(() => s.cleanup());

  it('an agent that is not a member reads nothing and changes nothing', () => {
    const a = agent(stranger);
    expect(port.get(a, chat)).toBeNull();
    expect(port.message(a, msg)).toBeNull();
    expect(port.runReply(a, 'RUN1')).toBeNull();
    expect(() => port.recent(a, chat, 10)).toThrow(ChatAccessError);
    expect(() => port.reactions(a, chat)).toThrow(ChatAccessError);
    expect(() => port.react(a, chat, msg, '👍', true)).toThrow(ChatAccessError);
    expect(() =>
      port.post(a, { chatId: chat, authorKind: 'agent', authorId: stranger, body: 'injected' }),
    ).toThrow(ChatAccessError);
    expect(() => port.updateBlocks(a, msg, [])).toThrow(ChatAccessError);
    expect(() => port.setTaskOwner(a, chat, helper)).toThrow(ChatAccessError);
    expect(() => port.setArchived(a, chat, true)).toThrow(ChatAccessError);
  });

  it('members read; observers read but never write', () => {
    expect(port.get(agent(helper), chat)?.id).toBe(chat);
    expect(port.recent(agent(helper), chat, 5).map((m) => m.body)).toContain('secret plans');
    expect(port.runReply(agent(helper), 'RUN1')).toBe('run reply');
    expect(port.react(agent(helper), chat, msg, '👍', true)).toBe(true);
    expect(port.react(user(member.id), chat, msg, '🎉', true)).toBe(true);
    expect(port.reactions(user(member.id), chat)).toHaveLength(2);
    // observers: agent and person
    expect(port.get(agent(observerAgent), chat)?.id).toBe(chat);
    expect(port.message(user(watcher.id), msg)?.body).toBe('secret plans');
    expect(() => port.react(agent(observerAgent), chat, msg, '👀', true)).toThrow(ChatAccessError);
    expect(() => port.react(user(watcher.id), chat, msg, '👀', true)).toThrow(ChatAccessError);
    expect(() =>
      port.post(agent(observerAgent), {
        chatId: chat,
        authorKind: 'agent',
        authorId: observerAgent,
        body: 'x',
      }),
    ).toThrow(ChatAccessError);
    // a person outside the chat
    expect(port.get(user(outsider.id), chat)).toBeNull();
    expect(() => port.reactions(user(outsider.id), chat)).toThrow(ChatAccessError);
  });

  it('an agent posts only as itself, for its own run; people never post through the port', () => {
    expect(() =>
      port.post(agent(helper), { chatId: chat, authorKind: 'agent', authorId: lead, body: 'as the lead' }),
    ).toThrow(ChatAccessError);
    expect(() =>
      port.post(agent(helper), { chatId: chat, authorKind: 'system', authorId: null, body: 'as the system' }),
    ).toThrow(ChatAccessError);
    expect(() =>
      port.post(agent(helper), {
        chatId: chat,
        authorKind: 'agent',
        authorId: helper,
        body: 'x',
        runId: 'RUN1',
      }),
    ).toThrow(ChatAccessError);
    expect(
      port.post(agent(helper), { chatId: chat, authorKind: 'agent', authorId: helper, body: 'hello' }).body,
    ).toBe('hello');
    expect(() =>
      port.post(user(owner.id), { chatId: chat, authorKind: 'agent', authorId: lead, body: 'x' }),
    ).toThrow(ChatAccessError);
  });

  it("only a message's author (or the system) changes its blocks", () => {
    expect(() => port.updateBlocks(agent(helper), msg, [])).toThrow(ChatAccessError);
    expect(() => port.updateBlocks(user(owner.id), msg, [])).toThrow(ChatAccessError);
    expect(port.updateBlocks(agent(lead), msg, [])?.id).toBe(msg);
    expect(port.updateBlocks(asSystem('test: settle'), msg, [])?.id).toBe(msg);
  });

  it('the lead hands on, the owner reassigns and archives; members and other agents cannot', () => {
    expect(() => port.setTaskOwner(agent(helper), chat, helper)).toThrow(ChatAccessError);
    expect(() => port.setTaskOwner(user(member.id), chat, helper)).toThrow(ChatAccessError);
    expect(() => port.setArchived(user(member.id), chat, true)).toThrow(ChatAccessError);
    port.setTaskOwner(agent(lead), chat, helper);
    expect(port.get(sys, chat)?.taskOwnerAgentId).toBe(helper);
    // the old lead no longer leads
    expect(() => port.setTaskOwner(agent(lead), chat, lead)).toThrow(ChatAccessError);
    port.setTaskOwner(user(owner.id), chat, lead);
    port.setArchived(user(owner.id), chat, true);
    expect(port.get(user(owner.id), chat)?.archivedAt).not.toBeNull();
    port.setArchived(asSystem('test: restore'), chat, false);
  });

  it('a disabled user, or a member id passed off as the owner, gets no owner reach', () => {
    const other = seedChat(s.db, { userIds: [owner.id], agentIds: [lead] });
    // the port reads the user's kind from the database, so a member is only ever a member
    expect(port.get(user(member.id), other)).toBeNull();
    s.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), member.id);
    expect(port.get(user(member.id), chat)).toBeNull();
    s.db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(member.id);
    expect(port.get(user(member.id), chat)?.id).toBe(chat);
  });
});
