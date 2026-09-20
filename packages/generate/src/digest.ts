import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import type { RichBlock } from '@pnr/core';
import { log } from '@pnr/core';
import type { Watch } from '@pnr/watch';

export interface Digest {
  id: string;
  editionDate: string;
  lang: string;
  title: string;
  blocks: RichBlock[];
  generatedAt: number;
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          watchId: { type: 'string' },
          heading: { type: 'string' },
          paragraphs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                itemIds: { type: 'array', items: { type: 'string' } }
              },
              required: ['text', 'itemIds']
            }
          }
        },
        required: ['watchId', 'heading', 'paragraphs']
      }
    }
  },
  required: ['title', 'sections']
} as const;

/**
 * The daily brief, written for every watch in ONE call.
 *
 * Merging is not an optimisation to do later: writing is by far the most
 * expensive stage, and one call per watch would multiply the daily cost by the
 * number of watches. The Flash promotional pricing doubles on 2027-01-01, which
 * makes this structural rather than optional.
 */
export async function generateDigest(
  db: Db, provider: Provider, watches: Watch[], lang: string, editionDate?: string
): Promise<Digest | null> {
  const date = editionDate ?? new Date().toISOString().slice(0, 10);

  const perWatch = watches.map((w) => ({
    watch: w,
    items: db.prepare(
      `SELECT i.id, i.title, i.snippet, i.published_at AS publishedAt,
              s.name AS sourceName, m.intent_score AS score, m.reason
       FROM matches m JOIN items i ON i.id = m.item_id
       LEFT JOIN sources s ON s.id = i.source_id
       WHERE m.watch_id = ? AND m.passed_gate = 1
       ORDER BY m.intent_score DESC, i.published_at DESC LIMIT 8`
    ).all(w.id) as any[]
  })).filter((x) => x.items.length > 0);

  if (perWatch.length === 0) return null;

  const lines = [
    'ROLE',
    '你在为一个人写他专属的今日新闻摘要。他不是在读一份给所有人看的报纸，',
    '而是在读一份只关于他在意的那几件事的简报。',
    '',
    `OUTPUT_LANGUAGE: ${lang}`,
    '',
    'RULES',
    '- 从事实出发写。不要只是把标题翻译或改写一遍。',
    '- 每一段都要给出 itemIds，说明这段话依据的是哪几条材料。id 原样照抄。',
    '- 不要编造材料里没有的数字、原因、动机。',
    '- 材料里没确认的事要写明是未确认的。',
    '- 不写社论口吻，不做预测，不用煽情词。',
    '- 每个关注写 1-3 段，每段 2-4 句。没什么可说的就少写，不要凑字数。',
    '- title 是整份摘要的标题，一句话概括今天他最该知道的事。',
    '',
    'WATCHES'
  ];

  for (const { watch, items } of perWatch) {
    lines.push('', `## watchId=${watch.id}  ${watch.label}`);
    lines.push(`他的原话：${watch.intent}`);
    for (const it of items) {
      const d = new Date(it.publishedAt).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`${it.id} | ${d} | ${it.sourceName} | ${it.title}${it.snippet ? ` | ${String(it.snippet).slice(0, 220)}` : ''}`);
    }
  }

  const t0 = Date.now();
  const res = await provider.generate<{ title: string; sections: any[] }>(lines.join('\n'), {
    schema: SCHEMA as unknown as Record<string, unknown>,
    model: provider.writeModel,
    temperature: 0.3
  });

  const validIds = new Set(perWatch.flatMap((x) => x.items.map((i: any) => i.id)));
  const labelOf = new Map(perWatch.map((x) => [x.watch.id, x.watch.label]));
  const blocks: RichBlock[] = [];
  let kept = 0, dropped = 0;

  for (const sec of res.data.sections ?? []) {
    const heading = String(sec.heading ?? labelOf.get(String(sec.watchId)) ?? '').trim();
    const paras = (sec.paragraphs ?? []).filter((p: any) => String(p?.text ?? '').trim());
    if (!heading || paras.length === 0) continue;
    blocks.push({ type: 'heading', level: 2, text: heading });
    for (const p of paras) {
      // Citation binding, ported from daily-brief: the model may only point at
      // ids it was given, never invent a URL of its own.
      const refs = (p.itemIds ?? []).map(String).filter((x: string) => validIds.has(x));
      if (refs.length === 0) { dropped++; continue; }
      blocks.push({ type: 'paragraph', text: String(p.text).trim(), sourceRefIds: refs });
      kept++;
    }
  }
  if (kept === 0) return null;

  const digest: Digest = {
    id: `digest-${date}`, editionDate: date, lang,
    title: String(res.data.title ?? '今日摘要').trim(),
    blocks, generatedAt: Date.now()
  };

  db.prepare(
    `INSERT INTO digests (id, edition_date, lang, title, body_json, generated_at, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(edition_date) DO UPDATE SET lang = excluded.lang, title = excluded.title,
       body_json = excluded.body_json, generated_at = excluded.generated_at, model = excluded.model`
  ).run(digest.id, date, lang, digest.title, JSON.stringify(blocks), digest.generatedAt, res.model);

  // Record what was said, so tomorrow's progress pass knows.
  const insTold = db.prepare(
    'INSERT INTO told_records (watch_id, narrative, surface, surface_id, told_at) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const sec of res.data.sections ?? []) {
      const wid = String(sec.watchId ?? '');
      if (!labelOf.has(wid)) continue;
      const text = (sec.paragraphs ?? []).map((p: any) => String(p?.text ?? '')).join(' ').trim();
      if (text) insTold.run(wid, text, 'digest', digest.id, digest.generatedAt);
    }
  })();

  log({ event: 'digest.generated', elapsedMs: Date.now() - t0, attrs: {
    watches: perWatch.length, paragraphs: kept, droppedUncited: dropped,
    model: res.model, tokensIn: res.usage?.input, tokensOut: res.usage?.output
  }});
  return digest;
}

export function getDigest(db: Db, editionDate: string): Digest | null {
  const r = db.prepare(
    `SELECT id, edition_date AS editionDate, lang, title, body_json AS bodyJson,
            generated_at AS generatedAt FROM digests WHERE edition_date = ?`
  ).get(editionDate) as any;
  if (!r) return null;
  return { ...r, blocks: JSON.parse(r.bodyJson) as RichBlock[] };
}
