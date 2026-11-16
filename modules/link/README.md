# modules/link — machine linking (W28)

Several PasaBot servers of one owner link directly, with no vendor account and no central server (ARCHITECTURE 11).
Each server stays the authority for its own agents, chats, vault and trust.

- **Linking**: Settings → Machines → "Show a link code" (random 128-bit secret, only its hash stored, 10 minutes,
  single use; shown as text and QR). The other owner enters it with the grant they give back and their password (a
  fresh re-auth); this owner then confirms the request with the grant the other machine gets, again with a re-auth.
- **Handshake** (`src/wire.ts`): `hello` both ways (protocol version + features + key + nonce), then `auth` both ways:
  a signature over both nonces, both keys, the agreed version and the code hash. The joiner checks the listener's
  key against the code's fingerprint before it sends anything, and the code hash never goes on the wire (the signed
  transcript is the proof). Version skew is refused with an "update this/that machine" message. Only pinned,
  unrevoked keys may make calls; nonces are single use. Addresses (in codes and link requests) must match
  `isLinkAddress` (never a leading `-`).
- **Grants** (per direction): `view` (machine and agent names), `chat` (proxied chats and agent messages), `manage`
  (reserved for remote routines/workflows; today the same as `chat`). A linked machine's turns run here as sender
  kind `link`, trust at most `standard`, so tier 2+ always asks this owner, and every run is this server's own.
- **Agents across machines**: tools `link_machines` and `link_message` (`agent@machine`, waits for the reply by
  default); trust = min(caller's turn, calling agent, receiving agent, grant). A turn a linked machine started
  (directly or handed on through local agents) cannot use them, so nobody reaches past the grant a machine gave or
  bounces turns between machines; a chain not started by the owner or a member asks this owner first (tier 2).
- **Introductions**: when a third machine links, the others get an offer (notification + Settings card); nothing is
  linked by it.
- **Unlink** revokes the key at once, tells the peer, closes open streams and cancels queued proxied work.
- The transport address is stored in the vault (`link/peer-address-<id>`), never shown or logged; the server's own
  long-term key is in the vault too (`link/identity-key`).

Transport: the real tailcat v0.7 CLI by default (`PASABOT_TAILCAT_BIN` to point at it; its keys live in this module's data dir under `tailcat/`). A link code names a short-lived linking-window address; both sides pin the other's tunnel key (`link_peer.transport_key`) and `--allow` lists only machines that are not unlinked; `PASABOT_LINK_TRANSPORT=tcp-tls` with
`PASABOT_LINK_HOST` / `PASABOT_LINK_PORT` / `PASABOT_LINK_ADVERTISE` for a LAN or tailnet address.

Proofs: `src/link.test.ts` (servers in one Vitest process over the in-memory transport) and `e2e/link.spec.ts`
(two servers, Settings → Machines, the switcher and a proxied chat, at 1440 and 390 px):
`npx vitest run modules/link packages/link-transport`, `cd modules/link && npx playwright test` (after building
`apps/web`).
