# @pasabot/mod-workflows (W9)

Workflows: a graph of steps that runs agents and the owner's decisions in order.

- **Steps:** `agent` (a turn on the `workflow` queue kind, with tools), `model` (the same agent's model with
  `tools: 'none'`), `condition` (only the chosen branch continues; the other branch is skipped), `approval`
  (waits for the owner; a rejection stops the run), `transform` (`{{input}}` / `{{node.<id>}}` text), `wait`,
  `parallel` (fan-out), `output` (in-app notification). **Channel posts are not delivered yet:** an output step
  with `to: 'channel'` fails with "posting to a channel is not available yet", because modules have no channel
  send port that reports failure and checks the tier-2 "post to an outside channel" rule against the run's sender.
- **`matches` conditions:** patterns that make a backtracking engine slow (a repeated group holding a repeat or a
  choice, back-references, look-arounds, more than 8 repeats, over 200 characters) are refused at save time; the
  test itself runs in a worker thread on at most 2,000 characters with a 250 ms timeout, and a timeout is false.
- **Joins:** a step with several inputs waits for all of them; it is skipped when none delivered a result (all
  failed, skipped or not taken), and runs with the inputs that did.
- **Loops:** an edge back to an earlier step; every trip round counts against `maxIterations` (default 10, max
  100); over the cap the run stops (`stopped`).
- **Crash safety:** each transition (a step ends, its signals travel, the next steps are written or skipped) is one
  SQLite transaction. After a restart, `running` steps run again (agent steps are idempotent by queue idem key
  `workflow:<stepId>`), `waiting` steps are re-checked, finished steps never run twice. An output step may send
  its notification twice if the server dies in the middle of sending it.
- **Trust:** a run acts as its sender: the owner for an owner-made workflow run by the owner, otherwise the
  creating agent, at `min(created_trust, …)`; every agent step is capped at the agent's own trust. A step whose
  input can carry an earlier agent's or model's text (an agent/model step before it, a transform pulling
  `{{node.…}}`, or a later trip round a loop) never acts as the owner: it runs as a non-owner sender, one trust
  level lower, and never auto-approves tier 2+ (ARCHITECTURE 7.1, 7.4). Agent edits
  never raise `created_trust`. An agent may only build workflows whose agent/model steps run itself.
- **Templates:** `fan-out` ("answer, then share"): agent A answers, B, C … each get A's answer at once (routine
  flows as graph templates).
- **Approvals:** approval steps are the module's own (owner-session REST + a notification), because core
  `approvals` rows are bound to a provider run.

REST (`/api/m/workflows`, owner session): `GET/POST /workflows`, `POST /workflows/from-template`,
`GET/PATCH/DELETE /workflows/:id`, `POST /workflows/:id/run`, `GET /runs`, `GET /runs/:id`,
`POST /runs/:id/steps/:stepId/{approve,reject}`, `POST /runs/:id/cancel`.

Agent tools: `workflows_list` (tier 0), `workflows_create` / `workflows_update` / `workflows_run` (tier 2),
`workflows_delete` (tier 3, always asks).

Web: the **Workflows** page (nav) with the xyflow canvas editor; every drag action also has a tap path (add
after the selected step, link from a list), so it works at 390 px.

Tests: `pnpm vitest run modules/workflows` (engine + REST + tools) and `apps/web/e2e/workflows.spec.ts`
(Playwright: build, run, approve on a phone viewport).
