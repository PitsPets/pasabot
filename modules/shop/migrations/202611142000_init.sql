-- W30 shopping: the owner's country and store toggles, custom stores, captured products and Buy orders.
CREATE TABLE shop_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  country TEXT, -- ISO 3166 alpha-2 the owner picked; NULL = from the locale/region
  disabled TEXT NOT NULL DEFAULT '[]', -- JSON array of pack store keys the owner turned off
  updated_at INTEGER NOT NULL
);

CREATE TABLE shop_custom_store (
  id TEXT PRIMARY KEY, -- the store's own lowercase id
  data TEXT NOT NULL, -- the store entry (pack schema), JSON
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE shop_product (
  id TEXT PRIMARY KEY,
  store_key TEXT NOT NULL, -- `<CC>:<id>`, `custom:<id>` or `web:<host>`
  store_name TEXT NOT NULL,
  hosts TEXT NOT NULL, -- JSON array: the store's allowedHosts when captured
  name TEXT NOT NULL,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  image TEXT,
  url TEXT NOT NULL,
  rating REAL,
  rating_count INTEGER,
  captured_at INTEGER NOT NULL,
  agent_id TEXT,
  run_id TEXT,
  chat_id TEXT
);
CREATE INDEX shop_product_captured ON shop_product (captured_at);

CREATE TABLE shop_order (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  -- pending (asked) | denied | running | handed-over | paused | stopped | failed
  state TEXT NOT NULL,
  message TEXT,
  approval_id TEXT,
  via TEXT NOT NULL, -- 'tool' | 'button'
  run_id TEXT,
  chat_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
