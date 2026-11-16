-- W40 cards: an index of the `core.card` blocks (the card's data and state live in its message's block), so the
-- pinned decision bar can list the open cards that need an answer across every chat.
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  needs_answer INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX cards_open ON cards (state, needs_answer);
CREATE INDEX cards_ref ON cards (ref, state);
