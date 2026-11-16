-- W23 fix: a push subscription belongs to the session that turned it on. When that session ends (logout, device
-- revoke, expiry, the person turned off) the device gets nothing more and the row is dropped at the next send.
-- Rows from before this column (NULL) are treated as signed out: that device turns notifications on again.
ALTER TABLE push_sub ADD COLUMN session_id TEXT;
CREATE INDEX push_sub_session ON push_sub(session_id);
