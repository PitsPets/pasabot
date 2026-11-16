-- Workflows (ARCHITECTURE 3.2). Every table carries the `workflows_` prefix.
CREATE TABLE workflows_def (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  graph TEXT NOT NULL CHECK (json_valid(graph)),
  version INTEGER NOT NULL DEFAULT 1,
  -- `user:<id>` or `agent:<id>`
  created_by TEXT NOT NULL,
  created_trust TEXT NOT NULL CHECK (created_trust IN ('guarded', 'standard', 'trusted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflows_run (
  id TEXT PRIMARY KEY,
  def_id TEXT NOT NULL,
  def_version INTEGER NOT NULL,
  -- the graph as it was when the run started; later edits never change a running run
  graph TEXT NOT NULL CHECK (json_valid(graph)),
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'rejected', 'stopped', 'cancelled')),
  -- { inbox: { nodeId: { edgeId: signal } }, chats: { agentId: chatId }, input }
  ctx TEXT NOT NULL CHECK (json_valid(ctx)),
  iterations INTEGER NOT NULL DEFAULT 0,
  -- the SenderInfo every agent step of this run acts as
  sender TEXT NOT NULL CHECK (json_valid(sender)),
  started_by TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX workflows_run_def ON workflows_run (def_id, created_at);
CREATE INDEX workflows_run_state ON workflows_run (state);

CREATE TABLE workflows_step (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflows_run (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  iter INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'skipped', 'cancelled')),
  input TEXT,
  output TEXT CHECK (output IS NULL OR json_valid(output)),
  queue_item_id TEXT,
  agent_run_id TEXT,
  chat_id TEXT,
  resume_at INTEGER,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (run_id, node_id, iter)
);
CREATE INDEX workflows_step_queue ON workflows_step (queue_item_id);
CREATE INDEX workflows_step_wait ON workflows_step (state, resume_at);
