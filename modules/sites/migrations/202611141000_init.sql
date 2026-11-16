-- Static sites (ARCHITECTURE 3.2, W18). One row per published site: the agent that published it, its unguessable
-- slug (the URL path on the sites origin), whether the owner's tunnel address is shown for it, its size and when it
-- expires. File bytes live in the BlobStore (sha256) and are copied onto the sites origin; `sites_file` lists them
-- so a restart puts every live site back with its content type.
CREATE TABLE sites_site (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,
  files INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sites_site_agent ON sites_site (agent_id);
CREATE INDEX sites_site_expires ON sites_site (expires_at);
CREATE TABLE sites_file (
  site_id TEXT NOT NULL REFERENCES sites_site (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (site_id, path)
);
