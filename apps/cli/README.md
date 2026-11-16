# @pasabot/cli

The `pasabot` command. Verbs are discovered by glob from `src/commands/**` (no registry); each file default-exports a `Command`.

W0b verbs: `setup-link` (mints a one-time owner link from `$PASABOT_HOME` on this machine), `login`, `logout`, `status`, `version`, `name`. The CLI session token is kept in `~/.config/pasabot/session.json` (0600). `PASABOT_URL` / `PASABOT_PORT` pick the server.
