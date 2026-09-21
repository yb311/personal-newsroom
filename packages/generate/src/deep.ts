import type { Db } from '@pnr/store';
import { readBody } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import type { RichBlock } from '@pnr/core';
import { log } from '@pnr/core';
import { adapterFor, storeItems } from '@pnr/feed';
import { enrichItem } from '@pnr/reader';

export interface DeepSource { refId: string; title: string; url: string; domain: string | null }
export interface DeepSummary {
  id: string; itemId: string; lang: string;
  blocks: RichBlock[]; sources: DeepSource[];
  milestones: { date: string; text: string; refIds: string[] }[];
  generatedAt: number;
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          refIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['text', 'refIds']
      }
    },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          text: { type: 'string' },
          refIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['date', 'text', 'refIds']
      }
    }
  },
  required: ['title', 'paragraphs']
} as const;

const STOP = new Set(['the','a','an','of','in','on','for','and','or','to','with','at','by','from','as','is','are','was','were','after','over','its','his','her','their','new','says','said']);

/** Words distinctive enough to find other coverage of the same story. */
function keyTerms(text: string): string[] {
  const caps = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  return [...new Set([...caps, ...cjk])].filter((w) => !STOP.has(w.toLowerCase())).slice(0, 8);
}

/**
 * The "go deeper" action: a written summary of one story, with a timeline, where
 * every sentence can be traced back to the source paragraph it came from.
 *
 * The citation binding is ported from daily-brief: the model is handed a list of
 * reference ids and may only point at those. It cannot write a URL of its own,
 * so nothing in the output is unattributable.
 */
