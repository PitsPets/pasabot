# @pasabot/mod-provider-ops (W3)

Installs the server's `ProviderPolicy` (ARCHITECTURE 5.1) and the screens around it.

- **Fallback chains.** Each agent has its own brain (the core agent form) plus up to five fallbacks (Settings →
  Brains and fallbacks). A turn that fails with `rate_limit`, `quota` or `auth` marks that brain (and account)
  paused until the reported reset (`retryAfterMs`), or until the next usage check (every 15 min) when none was
  reported; the orchestrator reruns the same item once on the next brain in the list and this module posts a
  switch notice in the chat. Later turns skip the paused brain; once the reset passes, the primary is tried again
  (a "back on" notice). Nothing left (or the fallback is limited too) → the orchestrator holds the item until the
  reset: the CLI's reported time, else this policy's `resumeAt()` (the earliest end of a limit on the chain, which
  lasts one usage check when no reset is known), then it resumes. It is never failed for a usage limit.
- **Switch keeps the chat.** Changing an agent's brain (core agent form) or falling back starts a new native session
  reseeded with our own transcript: `summarize()` (an extractive summary of older messages, no model call) plus
  the last 10 messages, drawn only from the same session scope's own turns (a guest's or webhook's words never
  reach the owner's session). A brain that missed turns (the fallback answered) never resumes its old session.
  Sessions are kept per brain and account.
- **Compaction.** After each turn that reports `contextUsed`/`contextWindow`, compaction runs at the agent's
  threshold (`compact_pct` here, else `agents.limits.contextPctCompact`, else 80 %; or an absolute token count):
  native when the CLI has `compact()`, else the session ends and the next turn is reseeded. What a compaction freed
  is measured on the next turn of the same chat and scope (`provider_ops_compaction`); two in a row that free less
  than 10 % of the window stop compaction in that chat and notify the owner; Settings has "Resume compaction".
- **Accounts.** Owner-made provider accounts, each with its own CLI config dir under `<$PASABOT_HOME>-accounts/<id>`
  (option `accountsDir`; never inside `$PASABOT_HOME`, which the runner sandbox hides), the one extra writable
  path of a run that uses it. Chosen per agent for the primary and per fallback entry. Settings shows each account's
  sign-in command (Claude, Codex, OpenCode) or folder, and whether its CLI is signed in (`adapter.detect(acct)`).
- **Usage.** Token counts per finished run (`run.finished`) → the Usage page (per agent, per brain, paused brains,
  "Check now") and the chat header context gauge (live via `provider-ops.context` on `chat:<id>`).

- **Brains page** (`#/settings/agents/brains`, no sidebar entry; `#/brains` redirects there; SPEC "Simplify" §5). One tile per brain (Claude, Codex, Free starter/OpenCode,
  Gemini, Grok, Local model = every `local:*`, Other ACP agents = every `acp:*`, then anything else registered),
  its state from the adapter's own read-only detection (Ready / Needs sign-in / Not installed / Not reachable; a
  sign-in that cannot be confirmed is Ready with a note), version, the install and sign-in commands (copy buttons;
  the free starter uses the templates module's checksum-verified installer; Grok's key goes into the vault), who uses
  it as main or backup, and the owner's **Test**: one tool-less prompt through `ProviderRegistry.probe` (no agent,
  run, chat or native session; 60 s; 6 per minute per server; result redacted and never stored), with the problem
  named (not installed, sign-in, usage limit, offline, model not found, timeout, crash). The agent form preselects
  `?brain=` and keeps the backup brain as the first fallback entry. PasaBot never asks for a brain's password.

REST (`/api/m/provider-ops`, session auth): `GET /chats/:chatId/context` (anyone who can read the chat), and
owner-only `GET /usage`, `POST /check`, `GET /settings`, `PUT /agents/:id`, `POST /agents/:id/compaction/resume`,
`POST /accounts`, `DELETE /accounts/:id`, `GET /accounts/:id/status`, `GET /brains?lang=`,
`POST /brains/:id/test` (`{ providerId?, model? }`; 429 over the limit).

Proofs: `pnpm vitest run modules/provider-ops` (booted server, scripted Fake brains) and
`pnpm --filter @pasabot/mod-provider-ops test:e2e` (Playwright at 1440 and 390 px; needs `apps/web` built).
