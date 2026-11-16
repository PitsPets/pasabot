-- Approval steps are core approvals (W9): a waiting approval step names the core approval it waits on.
-- Steps that were already waiting under the earlier module-only approvals have none; the engine files one for
-- them when the server starts (see `resume`), so nothing waiting is lost.
ALTER TABLE workflows_step ADD COLUMN approval_id TEXT;
CREATE INDEX workflows_step_approval ON workflows_step (approval_id);