export async function generateDeepSummary(
  db: Db, provider: Provider, dataDir: string, itemId: string, lang: string
): Promise<DeepSummary | null> {
  const cached = db.prepare(
    `SELECT id, item_id AS itemId, lang, body_json AS bodyJson, sources_json AS sourcesJson,
            generated_at AS generatedAt FROM deep_summaries WHERE item_id = ? AND lang = ?`
  ).get(itemId, lang) as any;
  if (cached) {
    const parsed = JSON.parse(cached.bodyJson);
    return { ...cached, blocks: parsed.blocks, milestones: parsed.milestones ?? [],
             sources: JSON.parse(cached.sourcesJson) };
  }

  const seed = db.prepare(
    `SELECT i.id, i.title, i.url, i.snippet, i.published_at AS publishedAt, s.name AS sourceName, s.domain
     FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?`
  ).get(itemId) as any;
  if (!seed) return null;

  // 1) Other coverage already in the local library.
  const terms = keyTerms(`${seed.title} ${seed.snippet ?? ''}`);
  const related: any[] = [];
  if (terms.length) {
    const where = terms.map(() => '(i.title LIKE ? OR i.snippet LIKE ?)').join(' OR ');
    related.push(...db.prepare(
      `SELECT i.id, i.title, i.url, i.snippet, i.published_at AS publishedAt, s.name AS sourceName, s.domain
       FROM items i LEFT JOIN sources s ON s.id = i.source_id
       WHERE i.id != ? AND i.published_at >= ? AND (${where})
       ORDER BY i.published_at DESC LIMIT 10`
    ).all(itemId, Date.now() - 30 * 864e5, ...terms.flatMap((t) => [`%${t}%`, `%${t}%`])) as any[]);
  }

  // 2) Search for coverage the library does not have. Returns real URLs that go
  //    through the normal fetch path — not a model's retelling.
  try {
    const adapter = adapterFor('googlenews');
    if (adapter && terms.length) {
      const q = terms.slice(0, 4).join(' ');
      db.prepare(
        `INSERT INTO sources (id,kind,name,url,lang,trust,enabled,added_by,created_at)
         VALUES ('search:deep','googlenews','搜索发现',?,?,0.7,0,'search',?)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url`
      ).run(q, lang, Date.now());
      const { items } = await adapter({
        id: 'search:deep', kind: 'googlenews', name: '搜索发现', domain: null, url: q,
        category: null, lang, country: lang.split('-')[1] ?? 'US', trust: 0.7,
        enabled: 0, dateHydration: null, configJson: null
      }, { db });
      storeItems(db, items.slice(0, 8));
      for (const it of items.slice(0, 6)) {
        const row = db.prepare(
          `SELECT i.id, i.title, i.url, i.snippet, i.published_at AS publishedAt, s.name AS sourceName, s.domain
           FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.url = ?`
        ).get(it.url) as any;
        if (row && row.id !== itemId && !related.some((r) => r.id === row.id)) related.push(row);
      }
    }
  } catch { /* search is a bonus, never a dependency */ }

  // 3) Fetch bodies for the strongest few, then read them from disk.
  const pool = [seed, ...related].slice(0, 7);
  await Promise.all(pool.map(async (r) => {
    const st = db.prepare('SELECT body_state AS s FROM items WHERE id = ?').get(r.id) as { s: string };
    if (st?.s === 'pending') await enrichItem(db, dataDir, { id: r.id, url: r.url });
  }));

  const refs: DeepSource[] = [];
  const material: string[] = [];
  pool.forEach((r, idx) => {
    const refId = `s${idx + 1}`;
    refs.push({ refId, title: r.title, url: r.url, domain: r.domain ?? null });
    const row = db.prepare('SELECT body_path AS p FROM items WHERE id = ?').get(r.id) as { p: string | null };
    const text = readBody(row?.p)?.text.replace(/\n/g, ' ').slice(0, 2200) ?? r.snippet ?? '';
    const d = new Date(r.publishedAt).toISOString().slice(0, 10);
    material.push(`[${refId}] ${d} | ${r.sourceName} | ${r.title}\n${text}`);
  });

  const prompt = [
    'ROLE',
    '把这件事讲清楚：发生了什么、怎么走到这一步、现在什么状态。',
    '',
    `OUTPUT_LANGUAGE: ${lang}`,
    '',
    'RULES',
    '- 只用下面材料里的事实。不要补充材料之外的信息。',
    '- 每一段都要给 refIds，说明依据哪几份材料。**只能用 [sN] 这些 id，不许自己写网址。**',
    '- 材料之间有冲突时，用最保守的说法并注明是谁说的。',
    '- 没有确认的事要写明未确认。',
    '- 4-7 段，每段 2-4 句。不写社论口吻，不做预测。',
    '- milestones：这件事的关键节点，3-8 个，按时间排，日期不能晚于引用材料的日期。',
    '',
    'MATERIAL',
    ...material
  ].join('\n');

  const t0 = Date.now();
  const res = await provider.generate<{ title: string; paragraphs: any[]; milestones?: any[] }>(
    prompt, { schema: SCHEMA as unknown as Record<string, unknown>, model: provider.writeModel, temperature: 0.25 }
  );

  const validRefs = new Set(refs.map((r) => r.refId));
  const blocks: RichBlock[] = [];
  let dropped = 0;
  for (const p of res.data.paragraphs ?? []) {
    const text = String(p.text ?? '').trim();
    const ids = (p.refIds ?? []).map(String).filter((x: string) => validRefs.has(x));
    if (!text) continue;
    if (ids.length === 0) { dropped++; continue; }   // unattributable: not shown
    blocks.push({ type: 'paragraph', text, sourceRefIds: ids });
  }
  if (blocks.length === 0) return null;

  const dateOf = new Map(pool.map((r, i) => [`s${i + 1}`, new Date(r.publishedAt).toISOString().slice(0, 10)]));
  const milestones = (res.data.milestones ?? []).flatMap((m: any) => {
    const ids = (m.refIds ?? []).map(String).filter((x: string) => validRefs.has(x));
    const date = String(m.date ?? '').slice(0, 10);
    const text = String(m.text ?? '').trim();
    if (!text || ids.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const latest = ids.map((i: string) => dateOf.get(i) ?? '').sort().pop() ?? '';
    if (latest && date > latest) return [];   // cannot be reported before it happened
    return [{ date, text, refIds: ids }];
  });

  const summary: DeepSummary = {
    id: `deep-${itemId}-${lang}`, itemId, lang,
    blocks: [{ type: 'heading', level: 2, text: String(res.data.title ?? seed.title) }, ...blocks],
    sources: refs, milestones, generatedAt: Date.now()
  };

  db.prepare(
    `INSERT INTO deep_summaries (id, item_id, lang, body_json, sources_json, generated_at, model)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(item_id, lang) DO UPDATE SET
       body_json = excluded.body_json, sources_json = excluded.sources_json,
       generated_at = excluded.generated_at, model = excluded.model`
  ).run(summary.id, itemId, lang, JSON.stringify({ blocks: summary.blocks, milestones }),
        JSON.stringify(refs), summary.generatedAt, res.model);

  log({ event: 'deep.generated', entityId: itemId, elapsedMs: Date.now() - t0, attrs: {
    sources: refs.length, paragraphs: blocks.length, droppedUncited: dropped,
    milestones: milestones.length, tokensIn: res.usage?.input, tokensOut: res.usage?.output
  }});
  return summary;
}
