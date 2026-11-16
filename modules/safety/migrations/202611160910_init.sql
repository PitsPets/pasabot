-- W31 safety: receipts (one per agent run, built from server-side events) and skill permission manifests.
CREATE TABLE safety_receipts (
  id TEXT PRIMARY KEY, -- the run id
  agent_id TEXT NOT NULL,
  chat_id TEXT,
  queue_item_id TEXT,
  queue_kind TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  export_path TEXT
);
CREATE INDEX safety_receipts_started ON safety_receipts(started_at);

CREATE TABLE safety_receipt_items (
  receipt_id TEXT NOT NULL REFERENCES safety_receipts(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (receipt_id, n)
);

CREATE TABLE safety_skill_manifests (
  skill_id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  trust TEXT NOT NULL CHECK (trust IN ('guarded','standard','trusted')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('owner','agent')),
  created_by TEXT NOT NULL,
  findings TEXT CHECK (findings IS NULL OR json_valid(findings)),
  updated_at INTEGER NOT NULL
);
