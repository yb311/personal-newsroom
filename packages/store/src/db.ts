import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;

/**
 * Opens the local database, loads sqlite-vec and applies pending migrations.
 *
 * sqlite-vec is a *runtime* SQLite extension, not a Node native module, so it
 * needs no electron-rebuild. better-sqlite3 13.x ships Node-API prebuilds and
 * is likewise ABI-stable across Node and Electron (docs/SPIKES.zh-CN.md §1).
 */
export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Electron exposes files inside app.asar through its patched fs APIs, but
  // SQLite's native dlopen cannot read that virtual path. electron-builder
  // places native libraries in the matching app.asar.unpacked directory.
  const vecPath = sqliteVec.getLoadablePath().replace('/app.asar/', '/app.asar.unpacked/');
  db.loadExtension(vecPath);
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name)
  );
  const record = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.name, Date.now());
    })();
  }
}

/** Where the user's data lives. Backup is copying this folder. */
export function defaultDataDir(): string {
  const home = process.env.HOME ?? '.';
  return join(home, 'Library', 'Application Support', 'personal-newsroom');
}
