-- W32 budgets: the owner's price table, booked usage per run, caps, and the raise/keep cards.
CREATE TABLE budget_price (
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL, -- '' = the provider's default model
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  cached_per_m REAL NOT NULL,
  currency TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model)
);

CREATE TABLE budget_usage (
  run_id TEXT PRIMARY KEY,
  queue_item_id TEXT,
  agent_id TEXT NOT NULL,
  chat_id TEXT,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_tokens INTEGER NOT NULL,
  state TEXT,
  -- 1 = the run never reported usage (cancelled, crashed, failed early): tokens estimated from what it streamed
  estimated INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX budget_usage_at ON budget_usage (at);
CREATE INDEX budget_usage_agent_at ON budget_usage (agent_id, at);

CREATE TABLE budget_cap (
  scope TEXT NOT NULL, -- 'global' or an agent id
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, period)
);

CREATE TABLE budget_alert (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  chat_id TEXT,
  message_id TEXT,
  cap REAL NOT NULL,
  spent REAL NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX budget_alert_open ON budget_alert (scope, period, period_start, agent_id, state);
