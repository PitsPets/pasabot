-- collab_pair: the module chat that work from one agent to another runs in (one per from/to pair), so delegated
-- work never lands in the owner's own direct chat with the receiver (ARCHITECTURE 7.1, 8 "Cross-agent abuse").
CREATE TABLE collab_pair (
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_agent_id, to_agent_id)
);
