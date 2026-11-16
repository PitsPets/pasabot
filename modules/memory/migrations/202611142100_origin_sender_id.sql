-- Who caused an item to be saved, by person (ARCHITECTURE 7.4 / 8): the turn's sender id next to its kind, so one
-- guest, member or channel stranger never reads back items saved during another person's turns. NULL on items (and
-- queued merges) saved before this migration: their sender is unknown, so only owner turns read them.
ALTER TABLE memory_item ADD COLUMN origin_sender_id TEXT;
ALTER TABLE memory_merge ADD COLUMN origin_sender_id TEXT;
