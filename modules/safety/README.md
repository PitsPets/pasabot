# @pasabot/mod-safety (W31)

The safety suite: the global stop, skill permission manifests and per-run receipts.

## Global stop

- Core port `ModuleHost.killSwitch` (`KillSwitch`, `apps/server/src/core/kill-switch.ts`, table `kill_switch`). The flag is
  read at boot before the dispatcher leases anything.
- `POST /api/m/safety/stop` (owner session, automation token, run bearer): cancels running queue items, parks every
  waiting item as `held`, runs each module's `onStop` handler, returns the report. The `/mcp` gateway refuses every tool
  call while stopped.
- `POST /api/m/safety/resume`: owner session with a fresh re-auth (`POST /api/v1/auth/reauth`) only. Without re-auth
  401 `reauth_required`; tokens, agents and members 403. Linked machines and channels act through the port, whose
  `resume` refuses every actor but an owner.
- `GET /api/m/safety/state`: the flag and the last report. Web: the `topBarItems` control (Stop all / Stopped + Resume),
  report sheet, password sheet.

## Skill manifests

- `PUT /api/m/safety/skills/:id/manifest` `{ manifest: { tools, network: { hosts }, files: { workspaceOnly, paths },
  messaging }, files? }`: owner (trust `trusted`) or an agent run (lowest of the agent, the run's sender and an earlier
  version; never raised by an agent).
- A run whose queue payload names a `skill` may call only declared tools, hosts (`url`/`host` arguments), paths and
  messaging; anything else is refused at the gateway (`ToolRegistry.addGuard`) and noted on the receipt. A skill with no
  manifest may use no tool.
- `POST /api/m/safety/scan`: the pre-install scan in a worker thread (fixed patterns, 2 s timeout): download-and-run,
  credential paths, hidden text, exfiltration, text aimed at the model. Advisory only.

## Receipts

Built from bus events (`run.started`, `run.event`, `approval.requested/resolved`, `run.finished`, and the W32
budget's `budget.cost`, which sets the receipt's `cost` + `currency`: null while no price is set), redacted before
storing and again on export. `GET /receipts`, `GET /receipts/:id`, `POST /receipts/:id/export` (HTML on the sites
origin under a random path + JSON download), `GET/PUT /settings` (`retentionDays`, default 30; expired receipts and
their screenshots are deleted). Screenshots: a run event carrying `screenshot: { sha256 }` is copied into this module's
data dir so retention can delete it.

## Tests

`vitest run modules/safety`; e2e: `apps/web/e2e/safety.spec.ts` (1440 and 390 px).
