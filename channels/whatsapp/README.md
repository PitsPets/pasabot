# @pasabot/channel-whatsapp

WhatsApp `ChannelAdapter` (ARCHITECTURE 5.2) as a **linked device on the owner's own account**, linked by QR code.
No Business API. This is not an official API: the account can be limited or banned, so Settings → Channels shows
a terms-of-service / ban-risk notice and the server starts a pairing only with `acknowledgeRisk: true`.

- Pairing: `pairing(ctx)` yields each QR code (they rotate), stores the session in `ctx.state` (the vault, one
  sealed entry per binding; nothing on disk) when the phone scans it, then `done`; the binding restarts with it.
- Config (no secret fields): `ownNumber`. Off = a separate number for the agent; everything that number sends is
  ignored. On = the owner's personal number: only what the owner writes in their own "Message yourself" chat is a
  DM with the agent. Everything else on that number (the owner's chats, other people's DMs to the owner, groups,
  a group mention of the owner) is never a turn and is not counted or audited as a dropped sender; replies echoed
  back to the linked device are skipped.
- Identity: `sender.externalId` is the account JID without the device part (`123:4@s.whatsapp.net` →
  `123@s.whatsapp.net`); the owner link and allowed senders are keyed on it. In groups only a mention of the
  linked account or a reply to it counts as addressed to the bot.
- No stored session = connect fails with an auth error (shown as "Not linked yet") and opens no socket; a session
  removed on the phone (a logout, or a stored session answered with a new QR login) is cleared and the binding goes
  `auth_failed`, so reconnects stop opening WhatsApp Web connections.
- Session updates arrive on almost every message; they are coalesced into one vault write per 3 s (newest wins) and
  the newest is written at once on close, logout and pairing `done`. An unfinished pairing writes nothing.
- The socket is the small `WaSocket` port (`src/socket.ts`). The production bridge (`src/baileys-bridge.ts`) loads
  the optional `@whiskeysockets/baileys` client by name when a binding connects; it is **not** a dependency, so
  install it on the server to use real WhatsApp. The bridge is not covered by tests (needs a real account).
- Not yet: media in/out (W7), LID addressing, a live run.

Proof: `pnpm vitest run channels/whatsapp` (`runChannelContract('whatsapp')` with a mocked socket, pairing,
own-number and mention/allowed-sender tests) and `apps/web/e2e/whatsapp.spec.ts` (Playwright: notice first, QR
streamed only after it is accepted, scan → connected).
