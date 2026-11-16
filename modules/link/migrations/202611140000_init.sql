-- W28 machine linking (ARCHITECTURE 11.1).
-- link_peer: one row per other PasaBot machine. grant_level = what THAT machine may do on THIS one (grants are per
-- direction). state: requested (it entered our code, our owner has not confirmed), awaiting (our owner confirmed,
-- the other owner has not yet), active, revoked. The transport address is a bearer secret: only its vault ref is here.
CREATE TABLE link_peer (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  grant_level TEXT NOT NULL CHECK (grant_level IN ('view', 'chat', 'manage')),
  state TEXT NOT NULL CHECK (state IN ('requested', 'awaiting', 'active', 'revoked')),
  transport TEXT NOT NULL,
  address_ref TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX link_peer_live_key ON link_peer (public_key) WHERE revoked_at IS NULL;

-- one-time link codes: only the hash of the secret is stored; 10 minutes, single use
CREATE TABLE link_code (
  hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- introductions offered by a linked machine; never applied by themselves
CREATE TABLE link_intro (
  id TEXT PRIMARY KEY,
  via_peer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered' CHECK (state IN ('offered', 'accepted', 'dismissed')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

-- this side of a proxied chat: what our owner sent to a remote agent and what came back
CREATE TABLE link_proxy (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('me', 'agent', 'error')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX link_proxy_conv ON link_proxy (peer_id, agent_id, created_at);

-- the remote side: the module chat a peer's turns run in, per (peer, agent), and the work queued for a peer
CREATE TABLE link_chat (
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  PRIMARY KEY (peer_id, agent_id)
);
CREATE TABLE link_inbound (
  queue_item_id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
