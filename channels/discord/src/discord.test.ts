import { channelContext, inboundReader, runChannelContract } from '@pasabot/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOT, MockDiscord, TOKEN } from './__fixtures__/mock-discord.js';
import {
  createDiscordAdapter,
  DISCORD_INTENTS,
  DISCORD_TEXT_MAX,
  discordConfigSchema,
  mapDiscordMessage,
} from './index.js';

// tests reach the mock on 127.0.0.1 with plain fetch; production uses safeFetch
const adapter = createDiscordAdapter({ fetch: (url, init) => fetch(url, init) });
const BAD = `${TOKEN.slice(0, -6)}wrong!`;
const raw = (api: MockDiscord, token = TOKEN) => ({
  botToken: token,
  apiBase: api.url,
  gatewayUrl: api.wsUrl,
});

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

runChannelContract('discord', async () => {
  const api = await new MockDiscord().start();
  return { adapter, config: raw(api), badConfig: raw(api, BAD), platform: api, cleanup: () => api.stop() };
});

describe('discord mapping', () => {
  const base = {
    id: '9',
    channel_id: '8',
    guild_id: '7',
    author: { id: '6', username: 'ana', global_name: 'Ana' },
    content: 'hi',
    timestamp: '2026-11-13T00:00:00.000Z',
  };
  it('a reply to the bot counts as a mention; a nick wins over the global name', () => {
    const m = mapDiscordMessage(
      {
        ...base,
        member: { nick: 'Ana (work)' },
        message_reference: { message_id: '5' },
        referenced_message: { author: { id: BOT.id } },
      },
      BOT.id,
    );
    expect(m).toMatchObject({
      mentionsBot: true,
      replyToExternalId: '5',
      sender: { externalId: '6', name: 'Ana (work)', isBot: false },
      at: Date.parse(base.timestamp),
    });
    expect(mapDiscordMessage({ ...base, mentions: [{ id: '123' }] }, BOT.id).mentionsBot).toBe(false);
  });
  it('attachments keep their CDN url, name, type and size', () => {
    const m = mapDiscordMessage(
      {
        ...base,
        attachments: [
          { url: 'https://cdn.example/a.png', filename: 'a.png', content_type: 'image/png', size: 3 },
        ],
      },
      BOT.id,
    );
    expect(m.attachments).toEqual([
      { url: 'https://cdn.example/a.png', name: 'a.png', mime: 'image/png', size: 3 },
    ]);
  });
});

