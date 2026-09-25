import { createHash } from 'node:crypto';
import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { embedItems } from '@pnr/ai';
import type { Watch } from '@pnr/watch';
import { ensureIntentVector, getWatch } from '@pnr/watch';
import { adapterFor, storeItems } from '@pnr/feed';
import type { SourceRecord } from '@pnr/core';
import { log, flags } from '@pnr/core';

export type RecallArm = 'r1_vector' | 'r1_ai' | 'r2_alias' | 'r3_search';

export interface Candidate {
  itemId: string;
  title: string;
  snippet: string | null;
  sourceName: string;
  publishedAt: number;
  arms: Set<RecallArm>;
  vectorScore?: number;
  degraded?: boolean;
}

export interface RecallOptions {
  windowHours?: number;
  vectorTopN?: number;
  aliasLimit?: number;
  /** R3 costs a network round trip per watch; callers skip it on flash runs. */
  useSearch?: boolean;
  /** Hard cap on what reaches the judge — the single biggest cost lever.
   *  Ranking below is free, judging is not. */
  maxJudged?: number;
  /** Prepared once for all watches when the provider has no usable vectors. */
  aiMatches?: Set<string>;
  aiDegraded?: Set<string>;
}

/**
 * Three recall arms, combined as a UNION.
 *
 * Union, not intersection: each arm covers a different blind spot, and a
 * candidate that any one of them finds deserves a look. Filtering happens once,
 * later, where the model can see the whole item and the user's own words.
 */
