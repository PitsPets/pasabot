-- Threads follow-up (ws/threads review). channel: the chat-app place the asking turn came from (its report turn goes
-- out there too); still_told_at: the one "still working" report a batch gives when no answer is back by the deadline.
ALTER TABLE collab_batch ADD COLUMN channel TEXT;
ALTER TABLE collab_batch ADD COLUMN still_told_at INTEGER;

-- collab_home: the owner-only chat a helper's requests go to when its own chat is shared with people (a member or a
-- guest never reads what one helper asked another for the owner)
CREATE TABLE collab_home (
  agent_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
