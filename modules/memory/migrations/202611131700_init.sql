-- Agent memory (ARCHITECTURE 3.2): one row per remembered item; agent_id NULL = shared by every agent.
-- A forgotten item keeps its row (forgotten_at set) but loses its text and tags, and leaves the index.
CREATE TABLE memory_item (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  source TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  forgotten_at INTEGER
);
CREATE INDEX memory_item_agent ON memory_item (agent_id, forgotten_at, id);

CREATE VIRTUAL TABLE memory_fts USING fts5(text, content = 'memory_item', content_rowid = 'rowid');

CREATE TRIGGER memory_item_ai AFTER INSERT ON memory_item BEGIN
  INSERT INTO memory_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER memory_item_ad AFTER DELETE ON memory_item BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER memory_item_au AFTER UPDATE OF text ON memory_item BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memory_fts (rowid, text) VALUES (new.rowid, new.text);
END;
