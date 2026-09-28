import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { log } from '@pnr/core';
import { SCORE_FIELDS } from '@pnr/core/catalog-labels';
import type { Watch } from './watch.ts';

/**
 * Sources a watch brings in when it is created.
 *
 * The model reads the person's sentence as written and the whole built-in
 * catalogue with the hand-written coverage scores
 * (catalogs/data/source-scores.json), and picks the few that will actually
 * report on it. Code keeps it honest: only catalogue ids count, and among the
 * picks the ones scoring higher in the relevant fields come first.
 *
 * This only ever adds sources. It is a recall aid, not a filter: whether an
 * article from them belongs to the watch is still judged against the sentence.
 */

export type Placement = 'front' | 'back';

export interface SourceSuggestion {
  sourceId: string;
  name: string;
  domain: string | null;
  country: string | null;
  category: string | null;
  /** The best score among the fields the model found relevant (0 when unscored). */
  score: number;
  /** Which field that score is for. */
  field: string | null;
  /** One sentence from the model, in the interface language. */
  reason: string;
}

export interface WatchSource {
  sourceId: string; name: string; domain: string | null; country: string | null;
  placement: Placement; enabled: boolean; addedAt: number;
}

const SCHEMA = {
  type: 'object',
  properties: {
    fields: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason']
      }
    }
  },
  required: ['fields', 'sources']
} as const;

interface Candidate {
  id: string; name: string; domain: string | null; country: string | null; lang: string | null;
  category: string | null; scores: Record<string, number>;
}

/** Built-in sources not yet in 阅读 and not yet brought in by this watch. */
function candidates(db: Db, watchId: string): Candidate[] {
  return (db.prepare(
    `SELECT id, name, domain, country, lang, category, scores_json AS scores FROM sources
     WHERE added_by = 'catalog' AND enabled = 0
       AND id NOT IN (SELECT source_id FROM watch_sources WHERE watch_id = ?)
     ORDER BY id`
  ).all(watchId) as any[]).map((r) => ({ ...r, scores: r.scores ? JSON.parse(r.scores) : {} }));
}

const scoreText = (s: Record<string, number>): string =>
  Object.entries(s).map(([k, v]) => `${k}:${v}`).join(' ') || '-';

