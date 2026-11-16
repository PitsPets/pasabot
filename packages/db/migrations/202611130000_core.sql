-- Core tables (ARCHITECTURE.md 3.1). ids are ULIDs, times are integer ms UTC, json columns are checked.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('owner','member','guest')),
  display_name TEXT NOT NULL,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports)),
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  platform TEXT,
  public_key TEXT,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, -- sha256 of the token
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '{"hue":200,"glyph":"*"}' CHECK (json_valid(avatar)),
  instructions TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL,
  model TEXT,
  provider_account_id TEXT REFERENCES provider_accounts(id),
  fallback TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fallback)),
  workspace_dir TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'standard' CHECK (trust_level IN ('guarded','standard','trusted')),
  limits TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits)),
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE provider_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  chat_id TEXT,
  provider_id TEXT NOT NULL,
  native_ref TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);

CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel')),
  title TEXT NOT NULL DEFAULT '',
  section_id TEXT REFERENCES sections(id),
  task_owner_agent_id TEXT REFERENCES agents(id),
  settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  member_kind TEXT NOT NULL CHECK (member_kind IN ('user','agent')),
  member_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member','observer')),
  PRIMARY KEY (chat_id, member_kind, member_id)
);
CREATE INDEX chat_members_member ON chat_members(member_kind, member_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system','external')),
  author_id TEXT,
  reply_to TEXT,
  body TEXT NOT NULL DEFAULT '',
  blocks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocks)),
  status TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('pending','streaming','final','error')),
  run_id TEXT,
  external_ref TEXT CHECK (external_ref IS NULL OR json_valid(external_ref)),
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX messages_chat ON messages(chat_id, created_at);

CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='', contentless_delete=1);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF body ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, actor_kind, actor_id, emoji)
);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  refcount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
);

CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  chat_id TEXT,
  seq INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  source TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source)),
  idem_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','running','done','failed','cancelled','interrupted','held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  resume_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  UNIQUE (agent_id, seq)
);
CREATE INDEX queue_items_head ON queue_items(agent_id, state, priority, seq);

CREATE TABLE agent_queue_state (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  paused INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  queue_item_id TEXT NOT NULL REFERENCES queue_items(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  provider_session_id TEXT REFERENCES provider_sessions(id),
  provider_id TEXT NOT NULL,
  model TEXT,
  state TEXT NOT NULL,
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  stop_reason TEXT
);
CREATE INDEX runs_item ON runs(queue_item_id);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  n INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  PRIMARY KEY (run_id, n)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  action TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action)),
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','expired')),
  decided_by TEXT,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL
);
CREATE INDEX events_created ON events(created_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  key_version INTEGER NOT NULL DEFAULT 1,
  backend TEXT NOT NULL DEFAULT 'local' CHECK (backend IN ('local','bitwarden','1password')),
  ref TEXT,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  UNIQUE (scope, name)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE TABLE automation_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  trust TEXT NOT NULL DEFAULT 'standard' CHECK (trust IN ('guarded','standard')),
  remote_ok INTEGER NOT NULL DEFAULT 0,
  rate_per_hour INTEGER NOT NULL DEFAULT 30,
  created_by TEXT,
  created_trust TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE run_tokens (
  token_hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE setup_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  endpoint TEXT NOT NULL,
  keys TEXT NOT NULL CHECK (json_valid(keys))
);
