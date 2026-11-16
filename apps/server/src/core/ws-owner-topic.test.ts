/**
 * The WS `owner` topic (browser.frame, browser.profile, computer.*: the owner's live screen and activity) is refused
 * by the SERVER for every principal that is not the owner, not merely left unrequested by the web client: a
 * non-owner user on a paired device, an automation token, an agent's run token, and a linked machine (which holds
 * no /ws credential at all: it reaches this server only through the link transport). Each case asks for the topic
 * explicitly, by `sub` and by resume, and must never get a frame of it.
 */
import { randomBytes } from 'node:crypto';
import { ulid } from '@pasabot/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  connectWs,
  seedAgent,
  seedAutomationToken,
  seedRunToken,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { hashToken } from './services.js';

describe('WS owner topic', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  beforeEach(async () => {
    s = await bootTestServer();
    owner = seedUser(s.db);
  });
  afterEach(() => s.cleanup());

  const ownerEvents = () => {
    s.bus.live('owner', 'browser.frame', { profileId: 'p1', jpeg: 'AAAA' } as never);
    return s.bus.publish('owner', 'browser.profile', { profileId: 'p1', running: true, url: null } as never);
  };
  /** a non-owner user's session bound to a device it paired, as the pairing flow stores it */
  const pairedDeviceSession = (kind: 'member' | 'guest') => {
    const user = seedUser(s.db, kind, kind === 'member' ? 'Member' : 'Guest');
    const deviceId = ulid();
    s.db
      .prepare('INSERT INTO devices (id, user_id, name, platform, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(deviceId, user.id, 'phone', 'ios', Date.now());
    const token = randomBytes(32).toString('base64url');
    s.db
      .prepare('INSERT INTO sessions (id, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), user.id, deviceId, Date.now(), Date.now() + 3600_000);
    return token;
  };

  it('the owner gets owner-topic frames (control)', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['owner'] });
    ws.send({ t: 'ping', n: 1 });
    await ws.next((f) => f.t === 'pong');
    ownerEvents();
    expect(await ws.next((f) => f.t === 'live')).toMatchObject({ topic: 'owner', type: 'browser.frame' });
    expect(await ws.next((f) => f.t === 'ev')).toMatchObject({ topic: 'owner', type: 'browser.profile' });
    ws.close();
  });

  it.each(['member', 'guest'] as const)(
    'a %s on a paired device asking for it by sub and by resume gets nothing of it',
    async (kind) => {
      const before = ownerEvents(); // an owner event already in the ring, for the resume attempt
      const ws = await connectWs(s.url);
      ws.send({ t: 'hello', v: 1, token: pairedDeviceSession(kind), resumeFrom: before - 1 });
      await ws.next((f) => f.t === 'welcome');
      ws.send({ t: 'sub', topics: ['owner', 'global'] });
      ws.send({ t: 'ping', n: 1 });
      await ws.next((f) => f.t === 'pong');
      ownerEvents();
      // a later global event proves the socket is live and the subscription frame was processed
      const marker = s.bus.publish('global', 'chat.created', { id: 'marker' });
      expect(await ws.next((f) => f.t === 'ev')).toMatchObject({ topic: 'global', seq: marker });
      ws.send({ t: 'ping', n: 2 });
      await ws.next((f) => f.t === 'pong' && f.n === 2);
      expect(ws.frames.filter((f) => f.topic === 'owner')).toEqual([]);
      ws.close();
    },
  );

  it('an owner account demoted while connected loses the topic on the next delivery', async () => {
    const ws = await connectWs(s.url);
    ws.send({ t: 'hello', v: 1, token: owner.token });
    await ws.next((f) => f.t === 'welcome');
    ws.send({ t: 'sub', topics: ['owner'] });
    ws.send({ t: 'ping', n: 1 });
    await ws.next((f) => f.t === 'pong');
    // the kind is re-read from `users` before each delivery, never kept from the hello
    s.db.prepare("UPDATE users SET kind = 'member' WHERE id = ?").run(owner.id);
    ownerEvents();
    ws.send({ t: 'ping', n: 2 });
    await ws.next((f) => f.t === 'pong' && f.n === 2);
    expect(ws.frames.filter((f) => f.topic === 'owner')).toEqual([]);
    ws.close();
  });

  it('an automation token, an agent run token and a linked machine cannot open /ws at all', async () => {
    const agent = seedAgent(s.db);
    const credentials = {
      automation: seedAutomationToken(s.db, agent),
      run: seedRunToken(s.db, agent).token,
      // a linked machine has no session: its only credential is its key pair on the link transport
      linkedMachine: randomBytes(32).toString('base64url'),
    };
    for (const [who, token] of Object.entries(credentials)) {
      const ws = await connectWs(s.url);
      ws.send({ t: 'hello', v: 1, token });
      ws.send({ t: 'sub', topics: ['owner'] });
      expect(await ws.next((f) => f.t === 'bye'), who).toEqual({ t: 'bye', reason: 'unauthorized' });
      ownerEvents();
      await new Promise((r) => setTimeout(r, 50));
      expect(
        ws.frames.filter((f) => f.t !== 'bye'),
        who,
      ).toEqual([]);
      ws.close();
    }
  });
});
