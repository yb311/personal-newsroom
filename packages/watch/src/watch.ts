import type { Db } from '@pnr/store';

export type WatchOrigin = 'preset' | 'intent' | 'customized';

/** How strict the intent gate is: 宁可多看 / 平衡 / 宁可少看. */
export type Sensitivity = 'more' | 'balanced' | 'less';

/**
 * Recall aids only ever WIDEN the candidate set.
 *
 * There is deliberately no exclude list: keyword-level exclusion is lossy
 * compression that fails invisibly — excluding "苹果" to filter out fruit also
 * drops news about Apple's agricultural investments. Exclusion happens only in
 * the judging step, where the model sees the whole item and the user's own
 * sentence.
 */
export interface RecallAids {
  aliases: string[];
  relatedTerms: string[];
  sourceHints: string[];
  updatedAt: string;
}

export interface Watch {
  id: string;
  origin: WatchOrigin;
  label: string;
  /** The user's own sentence, verbatim. Goes into judging prompts unchanged. */
  intent: string;
  outputLang: string | null;
  active: boolean;
  sortOrder: number;
  recallAids: RecallAids | null;
  /**
   * Words the user chose. With AI off they are the whole matching rule — an
   * explicit, visible fallback. With AI on they only add recall candidates;
   * relevance is still judged against the sentence.
   */
  keywords: string[];
  sensitivity: Sensitivity;
  createdAt: number;
  lastRunAt: number | null;
}

export interface Correction {
  id: number;
  watchId: string;
  itemId: string;
  verdict: 'wanted' | 'not_wanted';
  /** The user's own words. Fed back to the judge as-is, never normalised. */
  userNote: string | null;
  createdAt: number;
}

const rowToWatch = (r: any): Watch => ({
  id: r.id, origin: r.origin, label: r.label, intent: r.intent,
  outputLang: r.output_lang, active: Boolean(r.active), sortOrder: r.sort_order,
  recallAids: r.recall_aids_json ? JSON.parse(r.recall_aids_json) : null,
  keywords: r.keywords_json ? JSON.parse(r.keywords_json) : [],
  sensitivity: r.sensitivity ?? 'balanced',
  createdAt: r.created_at, lastRunAt: r.last_run_at
});

export function listWatches(db: Db, onlyActive = false): Watch[] {
  return (db.prepare(
    `SELECT * FROM watches ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort_order, created_at`
  ).all() as any[]).map(rowToWatch);
}

export function getWatch(db: Db, id: string): Watch | null {
  const r = db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
  return r ? rowToWatch(r) : null;
}

const cleanKeywords = (xs: string[] | undefined): string[] =>
  [...new Set((xs ?? []).map((k) => k.trim()).filter(Boolean))].slice(0, 30);

export function createWatch(
  db: Db, input: { id?: string; origin: WatchOrigin; label: string; intent: string;
                   outputLang?: string | null; keywords?: string[] }
): Watch {
  const id = input.id ?? `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();
  const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM watches').get() as { m: number }).m;
  db.prepare(
    `INSERT INTO watches (id, origin, label, intent, output_lang, active, sort_order, keywords_json, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(id, input.origin, input.label, input.intent, input.outputLang ?? null, max + 1,
        JSON.stringify(cleanKeywords(input.keywords)), now);
  return getWatch(db, id)!;
}

export function updateWatch(
  db: Db, id: string,
  patch: Partial<Pick<Watch, 'label' | 'intent' | 'outputLang' | 'active' | 'keywords' | 'sensitivity'>>
): Watch | null {
  const cur = getWatch(db, id);
  if (!cur) return null;
  const intentChanged = patch.intent !== undefined && patch.intent.trim() !== cur.intent;
  const keywordsChanged = patch.keywords !== undefined
    && JSON.stringify(cleanKeywords(patch.keywords)) !== JSON.stringify(cur.keywords);
  // Editing a preset makes it the user's own; it keeps working the same way.
  const origin: WatchOrigin =
    cur.origin === 'preset' && (intentChanged || patch.label !== undefined || keywordsChanged)
      ? 'customized' : cur.origin;
  db.transaction(() => {
    db.prepare(
      `UPDATE watches SET label = ?, intent = ?, output_lang = ?, active = ?, origin = ?,
              keywords_json = ?, sensitivity = ? WHERE id = ?`
    ).run(
      patch.label?.trim() || cur.label,
      intentChanged ? patch.intent!.trim() : cur.intent,
      patch.outputLang !== undefined ? patch.outputLang : cur.outputLang,
      (patch.active ?? cur.active) ? 1 : 0,
      origin, JSON.stringify(patch.keywords !== undefined ? cleanKeywords(patch.keywords) : cur.keywords),
      patch.sensitivity ?? cur.sensitivity, id
    );
    if (intentChanged) {
      // Everything derived from the old sentence is stale: the intent vector,
      // the generated recall aids and every verdict judged against it. They
      // are rebuilt on the next run, which re-judges what is still recent.
      db.prepare('DELETE FROM watch_vectors WHERE watch_id = ?').run(id);
      db.prepare('DELETE FROM watch_vector_meta WHERE watch_id = ?').run(id);
      db.prepare('UPDATE watches SET recall_aids_json = NULL WHERE id = ?').run(id);
      db.prepare('UPDATE matches SET judged_at = NULL, passed_gate = 0 WHERE watch_id = ?').run(id);
    }
  })();
  return getWatch(db, id);
}

export function deleteWatch(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    db.prepare('DELETE FROM watch_vectors WHERE watch_id = ?').run(id);
    // Flashes written only for this watch go with it; shared ones stay for the others.
    const rows = db.prepare('SELECT id, watch_ids_json AS w FROM flashes WHERE watch_ids_json LIKE ?')
      .all(`%"${id}"%`) as { id: string; w: string }[];
    for (const r of rows) {
      const rest = (JSON.parse(r.w) as string[]).filter((x) => x !== id);
      if (rest.length) db.prepare('UPDATE flashes SET watch_ids_json = ? WHERE id = ?').run(JSON.stringify(rest), r.id);
      else db.prepare('DELETE FROM flashes WHERE id = ?').run(r.id);
    }
    db.prepare('DELETE FROM flashes WHERE watch_id IS NULL AND watch_ids_json IS NULL').run();
  })();
}

export function saveRecallAids(db: Db, id: string, aids: RecallAids): void {
  db.prepare('UPDATE watches SET recall_aids_json = ? WHERE id = ?').run(JSON.stringify(aids), id);
}

export function addCorrection(
  db: Db, watchId: string, itemId: string, verdict: 'wanted' | 'not_wanted', userNote?: string
): void {
  db.prepare(
    'INSERT INTO corrections (watch_id, item_id, verdict, user_note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(watchId, itemId, verdict, userNote ?? null, Date.now());
}

/** Recent corrections, newest first — fed to the judge in the user's own words. */
export function recentCorrections(db: Db, watchId: string, limit = 12): Correction[] {
  return (db.prepare(
    `SELECT c.*, i.title FROM corrections c
     LEFT JOIN items i ON i.id = c.item_id
     WHERE c.watch_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
  ).all(watchId, limit) as any[]).map((r) => ({
    id: r.id, watchId: r.watch_id, itemId: r.item_id, verdict: r.verdict,
    userNote: r.user_note, createdAt: r.created_at, title: r.title
  })) as Correction[];
}
