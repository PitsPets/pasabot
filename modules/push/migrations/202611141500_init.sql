-- W23 web push: one row per browser subscription (the endpoint is a capability URL: never logged or returned to
-- anyone but its owner), and the server's VAPID public key (the private key lives in the vault only).
CREATE TABLE push_sub (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_kind TEXT NOT NULL CHECK (user_kind IN ('owner','member','guest')),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','fil')),
  prefs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(prefs)),
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT
);
CREATE INDEX push_sub_user ON push_sub(user_id);
CREATE TABLE push_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  secret_scope TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
