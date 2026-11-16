-- Admin/ops (W19, ARCHITECTURE 3.2). Every table carries the `admin_` prefix.
-- One machine sample per tick; pruned to 7 days.
CREATE TABLE admin_metric (
  at INTEGER NOT NULL,
  cpu REAL,
  mem REAL,
  disk REAL,
  load REAL
);
CREATE INDEX admin_metric_at ON admin_metric (at);
-- Alert rules: rule = { name, metric, above, forSamples, cooldownMin, level }.
CREATE TABLE admin_alert (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL CHECK (json_valid(rule)),
  created_at INTEGER NOT NULL,
  last_fired_at INTEGER
);
