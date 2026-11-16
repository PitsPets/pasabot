-- Always-ask approvals (7.1): the card of a money / outbound-message / owner-added class approval, captured by the
-- server from the tool call ({ class, fields, undeclared? }). NULL for every other approval and every existing row.
ALTER TABLE approvals ADD COLUMN ask TEXT CHECK (ask IS NULL OR json_valid(ask));
CREATE INDEX approvals_run_state ON approvals (run_id, state);
