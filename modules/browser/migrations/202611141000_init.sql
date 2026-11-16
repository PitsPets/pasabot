-- Managed browser profiles (ARCHITECTURE 3.2 `browser_profile`). Every table carries the `browser_` prefix.
CREATE TABLE browser_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- `#rrggbb`, shown as the profile's frame colour in the live view
  color TEXT NOT NULL,
  -- JSON `{ server, bypass?, username?, passwordRef? }` or NULL; a password lives in the vault only
  proxy TEXT,
  -- absolute Chromium user-data dir under $PASABOT_HOME/browser-profiles
  data_dir TEXT NOT NULL,
  -- 1 = the profile holds the owner's sign-ins: every agent use asks at tier 3 (ARCHITECTURE 7.1)
  logged_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX browser_profile_name ON browser_profile (name COLLATE NOCASE);
