-- Detached approvals (W9): a workflow's approval step is a core approval with no agent run behind it. run_id and
-- agent_id become optional, `subject` says what such an approval is about and `href` where the owner sees it.
-- SQLite cannot relax NOT NULL in place, so the table is rebuilt; nothing references `approvals`, so dropping the
-- old table cascades nowhere. Every existing row is copied as it is.
CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id),
  agent_id TEXT REFERENCES agents(id),
  subject TEXT,
  href TEXT,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  action TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action)),
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','expired')),
  decided_by TEXT,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  -- an agent run's approval names its run and agent; a detached one names its subject
  CHECK ((run_id IS NOT NULL AND agent_id IS NOT NULL) OR subject IS NOT NULL)
);
INSERT INTO approvals_new (id, run_id, agent_id, tier, action, summary, state, decided_by, decided_at, expires_at)
  SELECT id, run_id, agent_id, tier, action, summary, state, decided_by, decided_at, expires_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE UNIQUE INDEX approvals_pending_subject ON approvals (subject) WHERE state = 'pending' AND subject IS NOT NULL;
CREATE INDEX approvals_state ON approvals (state, expires_at);
