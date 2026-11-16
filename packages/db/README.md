# @pasabot/db

`openDatabase` (WAL, synchronous=NORMAL, FKs), the forward-only migration runner (`runMigrations`: core first, then
modules by id, one transaction per file, sha check refuses boot, `VACUUM INTO backups/pre-<ts>.db` before upgrades,
module objects must carry the `<id>_` prefix), core migrations in `migrations/`, Kysely row types (`CoreDatabase`).
Proof: `pnpm test:migrations`.
