# @pasabot/channel-slack

Slack `ChannelAdapter` (ARCHITECTURE 5.2) over the Events API (HTTP push) and the Web API.

- Config: `botToken` (`xoxb-…`) and `signingSecret`, both secret fields kept in the vault; `apiBase` for tests.
- Inbound: Slack posts to `/hooks/channels/<bindingId>/events` (shown with a Copy button in Settings → Channels).
  Every request is checked with the signing secret (HMAC-SHA256 over `v0:<timestamp>:<raw body>`, timing-safe,
  refused outside a 5-minute window) before the body is read; `url_verification` is answered only when signed.
- `sender.externalId` is `<team>:<user>` (Slack user ids are unique only inside one workspace), so the owner link
  and allowed senders are keyed on team + user. Events for another workspace are ignored.
- `externalId` is `<channel>:<ts>`; `message` and `app_mention` for the same message, and Slack's retries, come in
  once. `mentionsBot`: a DM, an `app_mention`, or a `<@bot>` token in the text.
- Out: `chat.postMessage` (split at 4000 characters), `chat.update` for the "working…" edit (the overflow is posted
  as follow-ups and edited in place later), 429 retried after `Retry-After`; `invalid_auth` and friends =
  `auth_failed`. Errors carry the Slack error code only, never the token. Every outbound text (send, edit and
  follow-ups) is plain text: `&`, `<` and `>` are escaped, so an agent's reply (which may quote injected input)
  never turns into `<!channel>` / `<!here>` / `<@user>` pings or a masked `<url|label>` link.
- Not yet: file download/upload (W7), Socket Mode.

Proof: `pnpm vitest run channels/slack` runs `runChannelContract('slack')` plus signature, dedupe, workspace and
mention/allowed-sender tests against a mocked Web API on 127.0.0.1 (no network, no account).
