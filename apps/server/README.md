# @pasabot/server

W0a parts: `src/core` (event bus + `events` ring, WS `/ws` with resume/`gap`, crash-safe queue, dispatcher, minimal provider
run executor, registries, in-app notifier, bearer token lookup) and `src/host` (discovery, ModuleHost, `/api/m/<id>`,
`/hooks/<id>`, the separate sites listener, `startServer`). Auth flows, vault, approvals, MCP and the runner are W0b.
Proofs: `pnpm test:sdk`, `test:ws-resume`, `test:crash`, `test:queue-priority`.
