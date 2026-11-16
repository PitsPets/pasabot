# @pasabot/mod-admin (W19)

Server admin for the owner, at `#/admin` (nav item **Admin**). Every route is owner-session only.

- **Host identity**: server id, a name the owner picks, host name, system, uptime (`GET`/`PUT /api/m/admin/identity`).
- **Audit log viewer**: the core `audit_log`, newest first, filter by action prefix, paged by time (`GET /audit`).
  Targets and data pass the redaction filter. This module's own actions are audited as `admin.*`.
- **Machine metrics + alert rules**: CPU %, memory %, disk % (of the disk holding `$PASABOT_HOME`) and 1-min load,
  sampled every minute into `admin_metric` (kept 7 days). A rule (`metric`, `above`, `forSamples` in a row,
  `cooldownMin`, `level`) fires through the core `Notifier` and an `admin.alert` event on the `owner` topic.
- **Per-agent memory/CPU limits**: stored in `agents.limits` through the core `AgentAdmin` port and handed to
  `RunnerLimits.apply` (also for every agent at boot); `RunnerLimits.sample` shows current use. The core runner
  records limits only until the W20 launchers enforce them.
- **Diagnostics export**: a zip of generated summaries (identity, agents without instructions or paths, queue
  state counts, metrics, alerts, recent audit, `PASABOT_*` variable names only) and the last 256 KB of up to five
  files in `$PASABOT_HOME/logs`. Every file passes the redaction filter and is then checked again against every
  value the vault knows. No message rows.
- **Agent export/import bundle** (`pasabot.agent-bundle` v1, `agentBundleSchema` in `@pasabot/protocol`): config +
  the chats the agent is in (final messages). No secrets, paths, provider account or attachments. Import creates
  a new agent with fresh ids; bodies and every string in block data are redacted (both ways), unknown,
  attachment and prompt-card blocks (anything naming a `promptId`, with its typed answers) are dropped, a
  person's words from the file are stored as outside (`external`) text, never as the owner's, and trust is
  `min(bundle trust, server default)`, so a file never widens trust. The core port checks its actor (owner only)
  and only this module's host holds it.

Tests: `pnpm vitest run modules/admin` (scan test, fake-threshold alert, export → wipe → import, limits, owner
only). Browser: `cd modules/admin && npx playwright test` (1440 + 390 px on the shared e2e server; build the web
app first with `pnpm --filter @pasabot/web build`).
