import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { embedItems, nearestItems } from '@pnr/ai';
import type { Watch } from '@pnr/watch';
import { ensureIntentVector, getWatch } from '@pnr/watch';
import { adapterFor, storeItems } from '@pnr/feed';
import type { SourceRecord } from '@pnr/core';
import { log } from '@pnr/core';

export type RecallArm = 'r1_vector' | 'r2_alias' | 'r3_search';

export interface Candidate {
  itemId: string;
  title: string;
  snippet: string | null;
  sourceName: string;
  publishedAt: number;
  arms: Set<RecallArm>;
  vectorScore?: number;
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
  const intentVec = await ensureIntentVector(db, provider, watch);
  const recent = db.prepare(
    `SELECT i.id, i.title, i.snippet, i.published_at, s.name AS sourceName
     FROM items i JOIN sources s ON s.id = i.source_id
     WHERE i.published_at >= ? ORDER BY i.published_at DESC LIMIT 4000`
  ).all(since) as any[];
  const byId = new Map(recent.map((r) => [r.id, r]));

  await embedItems(db, provider, recent.map((r) => ({
    id: r.id, text: `${r.title}\n${(r.snippet ?? '').slice(0, 500)}`
  })));

  for (const n of nearestItems(db, intentVec, opts.vectorTopN ?? 80)) {
    const row = byId.get(n.itemId);
    if (row) add(row, 'r1_vector', n.distance);
  }

  // ── R2: alias hits. Widens only; never removes anything ──────────────────
  // Re-read from the database: recall aids are generated and persisted by
  // prepareWatch, so a caller's in-memory object can be one step behind.
  const aids = watch.recallAids ?? getWatch(db, watch.id)?.recallAids ?? null;
  const terms = [
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
  if (opts.useSearch !== false) {
    const fetched = await searchDiscovery(db, watch);
    for (const id of fetched) {
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
    r2: all.filter((c) => c.arms.has('r2_alias')).length,
    r3: all.filter((c) => c.arms.has('r3_search')).length
  }});
  return out;
}

/**
 * R3 uses Google News / Bing News search RSS, which return real article URLs
 * that go through the same fetch-and-verify path as any feed. Deliberately NOT
 * Google Search grounding: that returns the model's retelling, which cannot be
 * cited back to a source.
 */
async function searchDiscovery(db: Db, watch: Watch): Promise<string[]> {
  const query = buildQuery(watch);
  if (!query) return [];
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
    const vector = c.vectorScore !== undefined ? Math.max(0, 1 - c.vectorScore) : 0.35;
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
