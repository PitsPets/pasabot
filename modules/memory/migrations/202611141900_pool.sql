-- W33 shared memory pool. Scopes travel to every backend as the item's `agentId`: NULL = global, an agent id =
-- that agent's private memory, `team:<id>` = a team. The rows below are kept by this module whichever backend holds
-- the text: teams, provenance/conflict data per item, and the owner's merge queue.
CREATE TABLE memory_team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE memory_team_member (
  team_id TEXT NOT NULL REFERENCES memory_team (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);
CREATE INDEX memory_team_member_agent ON memory_team_member (agent_id);

-- Provenance is set by the server (never by the writer's claim): who wrote it, at what trust, when.
-- state: live | superseded (a later value for the same key won) | deleted (owner delete, edit, or forget)
CREATE TABLE memory_meta (
  backend TEXT NOT NULL,
  item_id TEXT NOT NULL,
  scope_key TEXT,
  key TEXT,
  confidence TEXT CHECK (confidence IN ('low', 'high')),
  writer_kind TEXT NOT NULL CHECK (writer_kind IN ('owner', 'agent', 'import')),
  writer_agent_id TEXT,
  writer_trust TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'superseded', 'deleted')),
  PRIMARY KEY (backend, item_id)
);
CREATE INDEX memory_meta_key ON memory_meta (backend, scope_key, key, state);

-- Two differing high-confidence values for one key: the incoming one waits here (not in any backend) for the owner.
-- Resolving clears the incoming text, so a dropped value is gone everywhere.
CREATE TABLE memory_merge (
  id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  scope_key TEXT,
  key TEXT NOT NULL,
  current_id TEXT NOT NULL,
  incoming_text TEXT NOT NULL,
  incoming_tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(incoming_tags)),
  incoming_source TEXT,
  writer_kind TEXT NOT NULL,
  writer_agent_id TEXT,
  writer_trust TEXT NOT NULL,
  origin_sender TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
CREATE INDEX memory_merge_open ON memory_merge (resolved_at, created_at);
