-- Routines (ARCHITECTURE 3.2, 5.3). Every table carries the `routines_` prefix.
CREATE TABLE routines_routine (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- { kind, spec } of a TriggerSource
  trigger TEXT NOT NULL CHECK (json_valid(trigger)),
  target TEXT NOT NULL CHECK (target IN ('chat', 'thread')),
  -- `user:<id>` or `agent:<id>`
  created_by TEXT NOT NULL,
  created_trust TEXT NOT NULL CHECK (created_trust IN ('guarded', 'standard', 'trusted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- schedule state: the last slot handled (fired, skipped or missed); the next one is computed from it
  sched_last_at INTEGER
);
CREATE INDEX routines_routine_agent ON routines_routine (agent_id);

CREATE TABLE routines_webhook (
  routine_id TEXT PRIMARY KEY REFERENCES routines_routine (id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL,
  -- the vault reference ({ id, scope, name }) of the 32-byte HMAC secret
  secret_ref TEXT NOT NULL CHECK (json_valid(secret_ref)),
  path_token_hash TEXT NOT NULL UNIQUE,
  rotated_at INTEGER
);

CREATE TABLE routines_fire (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- manual | schedule | webhook | event | github | test
  source TEXT NOT NULL,
  -- pending until the run ends, then ok | silent | failed | interrupted (skipped = re-read refused the fire)
  result TEXT NOT NULL CHECK (result IN ('pending', 'ok', 'silent', 'failed', 'interrupted', 'skipped')),
  queue_item_id TEXT,
  chat_id TEXT,
  run_id TEXT,
  error TEXT,
  finished_at INTEGER
);
CREATE INDEX routines_fire_routine ON routines_fire (routine_id, at);
CREATE INDEX routines_fire_queue ON routines_fire (queue_item_id);
CREATE INDEX routines_fire_at ON routines_fire (at);
