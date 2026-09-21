import type { Db } from '@pnr/store';
import type { Watch, Sensitivity } from '@pnr/watch';

export type { Sensitivity };

/**
 * The intent gate, replacing daily-brief's two-independent-sources rule.
 *
 * That rule was a single predicate in evidence-cluster.ts and it guaranteed
 * newsworthiness for a general audience. A personal newsroom that also reads
 * Telegram and niche blogs has no corroboration by construction, so the question
 * changes from "is this newsworthy" to "is this worth showing THIS person".
 */
interface Thresholds { intent: number; quality: number }

/** Exposed to the user as one slider — "宁可多看 ↔ 宁可少看" — not three numbers. */
export const THRESHOLDS: Record<Sensitivity, Thresholds> = {
  more:     { intent: 0.45, quality: 0.25 },
  balanced: { intent: 0.60, quality: 0.35 },
  less:     { intent: 0.75, quality: 0.50 }
};

export interface GateInput {
  intentScore: number | null;   // 0-10 from the judge
  vectorScore?: number | undefined;  // cosine distance, fallback when judging failed
  sourceTrust: number;          // per-user, per-source
}

export interface GateResult { pass: boolean; intentMatch: number; quality: number; why: string }

export function applyGate(input: GateInput, sensitivity: Sensitivity = 'balanced'): GateResult {
  const t = THRESHOLDS[sensitivity];
  // Judge score when available; otherwise fall back to vector distance so a
  // failed AI call degrades instead of dropping everything.
  const intentMatch = input.intentScore !== null && input.intentScore !== undefined
    ? input.intentScore / 10
    : input.vectorScore !== undefined
      ? Math.max(0, 1 - input.vectorScore)
      : 0;
  // Whether an item is new to the person is decided later, by the progress and
  // flash passes that can read what was already told — not by a score here.
  const quality = input.sourceTrust;

  if (intentMatch < t.intent) return { pass: false, intentMatch, quality, why: 'intent_low' };
  if (quality < t.quality) return { pass: false, intentMatch, quality, why: 'source_weak' };
  return { pass: true, intentMatch, quality, why: 'ok' };
}

/** Applies the gate to everything judged for a watch and records the outcome. */
export function gateWatch(db: Db, watch: Watch, sensitivity: Sensitivity = watch.sensitivity ?? 'balanced'): number {
  const rows = db.prepare(
    `SELECT m.item_id AS itemId, m.intent_score AS intentScore, m.vector_score AS vectorScore,
            s.trust AS sourceTrust
     FROM matches m JOIN items i ON i.id = m.item_id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE m.watch_id = ? AND m.judged_at IS NOT NULL`
  ).all(watch.id) as any[];

  const upd = db.prepare('UPDATE matches SET passed_gate = ? WHERE watch_id = ? AND item_id = ?');
  let passed = 0;
  db.transaction(() => {
    // With AI connected only verdicts count: anything that passed on keywords
    // alone while AI was off is withdrawn until the judge has seen it.
    db.prepare('UPDATE matches SET passed_gate = 0 WHERE watch_id = ? AND judged_at IS NULL').run(watch.id);
    for (const r of rows) {
      const g = applyGate({
        intentScore: r.intentScore, vectorScore: r.vectorScore ?? undefined,
        sourceTrust: r.sourceTrust ?? 0.5
      }, sensitivity);
      if (g.pass) passed++;
      upd.run(g.pass ? 1 : 0, watch.id, r.itemId);
    }
  })();
  return passed;
}
