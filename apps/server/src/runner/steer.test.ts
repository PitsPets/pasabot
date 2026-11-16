/**
 * Steering never loses a message (ARCHITECTURE 6, "Steer (default)"). QA W16→W17→W18: a request sent while the
 * previous reply was still being written was steered into that run ("Added to what Tala is doing now") and never
 * answered. A steered message is answered by the run it joined; once the run has given its final message, a new
 * message is not steered any more but queued for a turn of its own.
 */
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';

const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
type Msg = { id: string; authorKind: string; body: string; status: string; runId: string | null };

describe('steering into a running turn', () => {
  let s: TestServer;
  const fake = new FakeProvider({ deltaMs: 1 });
  let token = '';
  let chatId = '';
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const messages = async () => (await api(`/api/v1/chats/${chatId}/messages`)).json.messages as Msg[];
  const idle = () =>
    waitFor(async () => {
      const m = await messages();
      return !s.orchestrator.running.has(chatId) && m.every((x) => x.status !== 'streaming') && m;
    });

  beforeAll(async () => {
    s = await bootTestServer({ providers: [fake] });
    token = seedUser(s.db, 'owner').token;
    const r = await api('/api/v1/agents', { name: 'Tala', providerId: 'fake', trustLevel: 'trusted' });
    expect(r.status).toBe(201);
    chatId = r.json.chatId;
  });
  afterAll(() => s.cleanup());

  it('a message steered into a running turn is answered by that turn', async () => {
    const slow = JSON.stringify({
      fakeScript: [
        { after: 300, event: { type: 'text.final', text: 'slow done' } },
        { event: { type: 'done', stop: 'end' } },
      ],
    });
    await api(`/api/v1/chats/${chatId}/messages`, { text: slow });
    const running = await waitFor(async () => s.orchestrator.running.get(chatId));
    const steered = await api(`/api/v1/chats/${chatId}/messages`, { text: 'please publish the menu' });
    expect(steered.json).toMatchObject({ steered: true, queued: null });
    expect(fake.steeredInto(running.runId)).toEqual(['please publish the menu']);

    const m = await idle();
    const reply = m.find((x) => x.runId === running.runId && x.authorKind === 'agent')!;
    // the run answered the steered text before it ended, and the reply keeps both answers: the turn's own first,
    // then the steered text's (a steered answer never replaces the one it was steered into)
    expect(reply).toMatchObject({ status: 'final', body: 'slow done\n\necho: please publish the menu' });
    const run = s.db.prepare('SELECT state FROM runs WHERE id = ?').get(running.runId) as { state: string };
    expect(run.state).toBe('done');
  });

  it('once the turn has given its final message, a new message is queued for a turn of its own', async () => {
    // the final words come first; the run then winds down for a while before it is done
    const lingering = JSON.stringify({
      fakeScript: [
        { event: { type: 'text.final', text: 'all said' } },
        { after: 400, event: { type: 'done', stop: 'end' } },
      ],
    });
    await api(`/api/v1/chats/${chatId}/messages`, { text: lingering });
    const running = await waitFor(async () => {
      const t = s.orchestrator.running.get(chatId);
      return t?.closing ? t : undefined;
    });
    const next = await api(`/api/v1/chats/${chatId}/messages`, { text: 'one more thing' });
    expect(next.json.steered).toBeUndefined();
    expect(next.json.queued).toBeTruthy();
    expect(fake.steeredInto(running.runId)).toEqual([]);

    const m = await idle();
    const first = m.find((x) => x.runId === running.runId && x.authorKind === 'agent')!;
    expect(first).toMatchObject({ status: 'final', body: 'all said' });
    // its own run, its own reply
    const own = m.filter((x) => x.authorKind === 'agent' && x.body === 'echo: one more thing');
    expect(own).toHaveLength(1);
    expect(own[0]!.runId).not.toBe(running.runId);
  });

  it('a probe steered into a running turn calls its tool in that turn', async () => {
    const slow = JSON.stringify({
      fakeScript: [
        { after: 300, event: { type: 'text.final', text: 'slow done' } },
        { event: { type: 'done', stop: 'end' } },
      ],
    });
    await api(`/api/v1/chats/${chatId}/messages`, { text: slow });
    const running = await waitFor(async () => s.orchestrator.running.get(chatId));
    const probe = JSON.stringify({ probe: { name: 'no_such_tool', args: {} } });
    expect((await api(`/api/v1/chats/${chatId}/messages`, { text: probe })).json.steered).toBe(true);
    const m = await idle();
    const reply = m.find((x) => x.runId === running.runId && x.authorKind === 'agent')!;
    expect(reply.status).toBe('final');
    expect(reply.body).toMatch(/^slow done\n\ntool said: /);
    const calls = s.db
      .prepare("SELECT data FROM run_events WHERE run_id = ? AND type = 'tool.call'")
      .all(running.runId) as { data: string }[];
    expect(calls.map((c) => JSON.parse(c.data).name)).toEqual(['no_such_tool']);
  });
  it('a steered message is queued again, with its own sender, when the turn then fails', async () => {
    // the turn's own script fails after a while (an error, `done` stop 'error'), before it answers anything
    const failing = JSON.stringify({
      fakeScript: [
        { after: 300, event: { type: 'error', kind: 'crash', message: 'scripted failure' } },
        { event: { type: 'done', stop: 'error' } },
      ],
    });
    await api(`/api/v1/chats/${chatId}/messages`, { text: failing });
    const running = await waitFor(async () => s.orchestrator.running.get(chatId));
    const steered = await api(`/api/v1/chats/${chatId}/messages`, { text: 'please publish the menu' });
    expect(steered.json).toMatchObject({ steered: true, queued: null });
    expect(fake.steeredInto(running.runId)).toEqual(['please publish the menu']);

    const m = await waitFor(async () => {
      const all = await idle();
      return all.some((x) => x.body === 'echo: please publish the menu') && all;
    });
    const run = s.db.prepare('SELECT state FROM runs WHERE id = ?').get(running.runId) as { state: string };
    expect(run.state).toBe('failed');
    // answered by a turn of its own, as a reply to the steered message, under the sender who steered it
    const user = m.find((x) => x.id === steered.json.message.id)!;
    expect(user).toMatchObject({ authorKind: 'user', body: 'please publish the menu' });
    const answer = m.find((x) => x.body === 'echo: please publish the menu')!;
    expect(answer.runId).not.toBe(running.runId);
    const item = s.db
      .prepare(
        'SELECT q.payload, q.source FROM runs r JOIN queue_items q ON q.id = r.queue_item_id WHERE r.id = ?',
      )
      .get(answer.runId) as { payload: string; source: string };
    expect(JSON.parse(item.payload)).toMatchObject({ messageId: user.id, replyTo: user.id });
    expect(JSON.parse(item.source).sender).toMatchObject({ kind: 'owner' });
  });

  it('a steered message is queued again when the turn it joined is cancelled', async () => {
    const slow = JSON.stringify({
      fakeScript: [
        { after: 2000, event: { type: 'text.final', text: 'too slow' } },
        { event: { type: 'done', stop: 'end' } },
      ],
    });
    await api(`/api/v1/chats/${chatId}/messages`, { text: slow });
    const running = await waitFor(async () => s.orchestrator.running.get(chatId));
    const steered = await api(`/api/v1/chats/${chatId}/messages`, { text: 'and the prices' });
    expect(steered.json).toMatchObject({ steered: true, queued: null });
    const qi = s.db.prepare('SELECT queue_item_id FROM runs WHERE id = ?').get(running.runId) as {
      queue_item_id: string;
    };
    s.queue.cancel(qi.queue_item_id);

    const m = await waitFor(async () => {
      const all = await idle();
      return all.some((x) => x.body === 'echo: and the prices') && all;
    });
    const run = s.db.prepare('SELECT state FROM runs WHERE id = ?').get(running.runId) as { state: string };
    expect(run.state).toBe('cancelled');
    expect(m.filter((x) => x.body === 'echo: and the prices')).toHaveLength(1);
  });
});
