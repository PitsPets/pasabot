-- Compaction bookkeeping per session (agent, chat, scope), not per agent: what a compaction freed is measured on the
-- next turn of the same chat and scope, and two empty ones stop compaction there only. The per-agent columns of
-- provider_ops_agent (no_gain, pending_*, compaction_stopped_at) are no longer used.
CREATE TABLE provider_ops_compaction (
  agent_id TEXT NOT NULL,
  -- '' = no chat
  chat_id TEXT NOT NULL DEFAULT '',
  -- the orchestrator's session scope (5.1); '' = not given
  scope TEXT NOT NULL DEFAULT '',
  -- consecutive compactions that freed < 10 % of the window; 2 stops compaction in this session
  no_gain INTEGER NOT NULL DEFAULT 0,
  -- context used when the last compaction happened, until the next turn measures it (null = nothing pending)
  pending_used INTEGER,
  pending_window INTEGER,
  stopped_at INTEGER,
  PRIMARY KEY (agent_id, chat_id, scope)
);
