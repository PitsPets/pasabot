import { decideChannelInbound } from '@pasabot/core';
import { channelContext, inboundReader, runChannelContract } from '@pasabot/testkit';
import { describe, expect, it } from 'vitest';
import {
  BAD_STATE,
  BOT_JID,
  GOOD_STATE,
  MockWhatsApp,
  memoryState,
  STALE_STATE,
} from './__fixtures__/mock-whatsapp.js';
import { createWhatsAppAdapter, mapWaMessage, normalizeJid, whatsappConfigSchema } from './index.js';

const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

runChannelContract('whatsapp', async () => {
  const phone = new MockWhatsApp();
  return {
    adapter: createWhatsAppAdapter({ socket: phone.factory }),
    config: { ownNumber: false },
    badConfig: { ownNumber: false },
    platform: phone,
    state: memoryState(GOOD_STATE),
    badState: memoryState(BAD_STATE),
    cleanup: async () => {},
  };
});

describe('whatsapp pairing (QR link as a linked device)', () => {
  it('streams each QR code, stores the session in ctx.state on scan, then reports done', async () => {
    const phone = new MockWhatsApp();
    const adapter = createWhatsAppAdapter({ socket: phone.factory });
    const ctx = channelContext('bind-wa');
    const state = memoryState();
    ctx.state = state;
    const seen: { qr?: string; done?: true }[] = [];
    const run = (async () => {
      for await (const s of adapter.pairing!(ctx)) {
        seen.push(s);
        if (s.qr && seen.length === 1) phone.rotateQr();
        else if (s.qr) phone.scan();
      }
    })();
    await run;
    expect(seen.map((s) => s.qr ?? (s.done ? 'done' : '?'))).toEqual(['QR-1', 'QR-2', 'done']);
    expect(state.value).toBe(GOOD_STATE);
    expect(phone.sockets[0]!.ended).toBe(true);

    // the binding then connects with the stored session
    const conn = await adapter.connect(whatsappConfigSchema.parse({}), ctx);
    await until(() => conn.status() === 'connected');
    await conn.close();
  });

  it('an aborted pairing ends without storing anything', async () => {
    const phone = new MockWhatsApp();
    const adapter = createWhatsAppAdapter({ socket: phone.factory });
    const ctx = channelContext('bind-wa');
    const state = memoryState();
    ctx.state = state;
    const qrs: string[] = [];
    for await (const s of adapter.pairing!(ctx)) {
      if (s.qr) qrs.push(s.qr);
      ctx.abort();
    }
    expect(qrs).toEqual(['QR-1']);
    expect(state.value).toBeNull();
  });

  it('without a stored session the binding is not linked (an auth error) and opens no socket', async () => {
    const phone = new MockWhatsApp();
    await expect(
      createWhatsAppAdapter({ socket: phone.factory }).connect(whatsappConfigSchema.parse({}), {
        ...channelContext(),
        state: memoryState(),
      }),
    ).rejects.toThrow(/not linked.*auth/);
    expect(phone.sockets).toHaveLength(0);
  });

  it('a session removed from the phone is forgotten', async () => {
    const phone = new MockWhatsApp();
    const state = memoryState(BAD_STATE);
    const conn = await createWhatsAppAdapter({ socket: phone.factory }).connect(
      whatsappConfigSchema.parse({}),
      { ...channelContext(), state },
    );
    await until(() => conn.status() === 'auth_failed');
    await until(() => state.value === '');
  });

  it('a stored session answered with a QR login is forgotten, so the next connect opens no socket', async () => {
    const phone = new MockWhatsApp();
    const adapter = createWhatsAppAdapter({ socket: phone.factory });
    const state = memoryState(STALE_STATE);
    const conn = await adapter.connect(whatsappConfigSchema.parse({}), { ...channelContext(), state });
    await until(() => conn.status() === 'auth_failed');
    await until(() => state.value === '');
    expect(phone.sockets[0]!.ended).toBe(true);
    // the runtime's reconnect fails fast as "not linked yet" without asking WhatsApp for another QR login
    await expect(
      adapter.connect(whatsappConfigSchema.parse({}), { ...channelContext(), state }),
    ).rejects.toThrow(/not linked.*auth/);
    expect(phone.sockets).toHaveLength(1);
  });

  it('session updates are coalesced into one vault write, and the newest is flushed on close', async () => {
    const phone = new MockWhatsApp();
    const base = memoryState(GOOD_STATE);
    const writes: string[] = [];
    const state = Object.assign(base, {
      async save(v: string) {
        writes.push(v);
        base.value = v;
      },
    });
    const conn = await createWhatsAppAdapter({ socket: phone.factory }).connect(
      whatsappConfigSchema.parse({}),
      {
        ...channelContext(),
        state,
      },
    );
    await until(() => conn.status() === 'connected');
    // the socket emits a fresh session on almost every decrypted message
    for (let i = 0; i < 200; i++) phone.live!.emit('state', `{"session":"linked-test-device","n":${i}}`);
    expect(writes).toEqual([]);
    await conn.close();
    await until(() => writes.length > 0);
    expect(writes).toEqual(['{"session":"linked-test-device","n":199}']);
  });
});

