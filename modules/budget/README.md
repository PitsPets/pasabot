# @pasabot/mod-budget (W32)

Budgets and portable agents.

- **Costs.** Every finished run's `usage` is booked per agent, provider, model and task (`budget_usage`). Money comes
  only from the owner's price table (per model: input / output / cached per million tokens, one currency); a model
  without a price is **"price not set"** and adds nothing. Views: today and this month, by agent and by model
  (`GET /api/m/budget/summary?period=today|month`), recent tasks (`GET /tasks`). Each run publishes `budget.cost`
  on `agent:<id>` (W31 receipts read it).
- **Caps.** Per agent and global, per day and per month (`PUT /caps`). Caps and prices share **one currency**: once a
  cap exists a price or cap in another currency is refused (409 `currency_mismatch`), and `GET /caps` lists
  `uncovered` models (no price) whose spend no cap counts. A queue gate (core `QueueService.addGate`) checks every
  item before it runs: capped work is **held** until the period resets, a routine fire, or a step of a workflow a
  routine started, is **refused** (the routines module records the fire `skipped` with a `budget: …` reason). Real
  CLIs report `usage` once, at the end of a turn, so a live run's spend is the larger of its last usage and an
  estimate from what it streamed (reply text, thinking, tool calls and results, ~4 characters a token). A run whose
  spend crosses a cap mid-turn gets a 300 ms grace to end by itself, then it is cancelled; its partial reply stays.
  A turn whose answer is already in (`text.final` / `done`) is never cut. A run that never reports usage (cut,
  crashed, interrupted) is booked at its estimate (`estimated: true` in `/tasks`).
  A `budget.cap` card in the chat asks the owner to **raise** (must be higher) or **keep** the cap; only an owner
  session can (`POST /alerts/:id/raise|keep`); a raise releases the held work, which the gate checks again.
- **Encrypted whole-agent bundle.** `POST /bundles/export { agentId, passphrase, includeVault }` returns one file:
  the W19 agent export (config + chats, through the `AgentAdmin` port), the agent's own memory (with the W33 memory
  module: its private scope through `memory.pool()`, keeping key, confidence, writer and trust; otherwise its items
  from every registered backend), its workspace
  files (synced skills included, nothing under `.pasabot/`, no symlinks) and, only with `includeVault` and a fresh
  re-auth, its vault entries. Format `pasabot.agent-bundle.enc` v2: magic, a JSON header (format, version, scrypt
  N/r/p + salt, AES-256-GCM nonce) used as additional authenticated data, gzip'd JSON ciphertext, GCM tag; Node's
  built-in crypto only. `POST /bundles/import { data (base64), passphrase }` authenticates the whole file and checks
  every path (no `..`, absolute, drive, backslash, control characters or `.pasabot/` in any case; no two paths that
  differ only by case or Unicode normalization; no path that is both a file and a folder; the tree is rehearsed as
  empty files in a private temp folder) before writing anything, then
  creates a **new** agent (name clash → `Name (2)`) at no more than the server's default trust; memory comes back as
  `external` data at no more than that trust (W33 pool entries through the pool's all-or-nothing import, each
  capped at that trust).

Web: the **Budget** page (spending, price table, caps, move an agent) and the `budget.cap` card in chats.

Tests: `vitest run modules/budget` (booted server, scripted Fake brain); Playwright `pnpm --filter
@pasabot/mod-budget test:e2e` on the shared e2e server at 1440 and 390 px.

Not done: skills library rows (revisions, per-agent switches) are not recreated on import, only the skill files synced
into the workspace travel; W31 skill manifests do not travel (no cross-module port yet); team and global W33 scopes
stay on the server (only the agent's private scope travels); a routine run that is cut mid-turn by a cap is recorded as failed, not skipped; no currency
conversion; mid-run spend is an estimate until the adapters report usage as they go; if a workspace write still
fails after the agent was created, its files are taken back but the agent and its chats stay (the `AgentAdmin`
port has no delete) and the import answers 500 `import_incomplete`; a refused workflow step leaves the workflow run
`failed` (its fire is `skipped`).
