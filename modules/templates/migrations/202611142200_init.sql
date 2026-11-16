-- Templates (ARCHITECTURE 3.2) and the free starter (ROADMAP "W22 extension").
-- templates_installed: templates added from a local folder, a static index or an imported file (built-ins are read
-- from catalog/templates and are not stored). source: 'local:<folder>', 'index:<url>', 'import:<file name>'.
CREATE TABLE templates_installed (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL
);

-- Agents made by the free starter, with the free model they run on.
CREATE TABLE templates_starter_agent (
  agent_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Free-starter state: the installed CLI ('cli') and models found broken at run time ('broken:<model>').
CREATE TABLE templates_starter_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
