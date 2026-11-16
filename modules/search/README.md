# @pasabot/mod-search (W7)

Message history search over the core `messages_fts` (FTS5) through `ChatPort.search`:

- `GET /api/m/search/messages?q=&chatId=&limit=` (session): owners search every chat, everyone else only chats
  they are a member of. Words are quoted (no FTS operators from input), the last word matches as a prefix.
- Tool `search_messages` (tier 0): an agent finds only chats it is a member of, narrowed to what the run's sender
  can read (owner turns: all of them; a member's or guest's turn: chats both can read; channel strangers,
  webhooks, automations: the run's own chat only; work from another agent: its own chat only when the sender that
  started the chain, `source.origin`, may read it, else nothing); results are marked untrusted.
- Web: the Search screen (`#/search`, nav item "Search"); a result opens its chat.

Tests: `pnpm vitest run modules/search`. Browser: build the web app (`apps/web`: `vite build`), then
`pnpm --filter @pasabot/mod-search test:e2e` (Playwright, desktop + 390 px).