describe('whatsapp own-number mode', () => {
  const owner = '639171111111@s.whatsapp.net';
  it('the owner talks in their own "message yourself" chat; their chats with other people are not turns; our replies never loop', async () => {
    const phone = new MockWhatsApp(owner);
    const adapter = createWhatsAppAdapter({ socket: phone.factory });
    const ctx = { ...channelContext(), state: memoryState(GOOD_STATE) };
    const conn = await adapter.connect(whatsappConfigSchema.parse({ ownNumber: true }), ctx);
    const inbound = inboundReader(conn);
    await until(() => conn.status() === 'connected');

    // the owner messages a friend from the phone: private, never a turn
    phone.push({ chat: '639175555555@s.whatsapp.net', sender: owner, fromMe: true, text: 'see you later' });
    // the owner writes in the self chat: an owner DM, keyed on the owner's own JID
    phone.push({ chat: owner, sender: owner.replace('@', ':3@'), fromMe: true, text: '/link ABC123' });
    const m = (await inbound.next())!;
    expect(m.placeId).toBe(owner);
    expect(m.sender.externalId).toBe(owner);
    expect(m.mentionsBot).toBe(true);
    expect((await conn.listPlaces())[0]?.kind).toBe('dm');

    // the agent's reply in the self chat echoes back as the owner's own message: skipped, no loop
    await conn.send(owner, { text: 'Hello! I am here.' });
    await expect(inbound.next(300)).rejects.toThrow(/timeout/);
    await conn.close();
  });

  it('other people writing to the personal number, or mentioning the owner in a group, never reach the agent', async () => {
    const phone = new MockWhatsApp(owner);
    const adapter = createWhatsAppAdapter({ socket: phone.factory });
    const ctx = { ...channelContext(), state: memoryState(GOOD_STATE) };
    const conn = await adapter.connect(whatsappConfigSchema.parse({ ownNumber: true }), ctx);
    const inbound = inboundReader(conn);
    await until(() => conn.status() === 'connected');

    const alice = '639175555555@s.whatsapp.net';
    const group = '120363000000000009@g.us';
    // a friend's DM to the owner's personal number
    phone.push({ chat: alice, sender: alice, pushName: 'Alice', text: 'free tonight?' });
    // a group mention of the owner as a person, and a reply quoting the owner
    phone.push({ chat: group, sender: alice, text: '@owner join us', mentioned: [owner] });
    phone.push({ chat: group, sender: alice, text: 'agree', quotedSender: owner, quotedId: 'Q9' });
    // the owner's own message in a group
    phone.push({ chat: group, sender: owner, fromMe: true, text: 'on my way' });
    // something in the self chat that does not come from the owner's devices
    phone.push({ chat: owner, sender: alice, text: 'spoofed' });
    await expect(inbound.next(300)).rejects.toThrow(/timeout/);
    expect(await conn.listPlaces()).toEqual([]);

    const me = owner.replace('@', ':7@');
    const cfg = whatsappConfigSchema.parse({ ownNumber: true });
    const dm = { id: 'Z1', chat: alice, sender: alice, fromMe: false, text: 'hi', mentioned: [], at: 1 };
    expect(mapWaMessage(dm, me, cfg)).toBeNull();
    expect(mapWaMessage({ ...dm, chat: group, mentioned: [owner] }, me, cfg)).toBeNull();
    await conn.close();
  });

  it('a dedicated number ignores everything it sends itself', () => {
    const me = BOT_JID.replace('@', ':7@');
    const cfg = whatsappConfigSchema.parse({});
    const base = { id: 'X1', chat: BOT_JID, sender: me, text: 'hi', mentioned: [], at: 1 };
    expect(mapWaMessage({ ...base, fromMe: true }, me, cfg)).toBeNull();
  });
});

describe('whatsapp mapping', () => {
  const me = BOT_JID.replace('@', ':7@');
  const cfg = whatsappConfigSchema.parse({});
  const group = '120363000000000001@g.us';
  const base = {
    id: 'A1',
    chat: group,
    sender: '639176666666:4@s.whatsapp.net',
    fromMe: false,
    text: 'hi',
    at: 1,
  };
  it('the sender id is the account JID without the device part', () => {
    expect(normalizeJid('639176666666:4@s.whatsapp.net')).toBe('639176666666@s.whatsapp.net');
    expect(mapWaMessage({ ...base, mentioned: [] }, me, cfg)?.sender.externalId).toBe(
      '639176666666@s.whatsapp.net',
    );
  });
  it('in a group, a mention of the linked account or a reply to it is addressed to the bot', () => {
    expect(mapWaMessage({ ...base, mentioned: [] }, me, cfg)?.mentionsBot).toBe(false);
    expect(mapWaMessage({ ...base, mentioned: [BOT_JID] }, me, cfg)?.mentionsBot).toBe(true);
    expect(mapWaMessage({ ...base, mentioned: ['639179999999@s.whatsapp.net'] }, me, cfg)?.mentionsBot).toBe(
      false,
    );
    expect(mapWaMessage({ ...base, mentioned: [], quotedSender: me, quotedId: 'Q1' }, me, cfg)).toMatchObject(
      {
        mentionsBot: true,
        replyToExternalId: `${group}:Q1`,
      },
    );
  });
  it('allowed senders + mention filter in a group', () => {
    const decide = (sender: string, mentioned: string[]) =>
      decideChannelInbound({
        bindingId: 'b',
        msg: mapWaMessage({ ...base, sender, mentioned }, me, cfg)!,
        place: { kind: 'group', allowedSenders: ['639176666666@s.whatsapp.net'] },
        senderTrust: () => undefined,
        agentTrust: 'trusted',
      }).action;
    expect(decide('639176666666:4@s.whatsapp.net', [])).toBe('ignore');
    expect(decide('639176666666:4@s.whatsapp.net', [BOT_JID])).toBe('enqueue');
    expect(decide('639178888888@s.whatsapp.net', [BOT_JID])).toBe('drop');
  });
});
