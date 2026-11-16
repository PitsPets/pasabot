-- Always-ask action classes of outside tools (ARCHITECTURE 7.1). `tool_classes`: the conservative default classifier's
-- result per tool name, computed when the tool list is fetched (install/test) and stored, never re-derived from agent
-- text at call time. `declared_classes`: what a shipped connector's manifest says. `class_overrides`: the owner's
-- corrections (a class, or "none"); they win over both.
ALTER TABLE mcp_server ADD COLUMN tool_classes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tool_classes));
ALTER TABLE mcp_server ADD COLUMN declared_classes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(declared_classes));
ALTER TABLE mcp_server ADD COLUMN class_overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(class_overrides));
