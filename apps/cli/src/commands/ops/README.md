# Ops verbs (W20)

`start`, `stop`, `restart`, `service`, `update`, `uninstall`, `logs`, `doctor`. Each file default-exports a
`Command` and is found by the CLI loader's glob; helpers (`shared.ts`, `lifecycle.ts`, `units.ts`, `release.ts`)
export no default and are skipped. Unit templates, Docker files and the remote-access guide are in `deploy/`
(see `deploy/README.md`).

Every function takes an `OpsCtx` (env, platform, output), so tests run against temp folders and fake
`launchctl`/`systemctl` binaries on `PATH`; the background-process tests start a tiny fake server and stop it.

Tests: `pnpm vitest run apps/cli/src/commands/ops`.
