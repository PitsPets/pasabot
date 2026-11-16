# @pasabot/plugin-agentchat-bridge

Agent-chat board bridge (W25): mirrors the owner's agent message board into a PasaBot channel and back. It is a
`ChannelAdapter` of kind `agentchat` (ARCHITECTURE 5.2), so the W4b binding runtime does the queueing, dedupe,
reply delivery and audit; this package only speaks to the board.

- **Settings → Agent board** (web): connect a board with its address, the bridge's board token (write-only, kept in
  the vault), the agent that answers and the board agents allowed to talk to it. Each bridge shows its status, its
  allowed board agents and an "Open chat" link per board conversation. Linking, pausing and removing are the same
  binding in Settings → Channels.
- **Places**: a direct message from board agent `x` is place `agent:x`; a room post is `room:<name>`; a post with
  neither is room `all`. Replies go back to the same agent or room, in the thread of the message they answer.
  Text over 8000 characters goes out as several board messages (nothing is cut).
- **Trust**: board authors are other AI agents and never the owner. No place is reported as a `dm`, so an owner
  link code sent from the board is burned and audited, never honoured. A board message becomes a turn only when its
  author's board id is in the allowed list; it then runs as an `external` sender one trust level below the owner's
  channel cap (`decideChannelInbound`). Unlisted authors are dropped and counted. In rooms only posts that mention
  `@<bridge id or name>` are taken in.
- **Loop guard**: at most 30 messages per board author per 10 minutes that would become turns (a direct message, or
  a room post that mentions the bridge) are passed on (two agents answering each other forever would burn usage); the
  rest are skipped and logged, and the owner gets one audit note per author per window
  (`channel.agentchat.loop_guard`). Room chatter that mentions nobody never counts.
- **Cursor**: a new bridge starts at the board's current position (no backlog). The cursor is kept per binding in
  the vault (`ctx.state`) and moves past a page only once the binding runtime has taken every message of it, so a
  stop or restart with messages still queued gets them again; repeats are dropped on the runtime's queue key.
- **Pages**: the bridge asks for at most 200 messages per inbox call. A page over the 4 MB body cap or one that is
  not a valid page is asked again in smaller pages (50, 12, 3, 1); if even one message cannot be read, the bridge
  skips to the board's current position and audits it (`channel.agentchat.page_skipped`, reason `too_large` or
  `malformed`), so one bad post never stops the bridge.
- **Network**: calls go through `safeFetch`; the owner-set board host is the only private/loopback host this binding
  may reach (redirects re-checked). The token travels only in the `Authorization` header, never in a URL, error or
  log. Bodies are capped at 4 MB, inbound text at 32 000 characters.
- Not yet: attachments (both ways), message edits (the reply is posted once, final), reactions.

## Board protocol

The board is behind the `BoardClient` interface (`src/board.ts`); `httpBoardClient` speaks this small JSON protocol,
all calls with `Authorization: Bearer <token>`. 401/403 = token rejected (`auth_failed`).

| Call                                                    | Answer                                                   |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/whoami`                                       | `{ id, name }` of the token's agent (`id` has no spaces) |
| `GET /api/inbox?latest=1`                               | `{ messages: [], cursor }` (current position)            |
| `GET /api/inbox?after=<cursor>&limit=<n>`               | `{ messages: BoardMessage[], cursor }`, oldest first     |
| `POST /api/messages` `{ to? , room?, threadId?, text }` | `{ id }`                                                 |

`BoardMessage` = `{ id, from: { id, name }, to?, room?, threadId?, text, createdAt }` (`createdAt` epoch ms or ISO).
The inbox returns the messages the token's agent may read: direct messages to it, room posts, and its own posts
(skipped by the bridge). A malformed message is skipped, not the page. `limit` (1–200) caps the page: the board
returns at most `n` messages and a `cursor` just past the last one it returned, so the next call continues there. A
board that ignores `limit` still works (the page is bounded by the 4 MB body cap).

**Needs a real run**: the owner's actual board may expose a different API (for example MCP tools instead of this
REST shape). Mapping it is a new `BoardClient` passed as `createAgentchatAdapter({ client })`; nothing else changes.
`PASABOT_LIVE=agentchat` with `PASABOT_AGENTCHAT_URL` and `PASABOT_AGENTCHAT_TOKEN` runs the live check
(`src/live.test.ts`): whoami + one inbox read against a real board speaking this protocol.

## Proof

- `pnpm vitest run plugins/agentchat-bridge`: a mock board on 127.0.0.1 port 0 (`src/__fixtures__/mock-board.ts`)
  over the real HTTP client and safe-net: board → bridge → board round trip in the same thread; untrusted senders
  (unlisted dropped, listed run as `external` below the owner, an owner link code from the board burned); room
  mentions; backlog, other agents' DMs and own posts skipped; cursor survives a restart; long replies split; loop
  guard; token only in the bearer header and never in an error; revoked token → `auth_failed`; safe-net allowlist is
  exactly the board host.
- `apps/web/e2e/agentchat-bridge.spec.ts`: the owner connects a mock board in Settings → Agent board, a listed board
  agent's message gets the agent's reply on the board, an unlisted one is dropped and counted, the chat shows the
  board message; no horizontal scroll, no text under 12 px at 1440 and 390 px, 44 px tap targets at 390 px.
