# @pasabot/channel-discord

Discord `ChannelAdapter` (ARCHITECTURE 5.2): Gateway WebSocket (v10, JSON) for inbound, REST for send/edit/react.

- Config: `botToken` (secret field, kept in the vault), `apiBase`, `gatewayUrl`. The bot needs the privileged
  **Message Content** intent; Identify asks for GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT.
- REST goes through `safeFetch`; the token is sent only in the `Authorization` header and Identify/Resume, never
  logged or put in an error (routes in errors have ids masked).
- `externalId` = message snowflake; `sender.externalId` = user snowflake (never the display name).
- `mentionsBot`: always true in a DM; in a guild channel, a user mention of the bot or a reply to its message.
- The bot's own messages echoed on the gateway are skipped. Outbound messages set `allowed_mentions: { parse: [] }`
  so agent text never pings `@everyone`, roles or users.
- Heartbeats, op 7 reconnect, op 9 invalid session and dropped sockets reconnect with backoff and resume the
  session; close codes 4004 and 4010–4014 are fatal (`auth_failed`).
- `send` splits at 2000 characters (returns the first part's id); 429 answers are retried after `retry_after`.
- `listPlaces`: text channels and threads from GUILD_CREATE, DMs from READY and inbound.
- Not yet: outbound attachments (W7), sharding (one shard only), slash commands.

Proof: `pnpm vitest run channels/discord` runs `runChannelContract('discord')` plus mapping/connection tests against
a mocked REST API and gateway on 127.0.0.1 (no network, no account).
