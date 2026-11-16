-- Simplify: per-user UI preferences that follow a person across devices (`ui.pins`: the features they pinned to
-- the sidebar, in order). Own row only (REST `/api/v1/me/prefs`); a new table, so an existing database keeps every
-- row it has. The instance-wide "Not using this" list lives in `settings` (`features.hidden`), not here.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
