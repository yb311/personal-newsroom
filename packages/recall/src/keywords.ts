import type { Db } from '@pnr/store';
import type { Watch } from '@pnr/watch';
import { log } from '@pnr/core';
import { applyLatestCorrections } from './corrections.ts';

/**
 * Keyword matching: how a watch works when no AI is connected.
 *
 * This is deliberately the lossy compression the rest of the project avoids
 * (AGENTS.md, 第一原则) — a word list instead of the person's sentence — so it
 * is used only when there is nothing better, and everything it finds is
 * labelled "关键词匹配 · 未经 AI 判断". With AI connected the same keywords only
 * widen recall (R2); relevance is judged against the sentence.
 *
 * Latin-script keywords match whole words, case-insensitively ("AI" must not
 * match "said"); CJK keywords match as substrings, since Chinese has no spaces.
 */
export function keywordMatcher(keywords: string[]): (text: string) => boolean {
  const res = keywords.map((k) => k.trim()).filter(Boolean).map((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[\p{Script=Latin}\d\s'.-]+$/u.test(k)
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
      : new RegExp(escaped, 'iu');
  });
  return (text) => res.some((re) => re.test(text));
}

/** Records keyword hits for one watch over the recent window. Returns the number of hits. */
export function matchKeywords(db: Db, watch: Watch, windowHours = 72): number {
  if (watch.keywords.length === 0) return 0;
  const hit = keywordMatcher(watch.keywords);
  const rows = db.prepare(
    'SELECT id, title, snippet FROM items WHERE published_at >= ? ORDER BY published_at DESC LIMIT 4000'
  ).all(Date.now() - windowHours * 3600_000) as { id: string; title: string; snippet: string | null }[];
  const ins = db.prepare(
    `INSERT INTO matches (watch_id, item_id, recalled_by, passed_gate, created_at)
     VALUES (?, ?, 'keyword', 1, ?)
     ON CONFLICT(watch_id, item_id) DO UPDATE SET passed_gate = CASE
       WHEN matches.judged_at IS NULL THEN 1 ELSE matches.passed_gate END`
  );
  let n = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const r of rows) {
      if (!hit(`${r.title}\n${r.snippet ?? ''}`)) continue;
      ins.run(watch.id, r.id, now);
      n++;
    }
    applyLatestCorrections(db, watch.id);
  })();
  log({ event: 'watch.keywords', entityId: watch.id, attrs: { scanned: rows.length, hits: n } });
  return n;
}
