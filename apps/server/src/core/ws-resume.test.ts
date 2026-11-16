import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  seedChat,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';

describe('test:ws-resume', () => {
  let s: TestServer;
  let owner: string;
  beforeEach(async () => {
    s = await bootTestServer();
    owner = seedUser(s.db).token;
  });
  afterEach(() => s.cleanup());
  const note = (text: string) => s.bus.publish('global', 'notification', { level: 'info', text });

  it('resume replays missed events in order, then streams live', async () => {
    const seqs = ['a', 'b', 'c', 'd', 'e'].map(note);
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner, resumeFrom: seqs[1] });
    const welcome = await ws.next((f) => f.t === 'welcome');
    expect(welcome.seq).toBe(seqs[4]);
    expect(welcome.serverId).toBe(s.serverId);
    ws.send({ t: 'sub', topics: ['global'] });
    const replay = [
      await ws.next((f) => f.t === 'ev'),
      await ws.next((f) => f.t === 'ev'),
      await ws.next((f) => f.t === 'ev'),
    ];
    expect(replay.map((f) => f.seq)).toEqual(seqs.slice(2));
    expect(replay.map((f) => f.data.text)).toEqual(['c', 'd', 'e']);
    const live = note('f');
    expect(await ws.next((f) => f.t === 'ev')).toMatchObject({ seq: live, data: { text: 'f' } });
    expect(ws.frames.some((f) => f.t === 'gap')).toBe(false);
    ws.close();
  });

  it('a too-old seq gets gap (ring pruned), as does a seq from the future', async () => {
    const seqs = Array.from({ length: 6 }, (_, i) => note(`n${i}`));
    s.events.prune({ maxRows: 2 }); // keeps the last two
    expect(s.events.oldestSeq()).toBe(seqs[4]);
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner, resumeFrom: seqs[0] });
    await ws.next((f) => f.t === 'welcome');
    expect(await ws.next((f) => f.t === 'gap')).toEqual({ t: 'gap', from: seqs[0] });
    ws.close();

    // exactly at the edge (oldest - 1) is still resumable
    const ok = await connectWs(s.url);
    ok.send({ t: 'hello', v: 1, token: owner, resumeFrom: seqs[3] });
    await ok.next((f) => f.t === 'welcome');
    ok.send({ t: 'sub', topics: ['global'] });
    expect((await ok.next((f) => f.t === 'ev')).seq).toBe(seqs[4]);
    ok.close();

    const future = await connectWs(s.url);
    future.send({ t: 'hello', v: 1, token: owner, resumeFrom: 10_000 });
    await future.next((f) => f.t === 'welcome');
    expect(await future.next((f) => f.t === 'gap')).toEqual({ t: 'gap', from: 10_000 });
    future.close();
  });

  it('live frames are delivered but never persisted', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['run:r1'] });
    ws.send({ t: 'ping', n: 7 });
    await ws.next((f) => f.t === 'pong' && f.n === 7);
    const before = s.events.lastSeq();
    s.bus.live('run:r1', 'message.delta', { text: 'hi' });
    expect(await ws.next((f) => f.t === 'live')).toEqual({
      t: 'live',
      topic: 'run:r1',
      type: 'message.delta',
      data: { text: 'hi' },
    });
    expect(s.events.lastSeq()).toBe(before);
    ws.close();
  });

  it('refuses unauthenticated hello and filters chat topics by membership for non-owners', async () => {
    const anon = await connectWs(s.url);
    anon.send({ t: 'hello', v: 1, token: 'nope' });
    expect(await anon.next((f) => f.t === 'bye')).toEqual({ t: 'bye', reason: 'unauthorized' });

    const member = seedUser(s.db, 'member', 'Member');
    const mine = seedChat(s.db, { userIds: [member.id] });
    const other = seedChat(s.db);
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: member.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: [`chat:${mine}`, `chat:${other}`] });
    ws.send({ t: 'ping', n: 1 });
    await ws.next((f) => f.t === 'pong');
    s.bus.publish(`chat:${other}`, 'message.deleted', { id: 'x', chatId: other });
    s.bus.publish(`chat:${mine}`, 'message.deleted', { id: 'y', chatId: mine });
    const ev = await ws.next((f) => f.t === 'ev');
    expect(ev.topic).toBe(`chat:${mine}`);
    ws.close();
  });

  it('replay is bounded: a backlog over maxReplay sends gap; other topics are filtered in SQL', async () => {
    await s.cleanup();
    s = await bootTestServer({ ws: { maxReplay: 3 } });
    owner = seedUser(s.db).token;
    const start = note('base');
    for (let i = 0; i < 10; i++)
      s.bus.publish('module:other', 'notification', { level: 'info', text: `x${i}` });
    const few = ['a', 'b', 'c'].map(note);
    // three on `global` (the other topic is not counted): replayed in full
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner, resumeFrom: start });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['global'] });
    const got = [
      await ws.next((f) => f.t === 'ev'),
      await ws.next((f) => f.t === 'ev'),
      await ws.next((f) => f.t === 'ev'),
    ];
    expect(got.map((f) => f.seq)).toEqual(few);
    ws.close();
    // four on `global`: too many -> gap, then live delivery
    note('d');
    const ws2 = await connectWs(s.url);
    ws2.send({ t: 'hello', v: 1, token: owner, resumeFrom: start });
    await ws2.next((f) => f.t === 'welcome');
    ws2.send({ t: 'sub', topics: ['global'] });
    expect(await ws2.next((f) => f.t === 'gap' || f.t === 'ev')).toMatchObject({ t: 'gap', from: start });
    const live = note('e');
    expect(await ws2.next((f) => f.t === 'ev')).toMatchObject({ seq: live });
    ws2.close();
  });
});
