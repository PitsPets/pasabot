-- W31 global kill switch (ARCHITECTURE 12): one stored flag, read at boot before the queue dispatches. The single
-- row (id = 1) carries who stopped, why, and the last stop's report (JSON) so the owner can read it after a restart.
CREATE TABLE kill_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0,
  since INTEGER,
  actor_kind TEXT,
  actor_id TEXT,
  reason TEXT,
  report TEXT CHECK (report IS NULL OR json_valid(report)),
  resumed_at INTEGER,
  resumed_by TEXT
);
INSERT INTO kill_switch (id, stopped) VALUES (1, 0);
