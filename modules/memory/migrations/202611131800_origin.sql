-- Who caused an item to be saved (W10 review fix, ARCHITECTURE 7.4 / 8): the turn's sender kind and effective trust.
-- NULL on items saved before this migration: search and the review screen show them as "origin unknown".
ALTER TABLE memory_item ADD COLUMN origin_sender TEXT;
ALTER TABLE memory_item ADD COLUMN origin_trust TEXT;
