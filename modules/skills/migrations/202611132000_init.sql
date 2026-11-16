-- Skills library (ARCHITECTURE 3.2). The files of each revision live on disk under
-- $PASABOT_HOME/modules/skills/library/<skill id>/<rev>/; these rows are the index.
-- source: 'local:<folder>', 'git:<url>#<commit>', 'zip:<file name>', 'builtin:<name>', 'created'.
-- created_by: 'owner' or 'agent:<id>'; created_trust: the effective trust of whoever installed it (7.4).
CREATE TABLE skills_skill (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  current_rev INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_trust TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE skills_revision (
  skill_id TEXT NOT NULL REFERENCES skills_skill (id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  sha TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_trust TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, rev)
);

CREATE TABLE skills_agent (
  skill_id TEXT NOT NULL REFERENCES skills_skill (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (skill_id, agent_id)
);
CREATE INDEX skills_agent_agent ON skills_agent (agent_id, enabled);
