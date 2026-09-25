import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { log } from '@pnr/core';
import type { Watch } from '@pnr/watch';
import { MATERIAL_COLS, materialBlock, type Material } from './material.ts';
import { fillFromSearch, type SearchFillResult } from './search-fill.ts';
import { writingRules } from './style.ts';

export interface Flash {
  id: string;
  /** Every watch this event matters to. One event is one flash, however many
   *  watches it touches. */
  watchIds: string[];
  batchId: string;
  /** When the flash was written. */
  publishedAt: number;
  /** When the news itself was published (the primary item). */
  itemPublishedAt: number | null;
  /** The items it was written from, primary first. */
  itemIds: string[];
  lang: string;
  title: string;
  body: string;
  importance: number;
  importanceReason: string | null;
  category: string | null;
  /** 'article': written from the extracted text. 'snippet': only the feed's
   *  summary was available, and the UI says so. 'search': details filled in by
   *  search grounding (not used yet). */
  basis: 'article' | 'snippet' | 'search';
  followUpOf: string | null;
  searchMaterialId: string | null;
}

export interface SearchFillContext { remaining: number; byEvent: Map<string, SearchFillResult> }

/** Wider than the display window on purpose: outlets routinely publish their
 *  first report of an event a day or two late, so comparing only against the
 *  last 24 hours would read those as fresh. Ported from daily-brief. */
export const DEDUP_WINDOW_HOURS = 72;
export const MIN_IMPORTANCE = 6;
export const MAX_PER_BATCH = 12;
/** Flashes are about what happened since the last check, not the last week. */
export const FLASH_WINDOW_HOURS = 24;

const SCHEMA = {
  type: 'object',
  properties: {
    flashes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          alsoItemIds: { type: 'array', items: { type: 'string' } },
          watchIds: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['new', 'follow_up', 'already_published'] },
          relatedFlashId: { type: 'string' },
          importance: { type: 'integer', minimum: 0, maximum: 10 },
          importanceReason: { type: 'string' },
          category: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['itemId', 'kind', 'importance', 'title', 'body']
      }
    }
  },
  required: ['flashes']
} as const;

type Candidate = Material & { watchIds: string; score: number };

/**
 * Short, fast updates across all of the person's watches, in one call.
 *
 * One call rather than one per watch: writing is the expensive step, and the
 * same event often matters to several watches — written separately it came
 * out three times ("AI 部队" under 特朗普, 科技 and a third). Candidates are
 * deduplicated by item, the "already published" list is shared, and the model
 * is asked to merge items that report the same event.
 *
 * Structure ported from daily-brief's flash pipeline — the three-way
 * new / follow_up / already_published split, the 0-10 importance rubric, the
 * 72-hour comparison window, follow-up chaining — but importance is judged for
 * THIS person's watches rather than for a general audience.
 */
