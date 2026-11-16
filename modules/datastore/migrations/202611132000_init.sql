-- Shared datastore (ARCHITECTURE 3.2): metadata only. The tables themselves live in a separate SQLite file
-- (`datastore.db` in the module's data dir), never in pasabot.db. One row per agent-made table: which agent
-- created it (only that agent may alter or drop it) and when. Names compare without case, as SQLite's do.
CREATE TABLE datastore_table (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  owner_agent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX datastore_table_owner ON datastore_table (owner_agent_id);
