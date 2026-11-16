-- W31 fix: an agent may only narrow an approved manifest (7.4: only the owner widens). Anything else an agent writes
-- is kept as a proposal the owner approves or rejects; the run-time guard enforces only approved manifests.
ALTER TABLE safety_skill_manifests ADD COLUMN approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1));
ALTER TABLE safety_skill_manifests ADD COLUMN proposal TEXT CHECK (proposal IS NULL OR json_valid(proposal));
ALTER TABLE safety_skill_manifests ADD COLUMN proposal_by TEXT;
ALTER TABLE safety_skill_manifests ADD COLUMN proposal_trust TEXT CHECK (proposal_trust IS NULL OR proposal_trust IN ('guarded','standard','trusted'));
ALTER TABLE safety_skill_manifests ADD COLUMN proposal_findings TEXT CHECK (proposal_findings IS NULL OR json_valid(proposal_findings));
ALTER TABLE safety_skill_manifests ADD COLUMN proposal_at INTEGER;
-- owner-written rows were the owner's own decision; agent-written ones (possibly widening) must be approved again
UPDATE safety_skill_manifests SET approved = 1 WHERE created_by_kind = 'owner';