export async function recallForWatch(
  db: Db, provider: Provider, watch: Watch, opts: RecallOptions = {}
): Promise<Candidate[]> {
  const windowMs = (opts.windowHours ?? 48) * 3600_000;
  const since = Date.now() - windowMs;
  const found = new Map<string, Candidate>();

  const add = (row: any, arm: RecallArm, vectorScore?: number): void => {
    const cur = found.get(row.id);
    if (cur) {
      cur.arms.add(arm);
      if (vectorScore !== undefined && cur.vectorScore === undefined) cur.vectorScore = vectorScore;
      return;
    }
    found.set(row.id, {
      itemId: row.id, title: row.title, snippet: row.snippet,
      sourceName: row.sourceName ?? row.source_name ?? '', publishedAt: row.published_at ?? row.publishedAt,
      arms: new Set([arm]), ...(vectorScore !== undefined ? { vectorScore } : {})
    });
  };

  // ── R1: the user's sentence, embedded, against every recent item ─────────
  const recent = db.prepare(
    `SELECT i.id, i.title, i.snippet, i.published_at, s.name AS sourceName
     FROM items i JOIN sources s ON s.id = i.source_id
     WHERE i.published_at >= ? ORDER BY i.published_at DESC LIMIT 4000`
  ).all(since) as any[];
  const byId = new Map(recent.map((r) => [r.id, r]));

  if (provider.capabilities.embedding) {
    const intentVec = await ensureIntentVector(db, provider, watch);
    const vectors = await embedItems(db, provider, recent.map((r) => ({
      id: r.id, text: `${r.title}\n${(r.snippet ?? '').slice(0, 500)}`
    })));
    const nearest = [...vectors.entries()]
      .map(([id, v]) => ({ id, distance: 1 - cosine(intentVec, v) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, opts.vectorTopN ?? 80);
    for (const n of nearest) {
      const row = byId.get(n.id); if (row) add(row, 'r1_vector', n.distance);
    }
  } else {
    const matches = opts.aiMatches ?? (await aiPrescreenWatches(db, provider, [watch], opts.windowHours ?? 48)).matches.get(watch.id) ?? new Set();
    for (const id of matches) {
      const row = byId.get(id); if (row) { add(row, 'r1_ai'); const c = found.get(id); if (c && opts.aiDegraded?.has(id)) c.degraded = true; }
    }
  }

  // ── R2: alias hits. Widens only; never removes anything ──────────────────
  // Re-read from the database: recall aids are generated and persisted by
  // prepareWatch, so a caller's in-memory object can be one step behind.
  const aids = watch.recallAids ?? getWatch(db, watch.id)?.recallAids ?? null;
  const terms = [
    ...(watch.keywords ?? []),
    ...(aids?.aliases ?? []),
    ...(aids?.relatedTerms ?? [])
  ].filter((t) => t.length >= 2).slice(0, 40);
  if (terms.length) {
    const clauses = terms.map(() => '(i.title LIKE ? OR i.snippet LIKE ?)').join(' OR ');
    const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    const rows = db.prepare(
      `SELECT i.id, i.title, i.snippet, i.published_at, s.name AS sourceName
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.published_at >= ? AND (${clauses})
       ORDER BY i.published_at DESC LIMIT ?`
    ).all(since, ...params, opts.aliasLimit ?? 120) as any[];
    for (const r of rows) add(r, 'r2_alias');
  }

  // ── R3: query search engines that return real URLs ───────────────────────
  if (opts.useSearch !== false && !flags.disableSearch) {
    // The watch's own query, then the questions the last progress pass left
    // open — the "look for this tomorrow" list.
    const queries = [buildQuery(watch), ...openQuestionTexts(db, watch.id).slice(0, 2)].filter(Boolean);
    const fetched: string[] = [];
    for (const q of queries) fetched.push(...(await searchDiscovery(db, watch, q)));
    for (const id of new Set(fetched)) {
      const row = db.prepare(
        `SELECT i.id, i.title, i.snippet, i.published_at, s.name AS sourceName
         FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?`
      ).get(id) as any;
      if (row) add(row, 'r3_search');
    }
  }

  const all = [...found.values()];
  const out = rankAndCap(all, opts.maxJudged ?? 60);
  log({ event: 'recall.completed', entityId: watch.id, attrs: {
    recalled: all.length, judging: out.length,
    r1: all.filter((c) => c.arms.has('r1_vector')).length,
    r1Ai: all.filter((c) => c.arms.has('r1_ai')).length,
    r2: all.filter((c) => c.arms.has('r2_alias')).length,
    r3: all.filter((c) => c.arms.has('r3_search')).length
  }});
  return out;
}

const PRESCREEN_SCHEMA = {
  type: 'object', properties: { results: { type: 'array', items: {
    type: 'object', properties: { articleId: { type: 'string' }, watchIds: { type: 'array', items: { type: 'string' } } },
    required: ['articleId', 'watchIds'], additionalProperties: false
  } } }, required: ['results'], additionalProperties: false
} as const;

/**
 * One preparation pass for every watch. Failed batches widen, never subtract.
 *
 * Verdicts are remembered per watch and article (`prescreen_results`), keyed by
 * a fingerprint of the watch's own words. A later run sends only the articles
 * some watch has not seen under its current wording — without this every update
 * re-sent the whole three-day window. Corrections still go into every prompt,
 * so they shape what is screened next; they do not void what was screened
 * (this is a loose pre-filter, and the judge sees them again).
 */
export async function aiPrescreenWatches(
  db: Db, provider: Provider, watches: Watch[], windowHours: number
): Promise<{ matches: Map<string, Set<string>>; degraded: Map<string, Set<string>> }> {
  const matches = new Map(watches.map((w) => [w.id, new Set<string>()]));
  const degraded = new Map(watches.map((w) => [w.id, new Set<string>()]));
  if (watches.length === 0) return { matches, degraded };
  const items = db.prepare(`SELECT id,title,snippet,published_at AS publishedAt FROM items
    WHERE published_at>=? ORDER BY published_at DESC`).all(Date.now() - windowHours * 3600_000) as any[];
  const described = watches.map((w) => {
    const corrections = db.prepare(`SELECT verdict,user_note AS note,i.title FROM corrections c
      LEFT JOIN items i ON i.id=c.item_id WHERE watch_id=? ORDER BY c.created_at DESC LIMIT 12`).all(w.id) as any[];
    const text = `${w.id}: ${w.intent}\n纠偏原话: ${corrections.map((c) => `${c.verdict}:${c.title ?? ''}:${c.note ?? ''}`).join(' | ') || '无'}`;
    return { watch: w, text, fingerprint: createHash('sha256').update(w.intent).digest('hex').slice(0, 20) };
  });

  // What is already known: reuse it, and leave only the unseen pairs.
  const known = db.prepare('SELECT item_id AS itemId, relevant FROM prescreen_results WHERE watch_id = ? AND fingerprint = ?');
  const pending = new Map<string, Set<string>>();   // itemId → watches still to ask about
  for (const { watch, fingerprint } of described) {
    const seen = new Map((known.all(watch.id, fingerprint) as { itemId: string; relevant: number }[]).map((r) => [r.itemId, r.relevant]));
    for (const item of items) {
      const verdict = seen.get(item.id);
      if (verdict === undefined) (pending.get(item.id) ?? pending.set(item.id, new Set()).get(item.id)!).add(watch.id);
      else if (verdict) matches.get(watch.id)!.add(item.id);
    }
  }
  const unseen = items.filter((i) => pending.has(i.id));
  if (unseen.length === 0) return { matches, degraded };
  const asking = described.filter((d) => unseen.some((i) => pending.get(i.id)!.has(d.watch.id)));
  const watchText = asking.map((d) => d.text).join('\n');
  const save = db.prepare(`INSERT INTO prescreen_results (watch_id, item_id, fingerprint, relevant) VALUES (?, ?, ?, ?)
    ON CONFLICT(watch_id, item_id) DO UPDATE SET fingerprint = excluded.fingerprint, relevant = excluded.relevant`);

  const budgetChars = Math.max(12_000, provider.limits.fast.maxInputTokens * 2);
  for (let offset = 0; offset < unseen.length;) {
    const batch: any[] = []; let chars = watchText.length + 800;
    while (offset < unseen.length && batch.length < 300) {
      const item = unseen[offset]!; const line = `${item.id}: ${item.title}\n${String(item.snippet ?? '').slice(0, 700)}`;
      if (batch.length && chars + line.length > budgetChars) break;
      batch.push(item); chars += line.length; offset++;
    }
    try {
      const result = await provider.generate<{ results: { articleId: string; watchIds: string[] }[] }>([
        '你只做宽松召回初筛。可能相关就保留；不要因为不确定而排除。',
        '下面是所有关注的用户原话和用户纠偏原话，不得改写成关键词判据。', 'WATCHES', watchText,
        'ARTICLES', ...batch.map((i) => `${i.id}: ${i.title}\n${String(i.snippet ?? '').slice(0, 700)}`),
        '返回每篇可能相关报道及所有可能相关 watchId。完全无关的文章可省略。'
      ].join('\n\n'), { schema: PRESCREEN_SCHEMA as unknown as Record<string, unknown>, model: provider.fastModel,
        temperature: 0, operation: 'recall_prescreen' });
      const validItems = new Set(batch.map((i) => i.id)); const validWatches = new Set(asking.map((d) => d.watch.id));
      const found = new Set<string>();
      for (const row of result.data.results ?? []) if (validItems.has(row.articleId)) {
        for (const watchId of row.watchIds ?? []) if (validWatches.has(watchId)) {
          matches.get(watchId)!.add(row.articleId); found.add(`${watchId}\n${row.articleId}`);
        }
      }
      db.transaction(() => {
        for (const item of batch) for (const d of asking) if (pending.get(item.id)!.has(d.watch.id))
          save.run(d.watch.id, item.id, d.fingerprint, found.has(`${d.watch.id}\n${item.id}`) ? 1 : 0);
      })();
    } catch (error) {
      // Not remembered: a failed batch is asked again next time.
      for (const d of asking) for (const item of batch) if (pending.get(item.id)!.has(d.watch.id)) {
        matches.get(d.watch.id)!.add(item.id); degraded.get(d.watch.id)!.add(item.id);
      }
      log({ event: 'recall.prescreen', phase: 'failed', reasonDetail: String(error).slice(0, 160), attrs: { batch: batch.length } });
    }
  }
  log({ event: 'recall.prescreen', phase: 'completed', attrs: { window: items.length, asked: unseen.length, watches: asking.length } });
  return { matches, degraded };
}

/**
 * R3 uses Google News / Bing News search RSS, which return real article URLs
 * that go through the same fetch-and-verify path as any feed. Deliberately NOT
 * Google Search grounding: that returns the model's retelling, which cannot be
 * cited back to a source.
 */
async function searchDiscovery(db: Db, watch: Watch, query: string): Promise<string[]> {
  const lang = watch.outputLang ?? 'en-US';
  const src: SourceRecord = {
    id: `search:${watch.id}`, kind: 'googlenews', name: '搜索发现', domain: null,
    url: query, category: null, lang, country: lang.split('-')[1] ?? 'US',
    trust: 0.7, enabled: 1, dateHydration: null, configJson: null
  };
  // The synthetic source must exist before items can reference it.
  db.prepare(
    `INSERT INTO sources (id,kind,name,url,category,lang,country,trust,enabled,added_by,created_at)
     VALUES (?,?,?,?,NULL,?,?,?,0,'search',?) ON CONFLICT(id) DO UPDATE SET url = excluded.url`
  ).run(src.id, src.kind, src.name, src.url, src.lang, src.country, src.trust, Date.now());

  const adapter = adapterFor('googlenews');
  if (!adapter) return [];
  try {
    const { items } = await adapter(src, { db });
    storeItems(db, items);
    const keys = items.map((i) => i.url);
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(',');
    return (db.prepare(`SELECT id FROM items WHERE url IN (${placeholders})`).all(...keys) as { id: string }[])
      .map((r) => r.id);
  } catch (e) {
    log({ event: 'recall.search', phase: 'failed', entityId: watch.id, reasonCode: String((e as Error)?.message).slice(0, 40) });
    return [];
  }
}

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Questions a progress pass left unanswered, newest first. */
export function openQuestionTexts(db: Db, watchId: string): string[] {
  return (db.prepare(
    'SELECT question FROM open_questions WHERE watch_id = ? AND resolved_at IS NULL ORDER BY asked_at DESC'
  ).all(watchId) as { question: string }[]).map((r) => r.question);
}

/** A compact query for the search engines. Uses the user's own words plus the
 *  strongest alias, rather than a machine-generated boolean expression. */
function buildQuery(watch: Watch): string {
  const alias = watch.recallAids?.aliases?.[0];
  if (alias) return alias;
  return watch.intent.replace(/^我(想|要)(知道|看|了解|关注)?/, '').slice(0, 80).trim();
}

/**
 * Free pre-ranking before the paid step.
 *
 * Search discovery alone can return a hundred results per watch, and judging
 * all of them is the single largest avoidable cost. Ranking uses only signals
 * already in hand:
 *  - how many arms found it (agreement between independent arms is the
 *    strongest cheap signal we have)
 *  - vector distance, when R1 saw it
 *  - recency
 * Nothing here decides relevance; it only decides what the judge looks at first.
 */
export function rankAndCap(candidates: Candidate[], cap: number): Candidate[] {
  if (candidates.length <= cap) return candidates;
  const now = Date.now();
  const score = (c: Candidate): number => {
    const agreement = (c.arms.size - 1) * 0.35;
    const vector = c.arms.has('r1_ai') ? 0.6 : c.vectorScore !== undefined ? Math.max(0, 1 - c.vectorScore) : 0.35;
    const ageHours = Math.max(0, (now - c.publishedAt) / 3600_000);
    const fresh = Math.max(0, 1 - ageHours / 72) * 0.2;
    return agreement + vector + fresh;
  };
  return candidates
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, cap)
    .map((x) => x.c);
}
