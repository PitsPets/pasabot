-- Where the owner linked (W9 output to a channel): the place (their DM) a notification for the owner goes to.
-- Owners linked before this have none and are asked to link again before a workflow can post to them.
ALTER TABLE channels_sender ADD COLUMN place_external_id TEXT;
