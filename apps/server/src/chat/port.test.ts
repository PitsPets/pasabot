import { asSystem } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { createChatPort } from './port.js';

describe('ChatPort (ModuleHost.chats)', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await bootTestServer({});
  });
  afterAll(() => s.cleanup());

  it('own chat, module chats, recent messages, run reply, membership', () => {
    const chats = createChatPort(s.db);
    const owner = seedUser(s.db, 'owner', 'Owner');
    const a = seedAgent(s.db);
    const b = seedAgent(s.db);
    expect(chats.ownChat(a)).toBeNull();
    const shared = seedChat(s.db, { userIds: [owner.id], agentIds: [a, b] });
    expect(chats.ownChat(a)).toBeNull(); // two agents: not a's own chat
    const thread = chats.openDirect({ agentId: a, title: 't', settings: { x: 1 } });
    expect(chats.ownChat(a)).toBeNull(); // module-made chats are never the own chat
    const settings = JSON.parse(
      (s.db.prepare('SELECT settings FROM chats WHERE id = ?').get(thread) as { settings: string }).settings,
    );
    expect(settings).toEqual({ x: 1, moduleChat: true });
    expect(chats.isMember(thread, { kind: 'user', id: owner.id })).toBe(true);
    expect(chats.isMember(thread, { kind: 'agent', id: a })).toBe(true);
    expect(chats.isMember(thread, { kind: 'agent', id: b })).toBe(false);
    const own = chats.ownChat(a, { create: true })!;
    expect(own).not.toBe(thread);
    expect(chats.ownChat(a)).toBe(own);
    expect(chats.isMember(shared, { kind: 'agent', id: b })).toBe(true);

    const put = s.db.prepare(
      'INSERT INTO messages (id, chat_id, author_kind, author_id, body, status, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    put.run('M1', own, 'user', owner.id, 'first', 'final', null, 1);
    put.run('M2', own, 'agent', a, 'second', 'final', 'R1', 2);
    put.run('M3', own, 'agent', a, 'draft', 'streaming', 'R2', 3);
    expect(chats.recent(asSystem('test'), own, 10).map((m) => m.body)).toEqual(['second', 'first']);
    expect(chats.runReply(asSystem('test'), 'R1')).toBe('second');
    expect(chats.runReply(asSystem('test'), 'R2')).toBeNull();
    expect(() => chats.openDirect({ agentId: 'nope', title: 'x' })).toThrow();
  });
});
