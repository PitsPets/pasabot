-- External MCP servers (ARCHITECTURE 3.2). `env` and `headers` are templates that may name `{{secret:KEY}}`;
-- the values live in the vault and only their refs (`env_secret_refs`: KEY -> SecretRef) are stored here.
CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(args)),
  url TEXT,
  env TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(env)),
  env_secret_refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(env_secret_refs)),
  headers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers)),
  allow_hosts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allow_hosts)),
  tier INTEGER NOT NULL DEFAULT 2 CHECK (tier BETWEEN 0 AND 3),
  enabled INTEGER NOT NULL DEFAULT 0,
  last_test TEXT CHECK (last_test IS NULL OR json_valid(last_test)),
  tools_cache TEXT CHECK (tools_cache IS NULL OR json_valid(tools_cache)),
  source TEXT,
  created_by TEXT NOT NULL,
  created_trust TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mcp_server_source ON mcp_server (source) WHERE source IS NOT NULL;

-- Who may see / use / manage a server: one row per agent, or per role (`all` or a trust level) when agent_id is
-- NULL. An agent's own row wins over its role's row, which wins over `all`; no row at all = `none`.
CREATE TABLE mcp_agent (
  server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
  agent_id TEXT,
  role TEXT,
  level TEXT NOT NULL CHECK (level IN ('none', 'use', 'manage')),
  CHECK ((agent_id IS NULL) <> (role IS NULL))
);
CREATE UNIQUE INDEX mcp_agent_key ON mcp_agent (server_id, coalesce(agent_id, ''), coalesce(role, ''));
