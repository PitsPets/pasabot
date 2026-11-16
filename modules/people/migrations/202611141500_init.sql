-- W23 people: invites (token stored as a hash only) and the agents the owner lets members use.
CREATE TABLE people_invite (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('member','guest')),
  chats TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(chats)),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  revoked_at INTEGER
);
CREATE TABLE people_shared_agent (
  agent_id TEXT PRIMARY KEY,
  shared_by TEXT NOT NULL,
  shared_at INTEGER NOT NULL
);
