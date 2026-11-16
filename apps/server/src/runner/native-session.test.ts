import type { SenderInfo, TurnInput } from '@pasabot/core';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { sessionScope } from './orchestrator.js';

/** Records the native session each turn was asked to resume. */
class Recording extends FakeProvider {
  seen: { ref: string | undefined; tools: TurnInput['tools'] }[] = [];
  override runTurn(input: TurnInput, signal: AbortSignal) {
    this.seen.push({ ref: input.nativeRef, tools: input.tools });
    return super.runTurn(input, signal);
  }
}

const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('native sessions never cross tool mode or trust (ARCHITECTURE 5.1, 7.4)', () => {
  let s: TestServer;
  const fake = new Recording();
  let agent = '';
  let chat = '';
  const owner: SenderInfo = { kind: 'owner', id: null, name: 'Owner', trust: 'trusted' };
  const stranger: SenderInfo = { kind: 'external', id: 'x1', name: 'Stranger', trust: 'guarded' };
  const webhook: SenderInfo = { kind: 'webhook', id: null, name: 'hook', trust: 'standard' };

  /** One turn that reports native session `ref`; returns the ref the turn was asked to resume. */
  const turn = async (o: { sender: SenderInfo; ref: string; toolless?: boolean; origin?: SenderInfo }) => {
    const before = fake.seen.length;
    const text = JSON.stringify({
      fakeScript: [
        { event: { type: 'session', nativeRef: o.ref } },
        { event: { type: 'text.final', text: 'ok' } },
        { event: { type: 'done', stop: 'end' } },
      ],
    });
    const { item } = s.queue.enqueue({
      agentId: agent,
      chatId: chat,
      kind: 'message',
      payload: { text, ...(o.toolless ? { tools: 'none' } : {}) },
      source: { sender: o.sender, ...(o.origin ? { origin: o.origin } : {}) },
    });
    await waitFor(() => s.queue.get(item.id)?.state === 'done');
    expect(fake.seen.length).toBe(before + 1);
    return fake.seen.at(-1)!;
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [fake], dispatcher: { pollMs: 5 } });
    const o = seedUser(s.db, 'owner');
    agent = seedAgent(s.db, { trust: 'trusted' });
    chat = seedChat(s.db, { userIds: [o.id], agentIds: [agent] });
  });
  afterAll(() => s.cleanup());

  it('a tool-less turn that read untrusted text is never resumed by a tool turn, nor the reverse', async () => {
    expect((await turn({ sender: owner, ref: 'tools-1' })).ref).toBeUndefined();
    // the tool-less step starts fresh and its session is kept apart
    const step = await turn({ sender: owner, ref: 'toolless-1', toolless: true });
    expect(step).toEqual({ ref: undefined, tools: 'none' });
    // the next tool turn continues the tool session, not the tool-less one
    expect((await turn({ sender: owner, ref: 'tools-1' })).ref).toBe('tools-1');
    // and a later tool-less step never continues the tool session
    expect((await turn({ sender: owner, ref: 'toolless-2', toolless: true })).ref).toBeUndefined();
    expect((await turn({ sender: owner, ref: 'tools-1' })).ref).toBe('tools-1');
    const rows = s.db
      .prepare(
        'SELECT native_ref, scope, ended_at FROM provider_sessions WHERE agent_id = ? ORDER BY started_at',
      )
      .all(agent) as { native_ref: string; scope: string; ended_at: number | null }[];
    // the tool-less sessions never ended the tool session
    expect(rows.find((r) => r.native_ref === 'tools-1')).toMatchObject({
      scope: 'gateway|trusted|owner:trusted',
      ended_at: null,
    });
    expect(rows.filter((r) => r.scope?.startsWith('none|')).map((r) => r.native_ref)).toEqual([
      'toolless-1',
      'toolless-2',
    ]);
  });

  it("a stranger's or webhook's session is never continued by the owner, and never by each other", async () => {
    expect((await turn({ sender: stranger, ref: 'stranger-1' })).ref).toBeUndefined();
    expect((await turn({ sender: owner, ref: 'tools-1' })).ref).toBe('tools-1');
    expect((await turn({ sender: webhook, ref: 'hook-1' })).ref).toBeUndefined();
    expect((await turn({ sender: stranger, ref: 'stranger-1' })).ref).toBe('stranger-1');
    expect((await turn({ sender: webhook, ref: 'hook-1' })).ref).toBe('hook-1');
    expect((await turn({ sender: owner, ref: 'tools-1' })).ref).toBe('tools-1');
  });

  it('a lower agent trust is a different scope: the old session is not resumed after the owner lowers it', async () => {
    s.db.prepare("UPDATE agents SET trust_level = 'standard' WHERE id = ?").run(agent);
    expect((await turn({ sender: owner, ref: 'std-1' })).ref).toBeUndefined();
    expect((await turn({ sender: owner, ref: 'std-1' })).ref).toBe('std-1');
    s.db.prepare("UPDATE agents SET trust_level = 'trusted' WHERE id = ?").run(agent);
    expect((await turn({ sender: owner, ref: 'tools-1' })).ref).toBe('tools-1');
  });

  it('rows from before scoping are never resumed', async () => {
    s.db
      .prepare('UPDATE provider_sessions SET ended_at = ? WHERE agent_id = ? AND ended_at IS NULL')
      .run(Date.now(), agent);
    s.db
      .prepare(
        "INSERT INTO provider_sessions (id, agent_id, chat_id, provider_id, native_ref, started_at) VALUES ('legacy', ?, ?, 'fake', 'legacy-ref', ?)",
      )
      .run(agent, chat, Date.now());
    expect((await turn({ sender: owner, ref: 'fresh' })).ref).toBeUndefined();
  });

  it("a tool-less turn's permission requests are all denied, even an owner's on a trusted agent (5.1)", async () => {
    const run = async (toolless: boolean, decision: 'allow' | 'deny') => {
      const before = fake.decisions.length;
      const text = JSON.stringify({
        fakeScript: [
          { expectPermission: { tool: 'Read', input: { file_path: 'notes.md' }, decision } },
          { expectPermission: { tool: 'Bash', input: { command: 'echo hi' }, decision } },
          { event: { type: 'text.final', text: 'ok' } },
          { event: { type: 'done', stop: 'end' } },
        ],
      });
      const { item } = s.queue.enqueue({
        agentId: agent,
        chatId: chat,
        kind: 'message',
        payload: { text, ...(toolless ? { tools: 'none' } : {}) },
        source: { sender: owner },
      });
      await waitFor(() => {
        const st = s.queue.get(item.id)?.state;
        return st === 'done' || st === 'failed' ? st : undefined;
      });
      return { state: s.queue.get(item.id)?.state, decisions: fake.decisions.slice(before) };
    };
    // the same owner turn with tools: the workspace read and (trusted agent) the shell run without asking
    expect(await run(false, 'allow')).toMatchObject({
      state: 'done',
      decisions: [
        { tool: 'Read', decision: 'allow' },
        { tool: 'Bash', decision: 'allow' },
      ],
    });
    // tool-less: nothing is tiered or auto-approved, every request is denied
    expect(await run(true, 'deny')).toMatchObject({
      state: 'done',
      decisions: [
        { tool: 'Read', decision: 'deny' },
        { tool: 'Bash', decision: 'deny' },
      ],
    });
  });

  it('two principals of the same kind and trust never share a session (other guests, routines, delegations)', async () => {
    const guestA: SenderInfo = { kind: 'guest', id: 'g-a', name: 'A', trust: 'guarded' };
    const guestB: SenderInfo = { kind: 'guest', id: 'g-b', name: 'B', trust: 'guarded' };
    expect((await turn({ sender: guestA, ref: 'guest-a' })).ref).toBeUndefined();
    expect((await turn({ sender: guestB, ref: 'guest-b' })).ref).toBeUndefined();
    expect((await turn({ sender: guestA, ref: 'guest-a' })).ref).toBe('guest-a');
    // two routines (webhook senders with their own ids) aiming at the same chat
    const hookA: SenderInfo = { kind: 'webhook', id: 'routine:1', name: 'one', trust: 'standard' };
    const hookB: SenderInfo = { kind: 'webhook', id: 'routine:2', name: 'two', trust: 'standard' };
    expect((await turn({ sender: hookA, ref: 'hook-a' })).ref).toBeUndefined();
    expect((await turn({ sender: hookB, ref: 'hook-b' })).ref).toBeUndefined();
    // delegations: another agent's task, or the same agent's for another origin, never continues this one
    const agentA: SenderInfo = { kind: 'agent', id: 'agent-a', name: 'A', trust: 'guarded' };
    const agentC: SenderInfo = { kind: 'agent', id: 'agent-c', name: 'C', trust: 'guarded' };
    expect((await turn({ sender: agentA, origin: guestA, ref: 'a-for-guest' })).ref).toBeUndefined();
    expect((await turn({ sender: agentC, origin: hookA, ref: 'c-for-hook' })).ref).toBeUndefined();
    expect((await turn({ sender: agentA, origin: hookA, ref: 'a-for-hook' })).ref).toBeUndefined();
    expect((await turn({ sender: agentA, origin: guestA, ref: 'a-for-guest' })).ref).toBe('a-for-guest');
  });

  it('rows saved under the older kind-and-trust scope are never resumed by a non-owner', async () => {
    const guest: SenderInfo = { kind: 'guest', id: 'g-old', name: 'Old', trust: 'guarded' };
    s.db
      .prepare(
        "INSERT INTO provider_sessions (id, agent_id, chat_id, provider_id, native_ref, scope, started_at) VALUES ('old-guest', ?, ?, 'fake', 'old-guest-ref', 'gateway|guarded|guest:guarded', ?)",
      )
      .run(agent, chat, Date.now());
    expect((await turn({ sender: guest, ref: 'new-guest' })).ref).toBeUndefined();
  });

  it('scope names mode, effective trust, the sender and the chain origin', () => {
    expect(sessionScope(true, 'standard', webhook)).toBe('none|standard|webhook:standard:hook');
    expect(sessionScope(false, 'guarded', stranger)).toBe('gateway|guarded|external:guarded:x1');
    expect(sessionScope(false, 'trusted', owner)).toBe('gateway|trusted|owner:trusted');
    const a: SenderInfo = { kind: 'agent', id: 'a|1', name: 'A', trust: 'guarded' };
    expect(sessionScope(false, 'guarded', a, stranger)).toBe(
      'gateway|guarded|agent:guarded:a%7C1<external:x1',
    );
  });
});