export async function generateFlashes(
  db: Db, provider: Provider, watches: Watch[], lang: string, searchFill?: SearchFillContext,
  fill: typeof fillFromSearch = fillFromSearch, opts: { force?: boolean; onSkip?: () => void } = {}
): Promise<Flash[]> {
  const active = watches.filter((w) => w.active);
  if (active.length === 0) return [];
  const now = Date.now();

  const recent = db.prepare(
    `SELECT id, title, body, item_ids_json AS itemIds FROM flashes
     WHERE published_at >= ? ORDER BY published_at DESC LIMIT 40`
  ).all(now - DEDUP_WINDOW_HOURS * 3600_000) as { id: string; title: string; body: string; itemIds: string | null }[];
  const alreadyFlashed = new Set(recent.flatMap((f) => (f.itemIds ? JSON.parse(f.itemIds) as string[] : [])));

  const marks = active.map(() => '?').join(',');
  const considered = new Set((db.prepare(
    `SELECT watch_id || char(10) || item_id AS k FROM flash_considered WHERE considered_at >= ? AND watch_id IN (${marks})`
  ).all(now - DEDUP_WINDOW_HOURS * 3600_000, ...active.map((w) => w.id)) as { k: string }[]).map((r) => r.k));
  const candidates = (db.prepare(
    `SELECT ${MATERIAL_COLS}, group_concat(m.watch_id) AS watchIds, MAX(m.intent_score) AS score
     FROM matches m JOIN items i ON i.id = m.item_id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE m.passed_gate = 1 AND m.watch_id IN (${marks}) AND i.published_at >= ?
     GROUP BY i.id ORDER BY score DESC, i.published_at DESC LIMIT 200`
  ).all(...active.map((w) => w.id), now - FLASH_WINDOW_HOURS * 3600_000) as Candidate[])
    .filter((c) => !alreadyFlashed.has(c.id))
    // Incremental: what an earlier check already showed the model — and it set
    // aside as minor or already told — is not paid for again. Only a forced
    // rewrite looks at the whole window once more.
    .filter((c) => opts.force || c.watchIds.split(',').some((w) => !considered.has(`${w}\n${c.id}`)))
    .slice(0, 30);
  if (candidates.length === 0) {
    log({ event: 'flashes.skipped', reasonCode: 'nothing_new', attrs: { watches: active.length } });
    opts.onSkip?.();
    return [];
  }

  const lines = [
    'ROLE',
    '你在写快讯。快讯不是"短"，而是"快、准、有信息量"：',
    '一句有信息量的标题 + 一段正文，只写这件事最新发生了什么。',
    '不写背景、不写分析、不写预测。',
    '',
    `OUTPUT_LANGUAGE: ${lang}`,
    '',
    'WATCHES（他关注的几件事，原话）'
  ];
  for (const w of active) lines.push(`${w.id} | ${w.label} | ${w.intent}`);
  lines.push('');

  if (recent.length) {
    lines.push('ALREADY_PUBLISHED（最近 72 小时已经发过的快讯）');
    for (const f of recent) lines.push(`${f.id} | ${f.title} | ${String(f.body).slice(0, 120)}`);
    lines.push('');
  }

  lines.push(
    'CLASSIFY 每一条',
    '- already_published：讲的还是上面发过的事。包括晚到的报道、各方反应、综述、',
    '  只多了点花絮或几乎没动的数字（伤亡从 48 变 49）。措辞不同不算新。',
    '- follow_up：同一件事的实质进展——数字明显变化、有人被捕/被控/被判、',
    '  法案签署、措施正式生效、正式决定、结果反转、官方确认。',
    '  要填 relatedFlashId，指向这条线最近的那条快讯。',
    '- new：新的事件。',
    '  注意：同一个国家、地区、主题、同一场更大的冲突，都不足以构成 follow_up。',
    '',
    'MERGE',
    '- 下面几条材料讲的是同一件事时，只输出一条快讯：itemId 选信息最全的那条，',
    '  其余的放进 alsoItemIds。一件事只写一次，不管它涉及几个关注。',
    '- watchIds：这条快讯和哪些关注有关（从 WATCHES 的 id 里选，材料后面标了候选）。',
    '',
    'IMPORTANCE 0-10（对这个人而言，不是对全世界而言）',
    '- 9-10：他关注的某件事出现了决定性进展',
    '- 6-8：确实是进展，他会想立刻知道',
    '- 3-5：相关但不急',
    '- 0-2：不值得打扰他',
    '衡量量级、影响范围、不可逆性和新意。不要因为用词耸动就给高分，',
    '也不要因为报道的媒体多就给高分。',
    '',
    'WRITE（只给 importance >= 6 的写）',
    '- title：一句话，主体 + 发生了什么 + 最新结果。中文不超过 28 字，其他语言不超过 14 个词；',
    '  转述某一方的说法可以写成「伊朗：……」。不用问句，不留悬念。',
    '- body：2-3 句，中文不超过 110 字。第一句直接报最新事实；第二句补最关键的细节或数字，并说明是谁说的；',
    '  材料里没有的就不写，宁可短，不要用"细节尚未披露"之类的话凑句子。',
    '- follow_up 的正文要让没看过上一条的人也能读懂：用半句话交代前情，再报这次的变化。',
    '- importanceReason：一句话告诉读者这件事为什么值得知道，例如「这是交火以来伊朗首次提出具体的复谈条件」。',
    '  不要写「属于重大进展」「符合他的关注」这类打分用语。',
    '- 每个名字、数字、时间、地点都必须来自材料。没确认的要写明未确认。',
    '',
    ...writingRules(lang),
    '',
    'ITEMS（"正文"是抓到的原文开头，"摘要"表示只有来源提供的摘要）'
  );
  for (const c of candidates) lines.push(`${materialBlock(c, 900)}\n  相关关注：${c.watchIds}`);

  const t0 = Date.now();
  const res = await provider.generate<{ flashes: any[] }>(lines.join('\n'), {
    schema: SCHEMA as unknown as Record<string, unknown>,
    model: provider.writeModel,
    temperature: 0.2
  });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const activeIds = new Set(active.map((w) => w.id));
  const validFlashes = new Set(recent.map((f) => f.id));
  const batchId = `batch-${now}`;
  const out: Flash[] = [];
  const used = new Set<string>();

  for (const f of res.data.flashes ?? []) {
    const primary = byId.get(String(f.itemId ?? ''));
    if (!primary || used.has(primary.id)) continue;
    if (f.kind === 'already_published') continue;
    const importance = Math.max(0, Math.min(10, Number(f.importance) || 0));
    if (importance < MIN_IMPORTANCE) continue;
    const title = String(f.title ?? '').trim();
    const body = String(f.body ?? '').trim();
    if (!title || !body) continue;

    const also = (f.alsoItemIds ?? []).map(String).filter((id: string) => byId.has(id) && id !== primary.id && !used.has(id));
    const itemIds = [primary.id, ...also];
    itemIds.forEach((id) => used.add(id));
    // The model may only name watches the material was actually matched to.
    const matched = new Set(itemIds.flatMap((id) => byId.get(id)!.watchIds.split(',')));
    let watchIds = (f.watchIds ?? []).map(String).filter((id: string) => matched.has(id) && activeIds.has(id));
    if (watchIds.length === 0) watchIds = [...matched].filter((id) => activeIds.has(id));

    // A follow-up must point at a flash that exists; a dangling reference is
    // downgraded to a new item rather than silently kept.
    const related = f.kind === 'follow_up' && validFlashes.has(String(f.relatedFlashId)) ? String(f.relatedFlashId) : null;
    out.push({
      id: `flash-${primary.id}`, watchIds, batchId, publishedAt: now, itemPublishedAt: primary.publishedAt,
      itemIds, lang, title, body, importance,
      importanceReason: String(f.importanceReason ?? '').slice(0, 120) || null,
      category: String(f.category ?? '').slice(0, 30) || null,
      basis: itemIds.some((id) => byId.get(id)?.bodyState === 'ok') ? 'article' : 'snippet',
      followUpOf: related, searchMaterialId: null
    });
    if (out.length >= MAX_PER_BATCH) break;
  }

  // Search fill is limited across every output language in this run. The same
  // event reuses its evidence and never spends the budget twice.
  if (searchFill && provider.capabilities.search) for (const flash of out) {
    if (flash.basis !== 'snippet' || flash.importance < 8) continue;
    const primary = byId.get(flash.itemIds[0]!); if (!primary) continue;
    let filled = searchFill.byEvent.get(primary.id);
    if (!filled && searchFill.remaining > 0) {
      searchFill.remaining--;
      filled = await fill(db, provider, { itemId: primary.id, title: primary.title,
        snippet: primary.snippet, publishedAt: primary.publishedAt, lang });
      searchFill.byEvent.set(primary.id, filled);
    }
    if (!filled?.publishable) continue;
    flash.title = filled.title; flash.body = filled.body; flash.basis = 'search'; flash.searchMaterialId = filled.materialId;
    for (const itemId of filled.sources.map((s) => s.itemId).filter((id): id is string => Boolean(id))) {
      if (!flash.itemIds.includes(itemId)) flash.itemIds.push(itemId);
    }
  }

  const ins = db.prepare(
    `INSERT INTO flashes (id, watch_id, watch_ids_json, item_ids_json, item_published_at, batch_id, published_at,
                          lang, title, body, importance, importance_reason, category, basis, follow_up_of, created_at, search_material_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
  );
  const insTold = db.prepare(
    'INSERT INTO told_records (watch_id, narrative, surface, surface_id, told_at) VALUES (?,?,?,?,?)'
  );
  const consider = db.prepare(
    `INSERT INTO flash_considered (watch_id, item_id, considered_at) VALUES (?, ?, ?)
     ON CONFLICT(watch_id, item_id) DO UPDATE SET considered_at = excluded.considered_at`
  );
  db.transaction(() => {
    for (const c of candidates) for (const w of c.watchIds.split(',')) if (activeIds.has(w)) consider.run(w, c.id, now);
    db.prepare('DELETE FROM flash_considered WHERE considered_at < ?').run(now - 7 * 864e5);
    for (const f of out) {
      ins.run(f.id, f.watchIds[0] ?? null, JSON.stringify(f.watchIds), JSON.stringify(f.itemIds), f.itemPublishedAt,
              f.batchId, f.publishedAt, f.lang, f.title, f.body, f.importance, f.importanceReason,
              f.category, f.basis, f.followUpOf, now, f.searchMaterialId);
      for (const w of f.watchIds) insTold.run(w, `${f.title}。${f.body}`, 'flash', f.id, now);
    }
  })();

  log({ event: 'flashes.generated', elapsedMs: Date.now() - t0,
        attrs: { watches: active.length, candidates: candidates.length, published: out.length,
                 merged: out.reduce((n, f) => n + f.itemIds.length - 1, 0),
                 model: res.model, tokensIn: res.usage?.input, tokensOut: res.usage?.output } });
  return out;
}

/** The rolling window the flashes tab shows. */
export function recentFlashes(db: Db, hours = 24, watchId?: string): Flash[] {
  const since = Date.now() - hours * 3600_000;
  const rows = db.prepare(
    `SELECT * FROM flashes WHERE published_at >= ? ORDER BY published_at DESC, importance DESC`
  ).all(since) as any[];
  return rows.map((r) => {
    // Flashes written before one flash could serve several watches carry a
    // single watch_id and no item list; the item is the tail of their id.
    const watchIds: string[] = r.watch_ids_json ? JSON.parse(r.watch_ids_json) : r.watch_id ? [r.watch_id] : [];
    const itemIds: string[] = r.item_ids_json ? JSON.parse(r.item_ids_json)
      : [String(r.id).replace(/^flash-.*-(?=[0-9a-f]{24}$)/, '')];
    return {
      id: r.id, watchIds, batchId: r.batch_id, publishedAt: r.published_at,
      itemPublishedAt: r.item_published_at ?? null, itemIds,
      lang: r.lang, title: r.title, body: r.body, importance: r.importance,
      importanceReason: r.importance_reason, category: r.category,
      basis: r.basis, followUpOf: r.follow_up_of, searchMaterialId: r.search_material_id ?? null
    } satisfies Flash;
  }).filter((f) => f.watchIds.length > 0 && (!watchId || f.watchIds.includes(watchId)));
}