describe('discord connection', () => {
  let api: MockDiscord;
  beforeEach(async () => {
    api = await new MockDiscord().start();
  });
  afterEach(() => api.stop());

  it('identifies with the message intents, skips its own echoes and never pings @everyone', async () => {
    const conn = await adapter.connect(discordConfigSchema.parse(raw(api)), channelContext());
    const inbound = inboundReader(conn);
    await until(() => conn.status() === 'connected');
    expect(api.gatewayOps.find((f) => f.op === 2)?.d.intents).toBe(DISCORD_INTENTS);
    await conn.send(api.places.group, { text: '@everyone hello' }); // echoed back on the gateway
    await api.deliver({ from: 'owner', place: 'group', text: 'after', mention: true });
    expect((await inbound.next())!.text).toBe(`<@${BOT.id}> after`);
    expect(api.rest.find((r) => r.method === 'POST')?.body.allowed_mentions).toEqual({ parse: [] });
    expect(await conn.listPlaces()).toEqual([{ id: api.places.group, title: 'pasabot-crew', kind: 'group' }]);
    await conn.close();
  });

  it('splits long replies at 2000 characters', async () => {
    const conn = await adapter.connect(discordConfigSchema.parse(raw(api)), channelContext());
    await conn.send(api.places.dm, { text: 'x'.repeat(DISCORD_TEXT_MAX + 5) });
    expect(api.rest.filter((r) => r.method === 'POST').map((r) => r.body.content.length)).toEqual([
      DISCORD_TEXT_MAX,
      5,
    ]);
    await conn.close();
  });

  it('a long edit posts the rest as threaded follow-ups; later edits update them, never duplicate', async () => {
    const conn = await adapter.connect(discordConfigSchema.parse(raw(api)), channelContext());
    const dm = api.places.dm;
    const { externalId } = await conn.send(dm, { text: 'working…' });
    const n = DISCORD_TEXT_MAX;
    await conn.edit!(dm, externalId, { text: `${'a'.repeat(n)}${'b'.repeat(n)}c` });
    expect(api.botTexts(dm)).toEqual(['a'.repeat(n), 'b'.repeat(n), 'c']);
    const posts = () => api.rest.filter((r) => r.method === 'POST');
    for (const p of posts().slice(1)) {
      expect(p.body.message_reference).toMatchObject({ message_id: externalId });
      expect(p.body.allowed_mentions).toEqual({ parse: [] });
    }
    await conn.edit!(dm, externalId, { text: `${'a'.repeat(n)}${'b'.repeat(n)}cd` });
    expect(api.botTexts(dm)).toEqual(['a'.repeat(n), 'b'.repeat(n), 'cd']);
    await conn.edit!(dm, externalId, { text: `${'a'.repeat(n)}x` });
    expect(api.botTexts(dm)).toEqual(['a'.repeat(n), 'x']);
    expect(posts()).toHaveLength(3);
    await conn.close();
  });

  it('a dropped gateway resumes the session and keeps delivering', async () => {
    const conn = await adapter.connect(discordConfigSchema.parse(raw(api)), channelContext());
    const inbound = inboundReader(conn);
    await until(() => conn.status() === 'connected');
    api.dropGateway(4000);
    await until(() => api.gatewayOps.some((f) => f.op === 6));
    await until(() => conn.status() === 'connected' && api.connectedSockets() === 1);
    expect(api.gatewayOps.find((f) => f.op === 6)?.d).toMatchObject({ session_id: 'sess-1' });
    await api.deliver({ from: 'owner', place: 'dm', text: 'still here' });
    expect((await inbound.next())!.text).toBe('still here');
    await conn.close();
  });

  it('a zombied gateway (heartbeats never ACKed, no close) is detected and resumed', async () => {
    api.heartbeatInterval = 60;
    const conn = await adapter.connect(discordConfigSchema.parse(raw(api)), channelContext());
    const inbound = inboundReader(conn);
    await until(() => conn.status() === 'connected');
    await until(() => api.gatewayOps.filter((f) => f.op === 1).length >= 2); // ACKed beats keep it alive
    expect(api.gatewayOps.some((f) => f.op === 6)).toBe(false);
    api.zombie();
    await until(() => conn.status() === 'reconnecting');
    await until(() => api.gatewayOps.some((f) => f.op === 6) && conn.status() === 'connected');
    expect(api.gatewayOps.find((f) => f.op === 6)?.d).toMatchObject({ session_id: 'sess-1' });
    await api.deliver({ from: 'owner', place: 'dm', text: 'after the nap' });
    expect((await inbound.next())!.text).toBe('after the nap');
    await conn.close();
  });

  it('gateway close 4014 (intents not enabled) stops with auth_failed', async () => {
    api.identifyCloseCode = 4014;
    const conn = await adapter.connect(discordConfigSchema.parse(raw(api)), channelContext());
    const inbound = inboundReader(conn);
    await until(() => conn.status() === 'auth_failed');
    expect(await inbound.next()).toBeNull();
  });

  it('a rejected token refuses to connect without echoing the token', async () => {
    const err = await adapter
      .connect(discordConfigSchema.parse(raw(api, BAD)), channelContext())
      .catch((e) => e);
    expect(String(err)).toMatch(/auth failed/);
    expect(String(err)).not.toContain(BAD);
  });
});
