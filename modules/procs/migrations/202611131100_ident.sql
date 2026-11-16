-- The process's start time, read when it is recorded; a pid is only ever signalled while it still matches
-- (a reused pid belongs to someone else). NULL = could not be read, so the record is never signalled.
ALTER TABLE procs_proc ADD COLUMN ident TEXT;
