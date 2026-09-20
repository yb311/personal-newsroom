import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import type { Watch } from '@pnr/watch';
import { recentCorrections } from '@pnr/watch';
import { log } from '@pnr/core';
import type { Candidate } from './recall.ts';

export interface Judgement { itemId: string; score: number; reason: string }

/** One call per batch. The batch size and the single-call-per-batch rule are
 *  load-bearing for cost: per-item calls would be roughly 20x the price. */
export const BATCH_SIZE = 20;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 10 },
          reason: { type: 'string' }
        },
        required: ['id', 'score', 'reason']
      }
    }
  },
  required: ['results']
} as const;

/**
 * Judges a batch of candidates against the user's own sentence.
 *
 * The prompt carries the intent VERBATIM and the corrections in the user's own
 * words. No rubric is compiled in between, because compression here is exactly
 * what makes tag-based readers feel blunt.
 */
export async function judgeBatch(
  db: Db, provider: Provider, watch: Watch, batch: Candidate[]
): Promise<Judgement[]> {
  if (batch.length === 0) return [];
  const corrections = recentCorrections(db, watch.id, 10);

  const lines = [
    'ROLE',
    '你在帮一个人筛选新闻。判断每条新闻和他想看的内容有多相关，给 0-10 分。',
    '',
    'USER_INTENT（他自己写的原话，逐字理解，不要替他改写或放宽）',
    watch.intent,
    ''
  ];

  if (corrections.length) {
    lines.push('他之前的反馈（原话）');
    for (const c of corrections) {
      const verdict = c.verdict === 'wanted' ? '这条要' : '这条不要';
      const title = (c as unknown as { title?: string }).title ?? '';
      lines.push(`- ${verdict}：「${title.slice(0, 60)}」${c.userNote ? ` —— 他说：${c.userNote}` : ''}`);
    }
    lines.push('');
  }

  lines.push(
    'SCORING',
    '- 9-10：正面、直接地报道了他要的内容，是这件事的新进展',
    '- 6-8：确实相关，他会想看，但不是最核心的那条',
    '- 3-5：沾边，同一领域或提到了相关的人和机构，但不是他要的那件事',
    '- 0-2：不相关。只是顺带提了一句名字、或者只是话题类似，都算不相关',
    '',
    '注意：话题接近不等于相关。他要的是具体的那件事，不是那个领域的所有新闻。',
    'reason 用一句话说明打这个分的理由，用他的输出语言写。',
    '',
    'ITEMS'
  );
  for (const c of batch) {
    const snip = (c.snippet ?? '').replace(/\s+/g, ' ').slice(0, 260);
    lines.push(`${c.itemId} | ${c.sourceName} | ${c.title}${snip ? ` | ${snip}` : ''}`);
  }
  lines.push('', '为上面每一条都输出一个结果，id 必须原样照抄。');

  const t0 = Date.now();
  const res = await provider.generate<{ results: Judgement[] }>(lines.join('\n'), {
    schema: SCHEMA as unknown as Record<string, unknown>,
    model: provider.fastModel,
    temperature: 0
  });

  const valid = new Set(batch.map((c) => c.itemId));
  const out = (res.data.results ?? [])
    .filter((r) => valid.has(r.itemId ?? (r as unknown as { id: string }).id))
    .map((r) => ({
      itemId: r.itemId ?? (r as unknown as { id: string }).id,
      score: Math.max(0, Math.min(10, Number(r.score) || 0)),
      reason: String(r.reason ?? '').slice(0, 300)
    }));

  log({ event: 'judge.batch', entityId: watch.id, elapsedMs: Date.now() - t0, attrs: {
    sent: batch.length, got: out.length, model: res.model,
    tokensIn: res.usage?.input, tokensOut: res.usage?.output
  }});
  return out;
}

/** Judges every candidate in batches and records the verdicts. */
export async function judgeAll(
  db: Db, provider: Provider, watch: Watch, candidates: Candidate[]
): Promise<Map<string, Judgement>> {
  const results = new Map<string, Judgement>();
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    try {
      for (const j of await judgeBatch(db, provider, watch, batch)) results.set(j.itemId, j);
    } catch (e) {
      log({ event: 'judge.batch', phase: 'failed', entityId: watch.id,
            reasonCode: String((e as Error)?.message).slice(0, 60) });
    }
  }
  const ins = db.prepare(
    `INSERT INTO matches (watch_id, item_id, recalled_by, vector_score, intent_score, reason, passed_gate, judged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(watch_id, item_id) DO UPDATE SET
       recalled_by = excluded.recalled_by, vector_score = excluded.vector_score,
       intent_score = excluded.intent_score, reason = excluded.reason, judged_at = excluded.judged_at`
  );
  const now = Date.now();
  db.transaction(() => {
    for (const c of candidates) {
      const j = results.get(c.itemId);
      ins.run(watch.id, c.itemId, [...c.arms].join(','), c.vectorScore ?? null,
              j?.score ?? null, j?.reason ?? null, now, now);
    }
  })();
  return results;
}
