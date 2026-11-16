# @pasabot/mod-people (W23)

Optional extra people on a single-owner server.

- **Invites**: the owner makes a link (member or guest, the chats it opens, can write or read only, 3-day expiry).
  The token is stored only as a hash, works once, and rides in the URL fragment (`/#/join?invite=…`), so it never
  reaches a server log. The accept page is a signed-out web route (`RouteDef.public`) that talks only to this
  module's `publicHttp` hooks (`POST /hooks/people/invite`, `POST /hooks/people/accept`, rate-limited).
- **Roles**: a guest sees only the chats they were added to (and only those chats' agents); a member also opens
  direct chats with agents the owner shares ("import" an agent). The server keeps its one owner; members and guests
  run as their own sender kind and never get owner trust. A member's direct chat is never taken for the agent's own
  main chat (routines). Unsharing an agent closes members' chats with it (archived, members removed, their turns
  there cancelled; the owner keeps the history). Turning a person off ends their sessions and cancels their queued
  and running turns; the queue refuses anything they asked for.
- **Per-chat membership**: the chat header's People sheet lists who is in the chat; the owner adds people, makes
  them read only, or removes them. People page: invite, open invites, everyone (turn off / on), shared agents.
- **Core access** only through `ModuleHost.people` (the `PeoplePort`, real only for this module), which checks every
  actor itself and audit-logs (`people.*`). Own tables: `people_invite`, `people_shared_agent`.

Proofs: `pnpm vitest run modules/people` (a guest invited to one chat sees only it over REST and WS, invite
single-use/expiry/revoke, observer/member roles, disabling ends sessions and cancels their turns, member agent import runs as the member,
unsharing cuts members off, a member's chat is never the agent's own chat, no other module gets the port) and `pnpm --filter @pasabot/mod-people test:e2e` (1440 + 390 px: invite → accept →
only that chat → removed; a member imports a shared agent and signs in again as the remembered account).
