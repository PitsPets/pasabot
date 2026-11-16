-- W35 bot inbox. Mailbox settings and the app password live in the vault only, never here.
CREATE TABLE inbox_messages (
  id TEXT PRIMARY KEY,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  from_addr TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  to_addrs TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  was_html INTEGER NOT NULL DEFAULT 0,
  -- email bridge: null = ordinary mail; 'verified' or 'refused:<reason>'
  bridge TEXT,
  bridge_peer TEXT,
  bridge_thread TEXT,
  UNIQUE (uid_validity, uid)
);
CREATE INDEX inbox_messages_received ON inbox_messages (received_at DESC);

-- the other PasaBot bots this owner paired with (address + Ed25519 public key, exchanged in the app)
CREATE TABLE inbox_peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- replay protection: nonces seen per peer inside the accept window
CREATE TABLE inbox_nonces (
  peer_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (peer_id, nonce)
);
