-- A native CLI session is resumed only by a turn of the same scope: tool mode (gateway / none), effective trust
-- and the sender's kind + trust (ARCHITECTURE 5.1, 7.4). Older rows have no scope and are never resumed.
ALTER TABLE provider_sessions ADD COLUMN scope TEXT;
