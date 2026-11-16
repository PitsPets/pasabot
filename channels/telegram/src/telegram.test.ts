import { channelContext, inboundReader, runChannelContract } from '@pasabot/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOT, MockBotApi, TOKEN } from './__fixtures__/mock-bot-api.js';
import {
  createTelegramAdapter,
  mapTelegramMessage,
  TELEGRAM_TEXT_MAX,
  telegramConfigSchema,
} from './index.js';

// tests reach the mock on 127.0.0.1 with plain fetch; production uses safeFetch
const adapter = createTelegramAdapter({ fetch: (url, init) => fetch(url, init) });
const cfg = (api: MockBotApi, token = TOKEN) =>
  telegramConfigSchema.parse({ botToken: token, apiBase: api.url, pollTimeoutSec: 1 });

runChannelContract('telegram', async () => {
  const api = await new MockBotApi().start();
  return {
    adapter,
    config: { botToken: TOKEN, apiBase: api.url, pollTimeoutSec: 1 },
    badConfig: { botToken: '7000:AAH-wrong-token-xxxxxxxxxxxxxxxx', apiBase: api.url, pollTimeoutSec: 1 },
    platform: api,
    cleanup: () => api.stop(),
  };
});

describe('telegram mapping', () => {
  const bot = { id: BOT.id, username: BOT.username! };
  const base = {
    message_id: 5,
    chat: { id: -1, type: 'supergroup' as const, title: 'G' },
    from: { id: 42, is_bot: false, first_name: 'Ana' },
    date: 1_700_000_000,
  };
  it('a reply to the bot or a text_mention of it counts as a mention; a mention of someone else does not', () => {
    expect(
      mapTelegramMessage({ ...base, text: 'yes', reply_to_message: { message_id: 3, from: BOT } }, bot),
    ).toMatchObject({ mentionsBot: true, replyToExternalId: '-1:3' });
    expect(
      mapTelegramMessage(
        {
          ...base,
          text: 'PasaBot do it',
          entities: [{ type: 'text_mention', offset: 0, length: 7, user: BOT }],
        },
        bot,
      )?.mentionsBot,
    ).toBe(true);
    expect(
      mapTelegramMessage(
        { ...base, text: '@someone_else hi', entities: [{ type: 'mention', offset: 0, length: 13 }] },
        bot,
      )?.mentionsBot,
    ).toBe(false);
    expect(
      mapTelegramMessage(
        { ...base, text: '/help@pasabot_bot', entities: [{ type: 'bot_command', offset: 0, length: 17 }] },
        bot,
      )?.mentionsBot,
    ).toBe(true);
  });
  it('captions become text and files are references without the token', () => {
    const m = mapTelegramMessage(
      {
        ...base,
        caption: 'look',
        photo: [
          { file_id: 'small', width: 90 },
          { file_id: 'big', width: 800, file_size: 1234 },
        ],
        document: { file_id: 'doc1', file_name: 'a.pdf', mime_type: 'application/pdf' },
      },
      bot,
    )!;
    expect(m.text).toBe('look');
    expect(m.attachments).toEqual([
      { url: 'telegram-file:big', name: 'photo.jpg', mime: 'image/jpeg', size: 1234 },
      { url: 'telegram-file:doc1', name: 'a.pdf', mime: 'application/pdf' },
    ]);
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });
  it('a message without a sender id (anonymous admin) is skipped', () => {
    expect(mapTelegramMessage({ ...base, from: undefined, text: 'x' }, bot)).toBeNull();
  });
});

describe('telegram connection', () => {
  let api: MockBotApi;
  beforeEach(async () => {
    api = await new MockBotApi().start();
  });
  afterEach(() => api.stop());

  it('retries a 429 after retry_after and splits long replies at the platform limit', async () => {
    const ctx = channelContext();
    const conn = await adapter.connect(cfg(api), ctx);
    api.fail429.set('sendMessage', 1);
    const long = `${'a'.repeat(TELEGRAM_TEXT_MAX)}\n${'b'.repeat(10)}`;
    const { externalId } = await conn.send(api.places.dm, { text: long });
    const sends = api.calls.filter((c) => c.method === 'sendMessage');
    expect(sends.map((c) => c.params.text.length)).toEqual([TELEGRAM_TEXT_MAX, TELEGRAM_TEXT_MAX, 10]);
    expect(api.messageText(api.places.dm, externalId)).toBe('a'.repeat(TELEGRAM_TEXT_MAX));
    // editing to the same text is not an error
    await conn.edit!(api.places.dm, externalId, { text: 'a'.repeat(TELEGRAM_TEXT_MAX) });
    await conn.close();
  });

  it('a long edit posts the rest as threaded follow-ups; later edits update them, never duplicate', async () => {
    const conn = await adapter.connect(cfg(api), channelContext());
    const dm = api.places.dm;
    const { externalId } = await conn.send(dm, { text: 'working…' });
    const n = TELEGRAM_TEXT_MAX;
    await conn.edit!(dm, externalId, { text: `${'a'.repeat(n)}${'b'.repeat(n)}c` });
    expect(api.botTexts(dm)).toEqual(['a'.repeat(n), 'b'.repeat(n), 'c']);
    const followUps = api.calls.filter((c) => c.method === 'sendMessage').slice(1);
    for (const f of followUps)
      expect(f.params.reply_parameters).toMatchObject({ message_id: Number(externalId.split(':')[1]) });
    // the reply keeps streaming: the follow-ups are edited in place
    await conn.edit!(dm, externalId, { text: `${'a'.repeat(n)}${'b'.repeat(n)}cd` });
    expect(api.botTexts(dm)).toEqual(['a'.repeat(n), 'b'.repeat(n), 'cd']);
    // it got shorter: the follow-up it no longer needs is removed
    await conn.edit!(dm, externalId, { text: `${'a'.repeat(n)}x` });
    expect(api.botTexts(dm)).toEqual(['a'.repeat(n), 'x']);
    expect(api.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(3);
    await conn.close();
  });

  it('a token revoked while polling turns the status to auth_failed and ends inbound', async () => {
    const ctx = channelContext();
    const conn = await adapter.connect(cfg(api), ctx);
    const inbound = inboundReader(conn);
    api.revoked = true;
    await api.deliver({ from: 'owner', place: 'dm', text: 'wake the poller' });
    expect(await inbound.next(5000)).toBeNull();
    expect(conn.status()).toBe('auth_failed');
  });

  it('a rejected token refuses to connect without echoing the token', async () => {
    const bad = '7000:AAH-wrong-token-xxxxxxxxxxxxxxxx';
    const err = await adapter.connect(cfg(api, bad), channelContext()).catch((e) => e);
    expect(String(err)).toMatch(/auth failed/);
    expect(String(err)).not.toContain(bad);
  });

  it('places are learned from inbound with their kind', async () => {
    const conn = await adapter.connect(cfg(api), channelContext());
    const inbound = inboundReader(conn);
    await api.deliver({ from: 'owner', place: 'group', text: 'hi' });
    await inbound.next();
    expect(await conn.listPlaces()).toEqual([{ id: '-100555', title: 'PasaBot Crew', kind: 'group' }]);
    await conn.close();
  });
});
