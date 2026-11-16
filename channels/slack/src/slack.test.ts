import { decideChannelInbound } from '@pasabot/core';
import { channelContext, inboundReader, runChannelContract } from '@pasabot/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BAD_TOKEN,
  BOT_USER,
  MockSlack,
  SIGNING_SECRET,
  signSlack,
  TEAM,
  TOKEN,
} from './__fixtures__/mock-slack.js';
import {
  createSlackAdapter,
  mapSlackEvent,
  slackConfigSchema,
  slackTextParts,
  verifySlackSignature,
} from './index.js';

// tests reach the mock on 127.0.0.1 with plain fetch; production uses safeFetch
const make = (api: MockSlack) =>
  createSlackAdapter({
    fetch: (url, init) => fetch(url, init),
    onConnection: (_id, c) => {
      if (c.status() === 'connected') api.conn = c;
    },
  });

runChannelContract('slack', async () => {
  const api = await new MockSlack().start();
  return {
    adapter: make(api),
    config: { botToken: TOKEN, signingSecret: SIGNING_SECRET, apiBase: api.url },
    badConfig: { botToken: BAD_TOKEN, signingSecret: SIGNING_SECRET, apiBase: api.url },
    platform: api,
    cleanup: () => api.stop(),
  };
});

describe('slack events signature', () => {
  const body = Buffer.from('{"type":"event_callback"}');
  it('accepts a fresh signature over the exact bytes and refuses a changed body, a wrong secret or an old one', () => {
    const now = Date.now();
    const h = signSlack(SIGNING_SECRET, body.toString(), Math.floor(now / 1000));
    expect(verifySlackSignature(SIGNING_SECRET, h, body, now)).toBe(true);
    expect(verifySlackSignature(SIGNING_SECRET, h, Buffer.from(`${body} `), now)).toBe(false);
    expect(verifySlackSignature('ffffffffffffffffffffffffffffffff', h, body, now)).toBe(false);
    // replay outside the 5-minute window
    expect(verifySlackSignature(SIGNING_SECRET, h, body, now + 6 * 60_000)).toBe(false);
    expect(verifySlackSignature(SIGNING_SECRET, {}, body, now)).toBe(false);
    expect(verifySlackSignature(SIGNING_SECRET, { ...h, 'x-slack-signature': 'v0=00' }, body, now)).toBe(
      false,
    );
  });
});

