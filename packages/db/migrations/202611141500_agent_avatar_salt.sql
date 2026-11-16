-- Agent avatars (W29): the generated avatar's seed is the agent id plus this salt; the owner's "Shuffle" changes
-- it. Empty = the original look, so every existing agent keeps the avatar its id gives it.
ALTER TABLE agents ADD COLUMN avatar_salt TEXT NOT NULL DEFAULT '';
