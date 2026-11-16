-- 7.1 "Ask before terminal and raw web commands" (owner decision 2026-11-14): per agent. NULL = the default for the
-- agent's trust level (off at trusted, on at standard and guarded); 1 = always ask before a provider CLI's shell or
-- raw web/HTTP tool; 0 = never for that reason (the normal tier rules still apply).
ALTER TABLE agents ADD COLUMN ask_shell_web INTEGER;
