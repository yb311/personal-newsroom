import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { log } from '@pnr/core';
import type { Watch } from '@pnr/watch';

export interface Flash {
  id: string;
  watchId: string | null;
  batchId: string;
  publishedAt: number;
  lang: string;
  title: string;
  body: string;
  importance: number;
  importanceReason: string | null;
  category: string | null;
  basis: 'article' | 'search';
  followUpOf: string | null;
}

/** Wider than the display window on purpose: outlets routinely publish their
 *  first report of an event a day or two late, so comparing only against the
 *  last 24 hours would read those as fresh. Ported from daily-brief. */
export const DEDUP_WINDOW_HOURS = 72;
export const MIN_IMPORTANCE = 6;
export const MAX_PER_BATCH = 12;

const SCHEMA = {
  type: 'object',
  properties: {
    flashes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
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

/**
 * Short, fast updates for one watch.
 *
 * Structure ported from daily-brief's flash pipeline — the three-way
 * new / follow_up / already_published split, the 0-10 importance rubric, the
 * 72-hour comparison window, follow-up chaining — but the rubric asks what
 * matters to THIS person rather than what matters to a general audience.
 */
export async function generateFlashes(
  db: Db, provider: Provider, watch: Watch, lang: string
): Promise<Flash[]> {
  const since = Date.now() - 12 * 3600_000;
  const candidates = db.prepare(
    `SELECT i.id, i.title, i.snippet, i.published_at AS publishedAt, s.name AS sourceName,
            i.body_state AS bodyState
     FROM matches m JOIN items i ON i.id = m.item_id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE m.watch_id = ? AND m.passed_gate = 1 AND i.published_at >= ?
       AND NOT EXISTS (SELECT 1 FROM flashes f WHERE f.watch_id = m.watch_id AND f.id LIKE '%' || i.id)
     ORDER BY m.intent_score DESC, i.published_at DESC LIMIT 30`
  ).all(watch.id, since) as any[];
  if (candidates.length === 0) return [];

  const recent = db.prepare(
    `SELECT id, title, body, published_at AS publishedAt FROM flashes
     WHERE watch_id = ? AND published_at >= ? ORDER BY published_at DESC LIMIT 25`
  ).all(watch.id, Date.now() - DEDUP_WINDOW_HOURS * 3600_000) as any[];

  const lines = [
    'ROLE',
    '你在写快讯。快讯不是"短"，而是"快、准、有信息量"：',
    '一句有信息量的标题 + 一段正文，只写这件事最新发生了什么。',
    '不写背景、不写分析、不写预测。',
    '',
    `OUTPUT_LANGUAGE: ${lang}`,
    '',
    'USER_INTENT（他的原话）',
    watch.intent,
    ''
  ];

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
    'IMPORTANCE 0-10（对这个人而言，不是对全世界而言）',
    '- 9-10：他关注的这件事出现了决定性进展',
    '- 6-8：确实是进展，他会想立刻知道',
    '- 3-5：相关但不急',
    '- 0-2：不值得打扰他',
    '衡量量级、影响范围、不可逆性和新意。不要因为用词耸动就给高分，',
    '也不要因为报道的媒体多就给高分。',
    '',
    'WRITE（只给 importance >= 6 的写）',
    '- title：主体 + 发生了什么 + 最新结果，一句话，不用问句不用悬念',
    '- body：2-3 句。第一句直接报最新事实；第二句补关键数字并注明来源；',
    '  第三句交代当前状态，没有新信息就不写。',
    '- 每个名字、数字、时间、地点都必须来自材料。没确认的要写明未确认。',
    '',
    'ITEMS'
  );
  for (const c of candidates) {
    const d = new Date(c.publishedAt).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${c.id} | ${d} | ${c.sourceName} | ${c.title}${c.snippet ? ` | ${String(c.snippet).slice(0, 240)}` : ''}`);
  }

  const t0 = Date.now();
  const res = await provider.generate<{ flashes: any[] }>(lines.join('\n'), {
    schema: SCHEMA as unknown as Record<string, unknown>,
    model: provider.writeModel,
    temperature: 0.2
  });

  const validItems = new Set(candidates.map((c) => c.id));
  const validFlashes = new Set(recent.map((f) => f.id));
  const bodyState = new Map(candidates.map((c) => [c.id, c.bodyState]));
  const batchId = `batch-${Date.now()}`;
  const now = Date.now();
  const out: Flash[] = [];

  for (const f of res.data.flashes ?? []) {
    const itemId = String(f.itemId ?? '');
    if (!validItems.has(itemId)) continue;
    if (f.kind === 'already_published') continue;
    const importance = Math.max(0, Math.min(10, Number(f.importance) || 0));
    if (importance < MIN_IMPORTANCE) continue;
    const title = String(f.title ?? '').trim();
    const body = String(f.body ?? '').trim();
    if (!title || !body) continue;
    // A follow-up must point at a flash that exists; a dangling reference is
    // downgraded to a new item rather than silently kept.
    const related = f.kind === 'follow_up' && validFlashes.has(String(f.relatedFlashId))
      ? String(f.relatedFlashId) : null;
    out.push({
      id: `flash-${watch.id}-${itemId}`, watchId: watch.id, batchId, publishedAt: now, lang,
      title, body, importance,
      importanceReason: String(f.importanceReason ?? '').slice(0, 120) || null,
      category: String(f.category ?? '').slice(0, 30) || null,
      // Records whether this was written from the article or filled in by
      // search because the body could not be fetched.
      basis: bodyState.get(itemId) === 'ok' ? 'article' : 'search',
      followUpOf: related
    });
    if (out.length >= MAX_PER_BATCH) break;
  }

  const ins = db.prepare(
    `INSERT INTO flashes (id, watch_id, batch_id, published_at, lang, title, body,
                          importance, importance_reason, category, basis, follow_up_of, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
  );
  const insTold = db.prepare(
    'INSERT INTO told_records (watch_id, narrative, surface, surface_id, told_at) VALUES (?,?,?,?,?)'
  );
  db.transaction(() => {
    for (const f of out) {
      ins.run(f.id, f.watchId, f.batchId, f.publishedAt, f.lang, f.title, f.body,
              f.importance, f.importanceReason, f.category, f.basis, f.followUpOf, now);
      insTold.run(watch.id, `${f.title}。${f.body}`, 'flash', f.id, now);
    }
  })();

  log({ event: 'flashes.generated', entityId: watch.id, elapsedMs: Date.now() - t0,
        attrs: { candidates: candidates.length, published: out.length,
                 dropped: (res.data.flashes ?? []).length - out.length } });
  return out;
}

/** The rolling window the flashes tab shows. */
export function recentFlashes(db: Db, hours = 24, watchId?: string): Flash[] {
  const since = Date.now() - hours * 3600_000;
  const rows = watchId
    ? db.prepare(`SELECT * FROM flashes WHERE published_at >= ? AND watch_id = ? ORDER BY published_at DESC, importance DESC`).all(since, watchId)
    : db.prepare(`SELECT * FROM flashes WHERE published_at >= ? ORDER BY published_at DESC, importance DESC`).all(since);
  return (rows as any[]).map((r) => ({
    id: r.id, watchId: r.watch_id, batchId: r.batch_id, publishedAt: r.published_at,
    lang: r.lang, title: r.title, body: r.body, importance: r.importance,
    importanceReason: r.importance_reason, category: r.category,
    basis: r.basis, followUpOf: r.follow_up_of
  }));
}
