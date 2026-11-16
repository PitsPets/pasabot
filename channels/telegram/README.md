# @pasabot/channel-telegram

Telegram `ChannelAdapter` (ARCHITECTURE 5.2) over the Bot HTTP API with long polling, so no public URL is needed.

- Config: `botToken` (secret field, kept in the vault), `apiBase` (default `https://api.telegram.org`), `pollTimeoutSec`.
- Outbound calls go through `safeFetch`. The token appears only in the request path; errors, logs, place ids and
  `RemoteFile.url` (`telegram-file:<file_id>`) never carry it.
- `externalId` is `<chatId>:<messageId>` (Telegram message ids are unique only inside one chat).
- `mentionsBot`: always true in a DM; in a group, an `@botname` mention, a text mention of the bot, a `/cmd@botname`
  command, or a reply to one of the bot's messages.
- `send` splits text at 4096 characters (returns the first part's id); `edit` treats "not modified" as success;
  429 answers are retried after `retry_after` (up to 3 times); 401/404 = `auth_failed`.
- `listPlaces` returns the chats seen since connecting (the Bot API cannot list chats).
- Not yet: outbound attachments and downloading inbound files (W7), webhook mode.

Proof: `pnpm vitest run channels/telegram` runs `runChannelContract('telegram')` plus mapping/connection tests against
a mocked Bot API on 127.0.0.1 (no network, no account).
