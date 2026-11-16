-- A fire's run id is written when its run starts, so events of routine-caused runs are recognised (loop guard).
CREATE INDEX routines_fire_run ON routines_fire (run_id);
