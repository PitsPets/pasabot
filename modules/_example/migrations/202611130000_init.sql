-- The reference module's own table: every module table carries the `<id>_` prefix.
CREATE TABLE _example_note (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
