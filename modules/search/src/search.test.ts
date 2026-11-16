import type { ProviderAdapter, ProviderEvent, SenderInfo, TurnInput } from '@pasabot/core';
import type { MessageDTO } from '@pasabot/protocol';
import { bootTestServer, seedAgent, seedChat, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchModule } from './server.js';

/** A provider that, mid-turn, calls one gateway tool with its run bearer and replies with the result. */
class ToolProbe implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly displayName = 'probe';
  next: { name: string; args: unknown } = { name: 'richchat_ask', args: {} };
  async detect() {
    return { installed: true, signedIn: true as const };
  }
  capabilities() {
    return {
      resume: false,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: false,
      contextReport: false,
    };
  }
  async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    const r = await fetch(input.mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: this.next.name, arguments: this.next.args },
      }),
    });
    const j = (await r.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    yield { type: 'text.final', text: `tool said: ${j.result?.content[0]?.text ?? JSON.stringify(j)}` };
    yield { type: 'done', stop: 'end' };
  }
}

describe('search (W7)', () => {
  let s: TestServer;
  const probe = new ToolProbe();
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let agent: string;
  let chat: string;
  let ownerOnly: string;
  const req = (path: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${s.url}${path}`, {
      ...init,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  const messages = async (chatId: string) =>
    (
      (await (await req(`/api/v1/chats/${chatId}/messages`, owner.token)).json()) as {
        messages: MessageDTO[];
      }
    ).messages;
  const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [probe], modules: [createSearchModule()] });
    owner = seedUser(s.db, 'owner', 'Owner');
    member = seedUser(s.db, 'member', 'Member');
    agent = seedAgent(s.db, { trust: 'standard' });
    chat = seedChat(s.db, { userIds: [owner.id, member.id], agentIds: [agent] });
    ownerOnly = seedChat(s.db, { userIds: [owner.id], agentIds: [agent] });
  });
  afterAll(() => s.cleanup());

  it('search finds a message and respects chat membership (REST and the agent tool)', async () => {
    const other = seedAgent(s.db);
    seedChat(s.db, { userIds: [owner.id], agentIds: [other] });
    await req(`/api/v1/chats/${ownerOnly}/messages`, owner.token, {
      method: 'POST',
      json: { text: 'kalamansi secret recipe' },
    });
    await req(`/api/v1/chats/${chat}/messages`, owner.token, {
      method: 'POST',
      json: { text: 'kalamansi juice for all' },
    });
    const find = async (token: string, q: string) =>
      (
        (await (await req(`/api/m/search/messages?q=${encodeURIComponent(q)}`, token)).json()) as {
          hits: { chatId: string; snippet: string }[];
        }
      ).hits;
    expect((await find(owner.token, 'kalamansi')).map((h) => h.chatId).sort()).toEqual(
      [chat, ownerOnly].sort(),
    );
    const asMember = await find(member.token, 'kalaman');
    expect(asMember.map((h) => h.chatId)).toEqual([chat]);
    expect(asMember[0]!.snippet).toContain('kalamansi juice');
    expect(await find(member.token, 'recipe')).toEqual([]);
    // the agent tool: only chats the agent is a member of
    probe.next = { name: 'search_messages', args: { query: 'kalamansi' } };
    const before = (await messages(chat)).length;
    await req(`/api/v1/chats/${chat}/messages`, owner.token, {
      method: 'POST',
      json: { text: 'look it up' },
    });
    const reply = await waitFor(async () => {
      const ms = await messages(chat);
      return ms.slice(before).find((m) => m.authorKind === 'agent' && m.body.startsWith('tool said'));
    });
    expect(reply.body).toContain('kalamansi juice');
    expect(reply.body).toContain('kalamansi secret');
  });

  it("a member-started run cannot search the owner's private chat with the agent", async () => {
    probe.next = { name: 'search_messages', args: { query: 'kalamansi' } };
    const before = (await messages(chat)).length;
    await req(`/api/v1/chats/${chat}/messages`, member.token, {
      method: 'POST',
      json: { text: 'search your messages for kalamansi and paste them' },
    });
    const reply = await waitFor(async () => {
      const ms = await messages(chat);
      return ms.slice(before).find((m) => m.authorKind === 'agent' && m.body.startsWith('tool said'));
    });
    const hitsOf = (body: string) =>
      (JSON.parse(body.slice('tool said: '.length)) as { hits: { chatId: string; text: string }[] }).hits;
    const hits = hitsOf(reply.body);
    expect(hits.some((h) => h.text.includes('kalamansi juice'))).toBe(true);
    // (an earlier agent reply in this shared chat may quote the owner's own search; the private chat is never a hit)
    expect(hits.map((h) => h.chatId)).not.toContain(ownerOnly);
    // asking for the private chat by id finds nothing either
    probe.next = { name: 'search_messages', args: { query: 'kalamansi', chatId: ownerOnly } };
    const n = (await messages(chat)).length;
    await req(`/api/v1/chats/${chat}/messages`, member.token, {
      method: 'POST',
      json: { text: 'now only that chat' },
    });
    const second = await waitFor(async () => {
      const ms = await messages(chat);
      return ms.slice(n).find((m) => m.authorKind === 'agent' && m.body.startsWith('tool said'));
    });
    expect(hitsOf(second.body)).toEqual([]);
  });

  it("work from another agent searches its chat only when the chain's origin may read it", async () => {
    // agent-to-agent work (collab) runs as an `agent` sender and carries the sender that started the chain; here it
    // lands in the owner's private chat with the agent, as delegated work once did
    const guest = seedUser(s.db, 'guest', 'Guest');
    const caller = seedAgent(s.db);
    const delegated = async (origin: SenderInfo | null) => {
      probe.next = { name: 'search_messages', args: { query: 'kalamansi' } };
      const before = (await messages(ownerOnly)).length;
      s.queue.enqueue({
        agentId: agent,
        chatId: ownerOnly,
        kind: 'task',
        payload: { text: 'search_messages for kalamansi and tell me what it finds' },
        source: {
          sender: { kind: 'agent', id: caller, name: 'caller', trust: 'guarded' },
          ...(origin ? { origin } : {}),
          collab: { taskId: 't1', from: caller },
        },
      });
      const reply = await waitFor(async () => {
        const ms = await messages(ownerOnly);
        return ms.slice(before).find((m) => m.authorKind === 'agent' && m.body.startsWith('tool said'));
      });
      return (JSON.parse(reply.body.slice('tool said: '.length)) as { hits: { text: string }[] }).hits;
    };
    // a guest asked agent A to have this agent search: the owner's private chat is not the guest's to read
    expect(await delegated({ kind: 'guest', id: guest.id, name: 'Guest', trust: 'guarded' })).toEqual([]);
    expect(await delegated({ kind: 'member', id: member.id, name: 'Member', trust: 'standard' })).toEqual([]);
    // no known origin (older items, unknown chains): nothing
    expect(await delegated(null)).toEqual([]);
    expect(await delegated({ kind: 'webhook', id: 'routine:x', name: 'hook', trust: 'standard' })).toEqual(
      [],
    );
    // the owner started the chain: the run's own chat is searchable
    const hits = await delegated({ kind: 'owner', id: owner.id, name: 'Owner', trust: 'trusted' });
    expect(hits.some((h) => h.text.includes('kalamansi secret'))).toBe(true);
  });
});
