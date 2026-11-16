-- Always-ask classes for servers installed before 202611141600 (ARCHITECTURE 7.1): their tool lists were cached
-- before any classification existed, so `tool_classes` is still '{}'. Dropping the cache makes the next call list
-- (and classify) the tools before it is checked; `tools_invoke` refuses a call it cannot classify. Connector servers
-- get their manifest's `declared_classes` again when the connectors module re-announces its installs at boot.
UPDATE mcp_server SET tools_cache = NULL WHERE tool_classes = '{}';
