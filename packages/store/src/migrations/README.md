These .sql files are the readable source of the schema. They are **not read at
runtime** — the app bundles its main process, where loose files alongside the
source do not exist. `../migrations.ts` holds the embedded copy that actually
runs. Keep the two in sync when adding a migration, or generate one from the other.

Each migration and its `_migrations` row are committed in one SQLite transaction,
so an interrupted upgrade can safely retry the whole migration.
