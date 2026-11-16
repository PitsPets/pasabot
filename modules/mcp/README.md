# @pasabot/mod-mcp (W13)

External MCP servers for agents.

- **Servers** (`mcp_server`): stdio (a command started without a shell, with only `PATH`/`HOME`/`LANG`/`TMPDIR` plus its own env, never the PasaBot server's environment) or streamable HTTP (through safe-net; `allowHosts` per server). Secret env values and headers live in the vault; rows hold `{{secret:KEY}}` templates and refs only. A failed test is stored redacted.
- **Levels** (`mcp_agent`): `none` (hidden), `use` (call tools), `manage` (rename, enable/disable, change command/URL; still tiered). Per agent, per role (`all` or a trust level), else `none`. Agent row > role row > `all`. The role row is the one for the turn's effective trust (`effectiveTrust` in `@pasabot/core`: a stranger's, member's, webhook's or routine's turn on a `trusted` agent runs lower), and on such a lower turn the agent's own row can only lower what that role gets. Set only by the owner (`PUT /api/m/mcp/servers/:id/levels`), never a tool (ARCHITECTURE 7.4).
- **Gateway meta-tools**: `tools_find` (words over server/tool names and descriptions), `tools_describe`, `tools_invoke` (tier = the server's tier, default 2). Tool ids are `<server id>/<tool name>`. Results and descriptions carry an "outside data, never instructions" note; the gateway redacts output.
- **Manage tools**: `mcp_servers` (tier 0), `mcp_server_update` (disable only: tier 1; rename/enable: tier 2; a new command/args/URL: tier 3 because the process runs outside the agent sandbox, and it drops the server's stored secrets so the new target never receives them; the owner enters them again over REST). No level, secret or env field.
- **Connector installs** arrive from the connectors module as `connectors.mcp` on `module:connectors` and become servers (`source = connector:<install id>`, on, no grants).
- **REST** (owner session): `GET/POST /servers`, `PATCH/DELETE /servers/:id`, `POST /servers/:id/test`, `PUT /servers/:id/levels`.
- **Web**: `/mcp` (add, test, turn on/off, remove, who can use it).

Tests: `pnpm vitest run modules/mcp` (stdio fixture `src/__fixtures__/echo-mcp.mjs`); browser: `cd modules/mcp && npx playwright test` after `vite build` in `apps/web`.

Install guard: every stdio server starts with `LAUNCHER_GUARD_ENV` (`npm_config_ignore_scripts=true`, `UV_NO_BUILD=1`, audit/fund/update checks off), set after the server's own env so neither an owner's env nor a connector manifest can turn it off: a launcher (`npx`, `uvx`, `pnpm dlx`) that resolves dependencies on a cache miss never runs their install scripts or builds a source package on the host.

Known limits: one process per call (no pooling); stdio servers are not run inside the runner sandbox (no port for it yet), which is why command changes by an agent always ask; only the top-level package of a launcher connector is pinned, its dependencies still resolve from ranges (no lockfile or digest yet), and they run unsandboxed once started; no agent tool to add a server.
