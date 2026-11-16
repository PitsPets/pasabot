-- Computer use (W16, ARCHITECTURE 3.2). Every table carries the `computer_` prefix.
-- One row per action on an agent display, by the agent (through an approved tier-3 tool) or by the owner (viewer).
CREATE TABLE computer_action (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  -- 'agent' | 'owner'
  actor TEXT NOT NULL,
  -- 'screenshot' | 'click' | 'move' | 'type' | 'key'
  kind TEXT NOT NULL,
  -- redacted summary (typed text passes the 7.3 filter)
  detail TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  at INTEGER NOT NULL
);
CREATE INDEX computer_action_agent ON computer_action (agent_id, at);
CREATE INDEX computer_action_at ON computer_action (at);

-- Owner settings (key/value). `macos_opt_in` = '1' lets agents control this Mac's own screen.
CREATE TABLE computer_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
