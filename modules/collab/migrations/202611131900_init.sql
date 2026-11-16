-- W6 collaboration (ARCHITECTURE 3.2): agent-to-agent tasks and multi-agent channel teams.
-- collab_task: one row per message / delegation / handoff / file sent from one agent to another.
CREATE TABLE collab_task (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('delegate', 'message', 'handoff', 'file')),
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  from_run_id TEXT,
  from_chat_id TEXT,
  to_chat_id TEXT,
  queue_item_id TEXT,
  text TEXT NOT NULL,
  trust TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  reply TEXT,
  reply_run_id TEXT,
  waiting INTEGER NOT NULL DEFAULT 0,
  return_reply INTEGER NOT NULL DEFAULT 0,
  ack_requested INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX collab_task_item ON collab_task (queue_item_id);
CREATE INDEX collab_task_from ON collab_task (from_agent_id, created_at);
CREATE INDEX collab_task_to ON collab_task (to_agent_id, created_at);

-- collab_team: per multi-agent channel controls; state active / stopped / archived; backup = {providerId, model?}
CREATE TABLE collab_team (
  chat_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped', 'archived')),
  silent_retry INTEGER NOT NULL DEFAULT 1,
  backup TEXT CHECK (backup IS NULL OR json_valid(backup)),
  updated_at INTEGER NOT NULL
);

-- collab_silent: the follow-up items the silent-lead rule queued (stage retry, then backup)
CREATE TABLE collab_silent (
  queue_item_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  origin_item_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('retry', 'backup')),
  created_at INTEGER NOT NULL
);
