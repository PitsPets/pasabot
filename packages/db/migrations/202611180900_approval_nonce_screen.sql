-- Approvals vs screen helpers (security review 2026-11-15, ARCHITECTURE 8 "Screen helpers"):
-- `nonce`: a random value per card, shown only in the rendered card; an approve over REST must carry it, so one
--   card's answer can never approve another card. Existing rows get one too (a pending detached approval stays
--   answerable after the upgrade).
-- `screen`: 1 for an approval of a computer-use action (a tool that sees or drives a screen): it needs a fresh
--   re-auth for that one card, and an agent has at most one of them pending. 0 for every existing row.
ALTER TABLE approvals ADD COLUMN nonce TEXT;
ALTER TABLE approvals ADD COLUMN screen INTEGER NOT NULL DEFAULT 0 CHECK (screen IN (0, 1));
UPDATE approvals SET nonce = lower(hex(randomblob(16))) WHERE nonce IS NULL;
CREATE INDEX approvals_agent_screen ON approvals (agent_id, screen, state);
