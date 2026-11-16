-- Provider ops (W3): fallback chains, usage limits, per-agent accounts, compaction state and token usage.
-- Every table carries the `provider_ops_` prefix.

-- per-agent settings; absent row = defaults (no fallback, the CLI's default account, threshold from agents.limits)
CREATE TABLE provider_ops_agent (
  agent_id TEXT PRIMARY KEY,
  -- ordered [{ providerId, model?, accountId? }]
  fallback TEXT NOT NULL DEFAULT '[]',
  -- account for the agent's own (primary) provider
  account_id TEXT,
  -- compact when context use reaches this percent of the window (null = agents.limits, else 80)
  compact_pct INTEGER,
  -- or when it reaches this many tokens (null = off)
  compact_tokens INTEGER,
  -- consecutive compactions that freed < 10 % of the window; 2 stops compaction
  no_gain INTEGER NOT NULL DEFAULT 0,
  -- context used when the last compaction happened, until the next turn measures it (null = nothing pending)
  pending_used INTEGER,
  pending_window INTEGER,
  compaction_stopped_at INTEGER,
  -- provider of the agent's last turn (for the "back on primary" notice)
  last_provider TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- provider accounts: each its own CLI config dir under the module's data dir
CREATE TABLE provider_ops_account (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- a provider (and account; '' = default) that reported a usage limit or auth failure, skipped until `until`
CREATE TABLE provider_ops_limit (
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, account_id)
);

-- token usage per finished run (from `run.finished`)
CREATE TABLE provider_ops_usage (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  chat_id TEXT,
  provider_id TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens INTEGER NOT NULL DEFAULT 0,
  context_used INTEGER,
  context_window INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX provider_ops_usage_agent ON provider_ops_usage (agent_id, at);
CREATE INDEX provider_ops_usage_chat ON provider_ops_usage (chat_id, at);
