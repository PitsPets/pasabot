-- richchat: questions and forms an agent is waiting on, and resumable uploads in progress.
CREATE TABLE richchat_prompt (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'form')),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT NOT NULL,
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'expired', 'cancelled')),
  answer TEXT CHECK (answer IS NULL OR json_valid(answer)),
  answered_by TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX richchat_prompt_chat ON richchat_prompt (chat_id, created_at);

CREATE TABLE richchat_upload (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
