-- W34: a routine marked "run even offline" falls back to the agent's next reachable brain (a local model) when its
-- primary cannot be reached, and its fire says so in `note`.
ALTER TABLE routines_routine ADD COLUMN run_even_offline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines_fire ADD COLUMN note TEXT;