describe('slack connection', () => {
  let api: MockSlack;
  let ctx: ReturnType<typeof channelContext>;
  beforeEach(async () => {
    api = await new MockSlack().start();
    ctx = channelContext('bind-slack');
    await make(api).connect(
      slackConfigSchema.parse({ botToken: TOKEN, signingSecret: SIGNING_SECRET, apiBase: api.url }),
      ctx,
    );
  });
  afterEach(async () => {
    ctx.abort();
    await api.conn?.close();
    await api.stop();
  });

  it('answers the url_verification challenge only when signed', async () => {
    const ok = await api.post({ type: 'url_verification', challenge: 'abc123' });
    expect(ok).toEqual({ status: 200, body: { challenge: 'abc123' } });
    const bad = await api.post(
      { type: 'url_verification', challenge: 'abc123' },
      'ffffffffffffffffffffffffffffffff',
    );
    expect(bad.status).toBe(401);
  });

  it('an unsigned or forged event never becomes a message', async () => {
    const reader = inboundReader(api.conn!);
    const forged = await api.post(
      {
        type: 'event_callback',
        team_id: TEAM,
        event: {
          type: 'message',
          user: 'U0OWNER',
          channel: 'D0OWNER',
          channel_type: 'im',
          text: 'hi',
          ts: '1.1',
        },
      },
      '0000000000000000ffffffffffffffff',
    );
    expect(forged.status).toBe(401);
    await expect(reader.next(300)).rejects.toThrow(/timeout/);
  });

  it('a retried delivery and the app_mention twin of a message come in once', async () => {
    const reader = inboundReader(api.conn!);
    const ev = {
      user: 'U0OWNER',
      channel: 'C0GROUP',
      channel_type: 'channel',
      text: `<@${BOT_USER}> hi`,
      ts: '2.5',
    };
    await api.post({ type: 'event_callback', team_id: TEAM, event: { type: 'message', ...ev } });
    await api.post({ type: 'event_callback', team_id: TEAM, event: { type: 'app_mention', ...ev } });
    expect((await reader.next())?.externalId).toBe('C0GROUP:2.5');
    await expect(reader.next(300)).rejects.toThrow(/timeout/);
  });

  it("an agent's text never becomes a live mention or a masked link, in a send, an edit or a follow-up", async () => {
    const conn = api.conn!;
    const injected =
      '<!channel> urgent: reset at <https://evil.example|https://company.okta.com> & ping <@U0OWNER>';
    const escaped =
      '&lt;!channel&gt; urgent: reset at &lt;https://evil.example|https://company.okta.com&gt; &amp; ping &lt;@U0OWNER&gt;';
    const { externalId } = await conn.send('C0GROUP', { text: injected });
    expect(api.messageText('C0GROUP', externalId)).toBe(escaped);
    await conn.edit!('C0GROUP', externalId, { text: `<!here> ${'x'.repeat(5000)} <!everyone>` });
    const texts = api.botTexts('C0GROUP');
    expect(texts[0]!.startsWith('&lt;!here&gt; ')).toBe(true);
    expect(texts[1]!.endsWith(' &lt;!everyone&gt;')).toBe(true);
    expect(texts.join('')).not.toMatch(/<[!@#]|<https?:/);
  });

  it('an event from another workspace is ignored', async () => {
    const reader = inboundReader(api.conn!);
    await api.post({
      type: 'event_callback',
      team_id: 'T0OTHER',
      event: { type: 'message', user: 'U0OWNER', channel: 'D0X', channel_type: 'im', text: 'hi', ts: '3.1' },
    });
    await expect(reader.next(300)).rejects.toThrow(/timeout/);
  });
});

describe('slack mapping', () => {
  const bot = { userId: BOT_USER, teamId: TEAM, botId: 'B0SELF' };
  const base = {
    type: 'message',
    user: 'U1',
    channel: 'C1',
    channel_type: 'channel',
    ts: '1700000000.000100',
  };
  it('escaped parts stay within the limit and a cut never splits an entity', () => {
    const parts = slackTextParts(`${'a'.repeat(9)}<<<<`, 10);
    expect(parts.every((p) => p.length <= 10)).toBe(true);
    expect(parts.join('')).toBe(`${'a'.repeat(9)}&lt;&lt;&lt;&lt;`);
    for (const p of parts) expect(p).not.toMatch(/&(?!(amp|lt|gt);)/);
  });

  it('owner identity is team + user: the same user id in another workspace is someone else', () => {
    expect(mapSlackEvent({ ...base, text: 'x' }, bot)?.sender.externalId).toBe(`${TEAM}:U1`);
    expect(mapSlackEvent({ ...base, text: 'x', team: 'T9' }, bot)?.sender.externalId).toBe('T9:U1');
  });
  it('mentions: a <@bot> token, an app_mention or a DM; another user mention is not one', () => {
    expect(mapSlackEvent({ ...base, text: `hey <@${BOT_USER}>` }, bot)?.mentionsBot).toBe(true);
    expect(mapSlackEvent({ ...base, text: 'hey <@U777>' }, bot)?.mentionsBot).toBe(false);
    expect(mapSlackEvent({ ...base, type: 'app_mention', text: 'x' }, bot)?.mentionsBot).toBe(true);
    expect(mapSlackEvent({ ...base, channel_type: 'im', text: 'x' }, bot)?.mentionsBot).toBe(true);
  });
  it('our own messages, edits and joins are not turns; a thread reply points at its parent', () => {
    expect(mapSlackEvent({ ...base, user: BOT_USER, text: 'x' }, bot)).toBeNull();
    expect(mapSlackEvent({ ...base, bot_id: 'B0SELF', text: 'x' }, bot)).toBeNull();
    expect(mapSlackEvent({ ...base, subtype: 'message_changed', text: 'x' }, bot)).toBeNull();
    expect(mapSlackEvent({ ...base, subtype: 'channel_join', text: 'x' }, bot)).toBeNull();
    expect(
      mapSlackEvent({ ...base, text: 'x', thread_ts: '1699999999.000001' }, bot)?.replyToExternalId,
    ).toBe('C1:1699999999.000001');
  });
  it('allowed senders + mention filter: an allowed sender in a channel is enqueued only with a mention', () => {
    const decide = (text: string, user: string) =>
      decideChannelInbound({
        bindingId: 'b',
        msg: mapSlackEvent({ ...base, user, text }, bot)!,
        place: { kind: 'channel', allowedSenders: [`${TEAM}:U2`] },
        senderTrust: () => undefined,
        agentTrust: 'trusted',
      }).action;
    expect(decide('hello all', 'U2')).toBe('ignore');
    expect(decide(`<@${BOT_USER}> help`, 'U2')).toBe('enqueue');
    expect(decide(`<@${BOT_USER}> help`, 'U3')).toBe('drop');
  });
});
