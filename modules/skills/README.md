# @pasabot/mod-skills (W12)

The skills library. A skill is a folder with a `SKILL.md` (front matter `name` + `description`, then markdown)
and optional extra text files.

- **Library**: `skills_skill` / `skills_revision` / `skills_agent`; the files of each revision live under
  `$PASABOT_HOME/modules/skills/library/<id>/<rev>/`. Edit = a new revision; rollback = a new revision holding an
  older revision's files, so history only grows.
- **Install** (owner, `POST /api/m/skills/skills`): `create` (the skill-creator form), `folder` (absolute path on
  the server), `git` (https, or `file://` for the owner; shallow clone of one branch, pinned to the commit, no
  hooks/submodules/credential helpers/redirects, host vetted by safe-net and pinned with `http.curloptResolve`;
  optional `commit`: the clone must be exactly that commit; one clone at a time, git killed once the clone folder
  passes 20 MB), `zip` (bundle, base64; sizes enforced while unpacking), `builtin`. Nothing in a skill is ever run.
  Limits: 100 files, 1 MB per file, 2 MB per skill, no symlinks, no hidden or `..` paths.
- **Per agent**: a skill starts off for every agent (an agent-made one: on for its maker only). The owner switches
  it on per agent from the Skills page (`#/skills`).
- **Sync**: each agent's enabled skills are copied (read-only files) into every registered CLI's `skillsDir`
  inside the agent's workspace (Claude: `.claude/skills/<name>/`). Copies carry `.pasabot-skill.json`; the sync
  only replaces or removes folders with that marker, never a hand-made skill. The skills dirs are agent-writable
  and the server is not sandboxed, so the sync runs in a short-lived helper (`src/sync-helper.ts`) that walks in
  with `chdir` + a dev/inode check per folder and then uses single-name relative paths only (openat-style): a
  folder swapped for a symlink mid-sync aborts that dir and can never redirect a write, delete or chmod. It runs
  after every change, at boot, on `agent.updated` and on `run.started`. An agent-made skill, or one written at a
  lower trust than the agent it is synced to, gets the untrusted note at the top of its synced `SKILL.md` (7.4);
  `PUT /skills/:id/agents/:agentId` answers `lowerTrust: true` for those.
- **Agent tools**: `skills_list`, `skills_read` (skills on for it or made by it), `skills_create`,
  `skills_install` (https git at a required 40-hex `commit`, so the approval card shows exactly what gets installed;
  5 per agent per hour), `skills_revise` (own skills only), all tier 2; `skills_uninstall` (own only, tier 3).
  Every revision records who wrote it and `created_trust` (7.4); a skill's trust is the lowest of its writers, and
  agent-made skills read back with an untrusted note.
- **Built-in skills**: `catalog/skills/*` (written for PasaBot), installed at boot and updated while nobody else has
  edited them. One the owner removes is recorded in `skills_builtin_removed` and stays removed across restarts
  until the owner installs it again (it then shows under the available built-ins).

Tests: `pnpm vitest run modules/skills`. Playwright (needs `apps/web` built): `cd modules/skills && npx playwright
test` (desktop 1440 + phone 390, on the shared `apps/web/e2e/server.ts`).
