-- W21 automation: the per-agent switch (+ the agent's automation chat), token labels, and the runs each token started.
CREATE TABLE automation_agent (
  agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE automation_label (
  token_id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
CREATE TABLE automation_run (
  queue_item_id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX automation_run_token ON automation_run (token_id, created_at);
