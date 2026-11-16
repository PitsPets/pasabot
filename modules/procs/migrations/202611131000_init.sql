-- Background processes started through PasaBot tools (ARCHITECTURE 3.2). Every table carries the `procs_` prefix.
CREATE TABLE procs_proc (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  pid INTEGER NOT NULL,
  cmd TEXT NOT NULL,
  -- the module that reported it (`procs.started` publisher)
  reporter TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  stopped_by TEXT
);
CREATE INDEX procs_proc_agent ON procs_proc (agent_id, started_at);
CREATE INDEX procs_proc_live ON procs_proc (ended_at);
