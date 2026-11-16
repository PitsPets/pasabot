-- The conversation of each local-model native session (W34 fix): kept across restarts so a resumed session never
-- silently starts from an empty history. One row per native ref; dropped with its endpoint and after 180 idle days.
CREATE TABLE local_session (
  ref TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  -- JSON array of the chat messages after the system prompt (capped by the adapter and the module)
  history TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX local_session_endpoint ON local_session (endpoint_id);
CREATE INDEX local_session_updated ON local_session (updated_at);