export async function suggestSources(
  db: Db, provider: Provider, watch: Watch, opts: { lang?: string | undefined; limit?: number } = {}
): Promise<SourceSuggestion[]> {
  const limit = opts.limit ?? 8;
  const pool = candidates(db, watch.id);
  if (!pool.length) return [];
  const byId = new Map(pool.map((c) => [c.id, c]));
  const replyLang = opts.lang?.startsWith('zh') || !opts.lang ? '简体中文' : `the language with code ${opts.lang}`;

  const prompt = [
    'ROLE',
    '你在为一个个人新闻应用挑选信息源。用户刚建了一个「关注」，下面是他自己写的原话。',
    `从目录里选出最多 ${limit} 个会经常报道这件事的源。选中的源会被定期抓取，给这个关注找新闻。`,
    '',
    'USER_INTENT（用户原话，不要改写它）',
    watch.intent,
    '',
    'SCORE_FIELDS（每个源在这些领域的报道质量评分，1–10，人工写的；没写的领域就是不擅长）',
    Object.keys(SCORE_FIELDS).join(', '),
    '',
    'RULES',
    '- 先判断这件事属于哪些领域（fields，只能从 SCORE_FIELDS 里选），再挑源。',
    '- 只选真的会报道这件事的源；宁缺毋滥，一个都不合适就返回空数组。',
    '- 同样相关时，优先选相关领域评分高的源。',
    '- 注意国家和语言：关于某个国家的事，当地主流媒体和擅长该地区的国际媒体都可以选。',
    '- id 必须原样取自下面的目录，不要编造。',
    `- reason 用${replyLang}写一句话，说明这个源为什么适合这个关注，不超过 30 字。`,
    '',
    'CATALOGUE（id | 名称 | 域名 | 国家 | 分类 | 评分）',
    ...pool.map((c) => `${c.id} | ${c.name} | ${c.domain ?? '-'} | ${c.country ?? '-'} | ${c.category ?? '-'} | ${scoreText(c.scores)}`),
    '',
    '用 JSON 输出。'
  ].join('\n');

  const t0 = Date.now();
  const res = await provider.generate<{ fields: string[]; sources: { id: string; reason: string }[] }>(prompt, {
    schema: SCHEMA as unknown as Record<string, unknown>,
    model: provider.fastModel,
    temperature: 0.2
  });
  const fields = (Array.isArray(res.data.fields) ? res.data.fields : []).filter((f) => f in SCORE_FIELDS);
  const seen = new Set<string>();
  const picked: (SourceSuggestion & { order: number })[] = [];
  for (const [order, s] of (Array.isArray(res.data.sources) ? res.data.sources : []).entries()) {
    const c = byId.get(String(s?.id ?? ''));
    if (!c || seen.has(c.id)) continue;   // invented or repeated ids are dropped
    seen.add(c.id);
    const scored = (fields.length ? fields : Object.keys(c.scores))
      .map((f) => [f, c.scores[f] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
    picked.push({
      sourceId: c.id, name: c.name, domain: c.domain, country: c.country, category: c.category,
      score: scored?.[1] ?? 0, field: scored && scored[1] > 0 ? scored[0] : null,
      reason: String(s.reason ?? '').trim().slice(0, 120), order
    });
  }
  const out = picked.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit)
    .map(({ order: _order, ...s }) => s);
  log({ event: 'watch.sources', phase: 'completed', entityId: watch.id, elapsedMs: Date.now() - t0,
        attrs: { candidates: pool.length, returned: res.data.sources?.length ?? 0, kept: out.length, fields: fields.join(','),
                 model: res.model, tokensIn: res.usage?.input, tokensOut: res.usage?.output } });
  return out;
}

/**
 * Records the chosen sources for a watch. 'front' also subscribes them, so
 * they show in 阅读; 'back' only has them fetched for the watches.
 */
export function addWatchSources(db: Db, watchId: string, sourceIds: string[], placement: Placement): void {
  const put = db.prepare(`INSERT INTO watch_sources (watch_id, source_id, placement, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(watch_id, source_id) DO UPDATE SET placement = excluded.placement`);
  const exists = db.prepare('SELECT 1 FROM sources WHERE id = ?');
  const now = Date.now();
  db.transaction(() => {
    for (const id of new Set(sourceIds)) {
      if (!exists.get(id)) continue;
      put.run(watchId, id, placement, now);
      if (placement === 'front') db.prepare('UPDATE sources SET enabled = 1 WHERE id = ?').run(id);
    }
  })();
}

/** Moves one of a watch's sources between 阅读 and background-only. */
export function setWatchSourcePlacement(db: Db, watchId: string, sourceId: string, placement: Placement): void {
  addWatchSources(db, watchId, [sourceId], placement);
  if (placement === 'back') db.prepare('UPDATE sources SET enabled = 0 WHERE id = ?').run(sourceId);
}

export function removeWatchSource(db: Db, watchId: string, sourceId: string): void {
  db.prepare('DELETE FROM watch_sources WHERE watch_id = ? AND source_id = ?').run(watchId, sourceId);
}

/** The sources a watch brought in, subscriptions first. */
export function listWatchSources(db: Db, watchId: string): WatchSource[] {
  return (db.prepare(
    `SELECT s.id AS sourceId, s.name, s.domain, s.country, ws.placement, s.enabled, ws.added_at AS addedAt
     FROM watch_sources ws JOIN sources s ON s.id = ws.source_id
     WHERE ws.watch_id = ? ORDER BY s.enabled DESC, s.name`
  ).all(watchId) as any[]).map((r) => ({ ...r, enabled: Boolean(r.enabled),
    // Unsubscribing in the catalogue turns a 'front' source into a background one in effect.
    placement: r.enabled ? 'front' : 'back' }));
}
