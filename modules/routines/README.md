# `routines` — run an agent by hand, on a schedule, or when something calls in (W8)

| Trigger    | Spec                                                                           | Sender of the turn                                 |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| `manual`   | `{}`                                                                           | owner (owner-made routine) or `agent` (agent-made) |
| `schedule` | `{ cron, tz, catchUp? }` (5-field cron, IANA tz)                               | same as manual                                     |
| `webhook`  | `{}` (owner-created only)                                                      | `webhook`, trust ≤ `standard`                      |
| `github`   | `{ events: ['push', 'pull_request.opened'], installId? }` (owner-created only) | `webhook`, trust ≤ `standard`                      |
| `event`    | `{ topic, type, filter? }` (JsonLogic subset)                                  | `system`, trust ≤ `standard`                       |

Every fire runs at `min(created_trust, agent trust, sender trust)`; agent-made routines are never owner turns, and
the fire payload is appended to the prompt as a fenced, labelled data block (it never sets tools, trust or approvals).

- **Targets**: `chat` = the agent's own direct chat; `thread` = a new chat (fresh provider session) whose prompt
  carries a handoff of the last 10 messages of the own chat.
- **Silent marker**: a reply of exactly `(quiet)` stores the fire as `silent` and sends no notification; an `ok`
  fire notifies, failures are notified by the core.
- **Scheduler**: re-reads the routine (exists, enabled, same trigger) right before firing; the `routines_fire` row is
  written before `sched_last_at` advances, and the queue item's idem key `schedule:<id>:<slot>` makes a re-fire of the
  same slot a no-op. Slots missed while down fire once on boot with `catchUp: true`, else are skipped and logged.
- **Webhook contract** (`POST /hooks/routines/<token>`): `X-PasaBot-Timestamp` (unix seconds or ms, ±5 min),
  `X-PasaBot-Delivery` (`[\w.:-]{1,128}`), `X-PasaBot-Signature: v1=<hex HMAC-SHA256 of "v1:{ts}:{delivery}:{body}">`.
  202 accepted / duplicate, 401 bad or stale, 413 > 64 KiB, 429 + `Retry-After` (60 per minute per client),
  503 paused or queue full. Delivery ids live in `queue_items.idem_key = webhook:<routine>:<delivery>`. At most 64
  webhook + GitHub routines per server. The URL token is stored only as a hash; the 32-byte secret lives in the vault.
- **GitHub** (`POST /hooks/routines/gh/<token>`): `X-Hub-Signature-256` over the body with the routine's secret,
  `X-GitHub-Delivery` as the idem key, `ping` and unlisted events answered 202 without a fire.
- **REST** (owner session, `/api/m/routines`): `GET/POST /routines`, `PATCH/DELETE /routines/:id`,
  `POST /routines/:id/{run,test,rotate-secret}`, `GET /activity`, `GET /calendar.ics` (next 30 days).
- **Agent tools**: `routines_list` (tier 0), `routines_pause` (1), `routines_create` (2; manual / schedule / event
  only), `routines_delete` (3). An agent-made event routine may only listen to `agent:<its own id>` or `chat:<id>` of
  a chat the agent is a member of (checked at create, on owner edits, and again at every fire); never `global`,
  `module:*` or `run:*`.
- **Loop guard**: an event routine never fires on anything a routine run caused (its messages, run events, approvals,
  run end), whichever routine fired it: the fire row learns its run id when the run starts. Event types every fire
  causes (`notification`, `queue.changed`) cannot be listened to, and event fires are capped per routine (default 20
  per hour). So routine chains (routine B on routine A's run) do not fire; that is by design.
- **Events** (`module:routines`): `routines.fired`, `routines.finished`, `routines.changed`.

Boundary: core chats, messages and queue keys are used only through `ModuleHost.chats` and `queue.hasIdem`;
`raw` touches only `routines_*` tables.

Proof: `npx vitest run modules/routines` (fake clock cron, webhook contract incl. restart, 65th routine, payload
cannot grant, agent-created trust, GitHub fixture, silent run, iCal, thread handoff, event loop guard).
