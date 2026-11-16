-- Channel bindings (ARCHITECTURE 3.2, 5.2). Every table carries the `channels_` prefix.
-- The binding runtime (apps/server/src/channels) reads these and writes status; the module's REST writes config.
CREATE TABLE channels_binding (
  id TEXT PRIMARY KEY,
  -- the ChannelAdapter kind: telegram, discord, ...
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  -- non-secret config, plus `allowedSenders` (immutable platform user ids); secrets never land here
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  -- { <field>: { id, scope, name } } vault references for the adapter's secretFields
  secret_refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(secret_refs)),
  -- connected / reconnecting / auth_failed / stopped / error / starting
  status TEXT NOT NULL DEFAULT 'stopped',
  orchestrator_agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  last_event_at INTEGER,
  status_at INTEGER,
  -- inbound messages dropped by the binding rules (strangers), for the settings screen
  dropped INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- one place (DM, group, channel) on the platform = one PasaBot chat
CREATE TABLE channels_place (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES channels_binding (id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm', 'group', 'channel')),
  chat_id TEXT,
  -- immutable platform user ids allowed here besides the owner (added to the binding's list)
  allowed_senders TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_senders)),
  mode TEXT NOT NULL DEFAULT 'mention',
  created_at INTEGER NOT NULL,
  UNIQUE (binding_id, external_id)
);

-- keyed on the platform's immutable user id, never a display name or phone string
CREATE TABLE channels_sender (
  binding_id TEXT NOT NULL REFERENCES channels_binding (id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('owner', 'guarded', 'standard', 'trusted')),
  name TEXT NOT NULL DEFAULT '',
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, external_user_id)
);

-- one-time owner link codes (hash only)
CREATE TABLE channels_link (
  code_hash TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES channels_binding (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  -- 'linked' or 'burned' (posted where others could read it)
  outcome TEXT
);

-- outbound bookkeeping: one row per PasaBot message mirrored to a place, so a restart never sends it twice
CREATE TABLE channels_delivery (
  message_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES channels_binding (id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,
  external_id TEXT,
  -- working = a placeholder is out and gets edited; sending = final text on its way; sent = delivered
  state TEXT NOT NULL CHECK (state IN ('working', 'sending', 'sent', 'failed')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX channels_delivery_state ON channels_delivery (state);
