-- W33 fixes. Team scopes now travel to backends as `team-<id>` (plugin backends refuse a colon in a bank name);
-- the comment in 202611141900_pool.sql that says `team:<id>` is historical (the W33 branch never shipped it).
-- The merge queue also holds values that would replace an entry written by the owner, another writer, or at a higher
-- trust (`reason` = 'protected'), so it records the incoming value's own confidence instead of assuming 'high'.
ALTER TABLE memory_merge ADD COLUMN incoming_confidence TEXT CHECK (incoming_confidence IN ('low', 'high'));
ALTER TABLE memory_merge ADD COLUMN reason TEXT NOT NULL DEFAULT 'conflict'
  CHECK (reason IN ('conflict', 'protected'));
UPDATE memory_merge SET incoming_confidence = 'high' WHERE incoming_confidence IS NULL;
UPDATE memory_meta SET scope_key = 'team-' || substr(scope_key, 6) WHERE scope_key LIKE 'team:%';
UPDATE memory_merge SET scope_key = 'team-' || substr(scope_key, 6) WHERE scope_key LIKE 'team:%';
UPDATE memory_item SET agent_id = 'team-' || substr(agent_id, 6) WHERE agent_id LIKE 'team:%';
