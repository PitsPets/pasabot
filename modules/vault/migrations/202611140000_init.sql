-- Agent key requests (W14, ARCHITECTURE 7.3): an agent asks for a secret by name, the owner fills it in
-- Settings → Vault, and the agent is granted the reference `{{secret:<name>}}` (an entry in scope `agent:<id>`).
-- The value never lives here: only the request, who caused it and how it ended.
CREATE TABLE vault_request (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'filled', 'declined')),
  origin_sender TEXT NOT NULL,
  run_id TEXT,
  chat_id TEXT,
  secret_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX vault_request_state ON vault_request (state, created_at);
CREATE INDEX vault_request_agent ON vault_request (agent_id, name, state);
