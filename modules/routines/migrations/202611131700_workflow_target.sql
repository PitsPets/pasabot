-- A routine can target a workflow (W8 + W9): the trigger starts a run of `workflow_id`. The target CHECK cannot be
-- changed in place, so routines_routine is rebuilt. routines_webhook references it with ON DELETE CASCADE, so its
-- rows are kept aside and the table is dropped first (dropping the parent then cascades nowhere), then restored.
CREATE TABLE routines_webhook_keep AS SELECT * FROM routines_webhook;
DROP TABLE routines_webhook;

CREATE TABLE routines_routine_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL CHECK (json_valid(trigger)),
  target TEXT NOT NULL CHECK (target IN ('chat', 'thread', 'workflow')),
  -- the workflow a `workflow` target starts
  workflow_id TEXT,
  created_by TEXT NOT NULL,
  created_trust TEXT NOT NULL CHECK (created_trust IN ('guarded', 'standard', 'trusted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sched_last_at INTEGER,
  CHECK ((target = 'workflow') = (workflow_id IS NOT NULL))
);
INSERT INTO routines_routine_new (id, agent_id, name, prompt, enabled, trigger, target, created_by, created_trust,
  created_at, updated_at, sched_last_at)
  SELECT id, agent_id, name, prompt, enabled, trigger, target, created_by, created_trust, created_at, updated_at,
    sched_last_at FROM routines_routine;
DROP TABLE routines_routine;
ALTER TABLE routines_routine_new RENAME TO routines_routine;
CREATE INDEX routines_routine_agent ON routines_routine (agent_id);

CREATE TABLE routines_webhook (
  routine_id TEXT PRIMARY KEY REFERENCES routines_routine (id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL,
  secret_ref TEXT NOT NULL CHECK (json_valid(secret_ref)),
  path_token_hash TEXT NOT NULL UNIQUE,
  rotated_at INTEGER
);
INSERT INTO routines_webhook SELECT * FROM routines_webhook_keep;
DROP TABLE routines_webhook_keep;

-- the workflow run a fire started (its result follows the run's end)
ALTER TABLE routines_fire ADD COLUMN workflow_run_id TEXT;
CREATE INDEX routines_fire_workflow_run ON routines_fire (workflow_run_id);
-- a workflow fire has no queue item to carry the idempotency key, so the fire row carries it (redelivery = once)
ALTER TABLE routines_fire ADD COLUMN idem_key TEXT;
CREATE UNIQUE INDEX routines_fire_idem ON routines_fire (idem_key) WHERE idem_key IS NOT NULL;
