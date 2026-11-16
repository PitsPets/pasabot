-- Owner-configured local model endpoints (W34, ARCHITECTURE 12). Each row is one runtime provider `local:<id>`.
CREATE TABLE local_endpoint (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- the wire protocol: Ollama's own API, or an OpenAI-compatible server (LM Studio, llama.cpp, vLLM ...)
  api TEXT NOT NULL CHECK (api IN ('ollama', 'openai')),
  -- base URL as the owner typed it (normalised, no trailing slash); its origin is the only one this row may reach
  base_url TEXT NOT NULL,
  origin TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('loopback', 'lan')),
  -- 'auto' = tools where the model supports them; 'off' = chat only for every model of this endpoint
  tools TEXT NOT NULL DEFAULT 'auto' CHECK (tools IN ('auto', 'off')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX local_endpoint_base ON local_endpoint (base_url);
