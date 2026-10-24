import Database from 'better-sqlite3';
import type { Db } from './db.ts';

/**
 * Settings that never leave the machine in a backup: API keys and tokens.
 * Matched by name, so a key added later is left out without anyone
 * remembering to list it here.
 */
const SECRET_SETTINGS = `lower(key) LIKE '%apikey%' OR lower(key) LIKE '%api_key%' OR lower(key) LIKE '%token%'
  OR lower(key) LIKE '%secret%' OR lower(key) LIKE '%password%'`;

/**
 * Copies the database to `file` for 备份全部数据, without its keys.
 *
 * SQLite's online backup gives a consistent copy while the app keeps running
 * (the WAL included). In the copy the keys are deleted with `secure_delete`,
 * which overwrites the freed pages, so they are not left readable in the file
 * either. The copy is left in rollback-journal mode as one self-contained file.
 */
export async function backupDatabase(db: Db, file: string): Promise<void> {
  await db.backup(file);
  const copy = new Database(file);
  try {
    copy.pragma('secure_delete = ON');
    copy.prepare(`DELETE FROM settings WHERE ${SECRET_SETTINGS}`).run();
    copy.prepare('DELETE FROM locks').run();
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
}
