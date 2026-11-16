# @pasabot/mod-acp-registry

ACP agent registry (W2): search a configurable registry index, install and remove Agent Client Protocol agents, and show their status. Each installed agent becomes a provider `acp:<id>` (driven by `@pasabot/provider-acp`) that appears in the agent form's brain list. **Owner only**: installing puts a program on this machine that agents will run.

- **Web**: Settings → "ACP agents" (`settingsSections`): registry index field, installed list (status, version, brain id, command, Remove), searchable index list (Install / Update). Strings in `locales/{en,fil}.json`.
- **REST** (`/api/m/acp-registry`, owner session): `GET/PUT /settings` (`indexSource`), `GET /index?q=`, `GET /installed` (with status: an existence check of the program plus the recorded version; the program itself is never run on the host), `POST /installed {id}`, `DELETE /installed/:id` (409 `in_use` while an active agent uses it as its brain or fallback).
- **Index source**: an absolute path to a local JSON file or an `https://` URL (fetched through the host's SSRF-guarded `net.fetch`). Default: the `PASABOT_ACP_INDEX` env var.
- **Index format** (PasaBot's own, v1):

  ```json
  { "version": 1, "agents": [
    { "id": "echo", "name": "…", "description": "…", "version": "1.2.3", "homepage": "https://…", "license": "…",
      "versionArgs": ["--version"],
      "distribution": { "type": "command", "command": ["node", "./agent.mjs"] } },
    { "id": "x", "name": "…",
      "distribution": { "type": "npm", "package": "@scope/pkg", "version": "1.0.0", "bin": "pkg-acp", "args": ["--acp"] } }
  ] }
  ```

  `id` is `[a-z0-9][a-z0-9-]{0,39}`. `command` entries are only accepted from a **local** index (a remote index may not point at programs already on this machine); a bare program name is resolved on `PATH` at install time, `./`/`../` paths against the index file. `npm` entries install into `$PASABOT_HOME/modules/acp-registry/agents/<id>` with `npm install --prefix … --ignore-scripts`: npm works in `agents/<id>.new`, which replaces the live folder only on success, so a failed install or update leaves the working version (or nothing) in place; Remove deletes the folder.
- **Sandbox**: a registry agent only ever runs inside the runner sandbox. `versionArgs` in an index is accepted but ignored (status is an existence check; the version shown is the index's). An npm agent's install folder sits in the denied `$PASABOT_HOME`, so each turn passes it as CommandWrapper `readable` (read + run, never write; an `iface:` change in W2). Registry agents get no extra writable state paths: under bubblewrap they can write only their workspace (and `/tmp`); an agent that needs its own login folder outside the workspace does not keep it between turns there.
- Installed agents live in `$PASABOT_HOME/modules/acp-registry/installed.json` (written atomically) and are registered again at boot. Removal uses `ProviderRegistry.unregister` (an `iface:` change in W2).

Tests: `pnpm vitest run modules/acp-registry` — the API flow (install the echo agent from `fixtures/local-index.json`, chat through it, remove), restart persistence, the npm path with a stand-in npm, owner-only and refusal cases, and the Settings section driving a real server (`src/ui.test.tsx`).

Known gap: the web app loads the provider list once per page load, so a newly installed agent shows up in the agent form after a reload.
