-- Who started the run that asked: only that person (or an owner) may answer its cards and forms.
ALTER TABLE richchat_prompt ADD COLUMN sender TEXT CHECK (sender IS NULL OR json_valid(sender));
