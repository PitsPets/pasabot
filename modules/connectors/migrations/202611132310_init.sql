-- Installed connectors (ARCHITECTURE 3.2). `config` = the owner's plain field values (+ OAuth client id);
-- `secret_refs` = field key -> vault SecretRef; secret values never live here.
CREATE TABLE connectors_install (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  version TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  secret_refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(secret_refs)),
  status TEXT NOT NULL CHECK (status IN ('ready', 'needs_auth', 'error')),
  created_at INTEGER NOT NULL
);

-- OAuth2 tokens of an install: refs into the vault only.
CREATE TABLE connectors_oauth (
  install_id TEXT PRIMARY KEY REFERENCES connectors_install (id) ON DELETE CASCADE,
  token_secret_id TEXT NOT NULL,
  refresh_secret_id TEXT,
  expires_at INTEGER,
  connected_at INTEGER NOT NULL
);
