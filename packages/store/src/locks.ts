import type { Db } from './db.ts';

export const LOCK_TTL_MS = 180_000;
export const HEARTBEAT_MS = 15_000;

/**
 * Acquires a named lock, or returns false if someone else holds a live one.
 * Replaces daily-brief's Redis SET NX EX. An expired lock is stealable, which
 * is why this uses heartbeat expiry rather than a file lock: flock cleanup
 * after `kill -9` is not reliable on macOS.
 */
export function acquireLock(db: Db, name: string, pid = process.pid, ttlMs = LOCK_TTL_MS): boolean {
  const fn = db.transaction(() => {
    const now = Date.now();
    const cur = db.prepare('SELECT holder_pid, expires_at FROM locks WHERE name = ?').get(name) as
      | { holder_pid: number; expires_at: number }
      | undefined;
    if (cur && cur.expires_at > now && cur.holder_pid !== pid) return false;
    db.prepare(
      `INSERT INTO locks (name, holder_pid, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET holder_pid = excluded.holder_pid,
         acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at`
    ).run(name, pid, now, now, now + ttlMs);
    return true;
  });
  return fn.immediate() as boolean;
}

export function renewLock(db: Db, name: string, pid = process.pid, ttlMs = LOCK_TTL_MS): boolean {
  const now = Date.now();
  const r = db.prepare('UPDATE locks SET heartbeat_at = ?, expires_at = ? WHERE name = ? AND holder_pid = ?')
    .run(now, now + ttlMs, name, pid);
  return r.changes > 0;
}

export function releaseLock(db: Db, name: string, pid = process.pid): void {
  db.prepare('DELETE FROM locks WHERE name = ? AND holder_pid = ?').run(name, pid);
}
