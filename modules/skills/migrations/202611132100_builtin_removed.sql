-- Built-in skills the owner removed: seeding at boot skips these names, so an uninstall sticks across restarts.
-- Installing the built-in again from the Skills page clears the row.
CREATE TABLE skills_builtin_removed (
  name TEXT PRIMARY KEY,
  removed_at INTEGER NOT NULL
);
