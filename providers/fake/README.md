# @pasabot/provider-fake

The reference `ProviderAdapter`. Replays `[{ after, event }]` scripts and `{ expectPermission: { tool, decision } }` steps
(emits `permission`, asserts the server's answer). Default script echoes the user text; a user text of
`{"fakeScript": [...]}` runs that script. `{ callTool: { name, args } }` steps call a tool on the run's own MCP gateway
(loopback, run bearer) and reply `tool said: <text>`; a user text of `{"probe": {"name": "...", "args": {...}}}` is the
one-step form. Files attached to the turn are echoed as ` [files: name (size B)]`. Proof: `pnpm test:contract`.
