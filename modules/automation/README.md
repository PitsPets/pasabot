# @pasabot/mod-automation (W21)

Local scripts and the `pasabot` CLI start work on an agent with a per-agent automation token.

## Owner (Settings → Automation, or `pasabot token` / `pasabot list` after `pasabot login`)

- A switch per agent. Off: the agent's tokens cannot start runs (403 `automation_off`); issuing a token needs it on.
- Tokens: name, expiry (30/90/365 days or never), "also from other devices" (`remote_ok`). Trust is `standard`
  (or `guarded`), never more. The raw token is shown once; only its hash is stored. Revoke at any time.

REST (owner session only; widening is never a tool, ARCHITECTURE 7.4): `GET agents`, `PUT agents/:id {enabled}`,
`GET tokens`, `POST tokens {agentId, label, trust?, remoteOk?, ratePerHour?, expiresInDays?}`,
`POST tokens/:id/revoke`. Cutting access stops work: a revoke cancels that token's unfinished runs and the switch
turned off cancels the agent's (both answer `cancelledRuns`); every `automation.run` is also re-checked right
before it runs (queue `admit`), so one whose token was revoked or expired, or whose switch is off, never runs.

## Scripts (automation token, `Authorization: Bearer …`, no `Origin` header)

- `GET /api/m/automation/whoami`
- `POST /api/m/automation/runs {text, agent?}` → 202 `{run}`; 429 + `Retry-After` past the token's hourly budget
  (default 30); 403 when the switch is off, the token lacks the `runs` scope, or `agent` names another agent.
- `GET /api/m/automation/runs/:id?wait=<ms ≤ 60000>` → `{run: {state, reply, error, …}}` (long-poll).
- `GET /api/m/automation/runs/:id/stream` → server-sent events `state`, `delta` (reply so far), `done`.

A token sees only the runs it started. The core's resolver refuses a token with any `Origin` header, from a
non-loopback address unless `remote_ok`, expired, revoked, or of an archived agent (401). Runs go into the agent's
own automation chat as queue kind `automation.run` (an interrupted one never blocks the queue), sent by the token
(`kind: 'automation'`, trust ≤ `standard`), so tier 2 and 3 always ask the owner.

## CLI

```
pasabot token create tala [--label laptop] [--days 30 | --no-expiry] [--remote] [--enable] [--print]
pasabot list
pasabot run tala "sum 2+2" --wait        # or --stream, --json
pasabot token revoke <id>
pasabot pair [--url https://phone-reachable-address]   # terminal QR to pair a phone
```

`pasabot pair` shows and confirms only the claim made on the code it printed (never an older pending claim), with
the device name's control characters made visible and the server fingerprint to compare; there is no auto-confirm.
The link uses `--url`, else the server's `PASABOT_PUBLIC_URL`; a loopback link gets a warning (a phone cannot open it).

Tokens are saved 0600 in `$XDG_CONFIG_HOME/pasabot/automation.json`; `PASABOT_AUTOMATION_TOKEN` overrides.

## Proofs

- `pnpm vitest run modules/automation` (API + the real CLI against a booted server).
- `pnpm --filter @pasabot/mod-automation test:e2e` (Settings → Automation at 1440 and 390 px; needs `apps/web/dist`).
