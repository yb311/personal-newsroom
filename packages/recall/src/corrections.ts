import type { Db } from '@pnr/store';

/** Explicit feedback wins over both cached AI scores and keyword matches. */
export function applyLatestCorrections(db: Db, watchId: string): void {
  db.prepare(`UPDATE matches SET passed_gate = (
    SELECT CASE c.verdict WHEN 'wanted' THEN 1 ELSE 0 END
    FROM corrections c WHERE c.watch_id = matches.watch_id AND c.item_id = matches.item_id
    ORDER BY c.id DESC LIMIT 1
  ) WHERE watch_id = ? AND EXISTS (
    SELECT 1 FROM corrections c WHERE c.watch_id = matches.watch_id AND c.item_id = matches.item_id
  )`).run(watchId);
}
