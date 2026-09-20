import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { upsertWatchVector, getWatchVector } from '@pnr/ai';
import { log } from '@pnr/core';
import type { RecallAids, Watch } from './watch.ts';
import { saveRecallAids, getWatch } from './watch.ts';

/**
 * The intent vector is the user's sentence, embedded as written.
 *
 * There is no compilation step between the user and retrieval. A compiled
 * keyword list is a lossy intermediate whose mistakes are invisible and
 * unrecoverable: miss one alias and the relevant story never appears, and the
 * user never learns they missed it.
 */
export async function refreshIntentVector(db: Db, provider: Provider, watch: Watch): Promise<Float32Array> {
  const [v] = await provider.embed([watch.intent], 'query');
  if (!v) throw new Error('embed_failed');
  upsertWatchVector(db, watch.id, v);
  return v;
}

export async function ensureIntentVector(db: Db, provider: Provider, watch: Watch): Promise<Float32Array> {
  return getWatchVector(db, watch.id) ?? (await refreshIntentVector(db, provider, watch));
}

const AIDS_SCHEMA = {
  type: 'object',
  properties: {
    aliases: { type: 'array', items: { type: 'string' } },
    relatedTerms: { type: 'array', items: { type: 'string' } },
    sourceHints: { type: 'array', items: { type: 'string' } }
  },
  required: ['aliases', 'relatedTerms', 'sourceHints']
} as const;

/**
 * Generates terms that WIDEN recall. Not a filter, and not authoritative:
 * a wrong entry costs a little noise that the judging step absorbs, whereas a
 * missing entry would cost a story. So the prompt asks for breadth.
 */
export async function generateRecallAids(db: Db, provider: Provider, watch: Watch): Promise<RecallAids> {
  const prompt = [
    'ROLE',
    '你在为一个新闻检索系统准备「召回辅助词」。这些词只用来把更多候选新闻捞进来，',
    '不用来排除任何东西。多召回一些无关的没关系，后面有专门的判定步骤；',
    '漏掉相关的才是真正的损失。所以宁可多给，不要保守。',
    '',
    'USER_INTENT（用户自己写的原话，不要改写它）',
    watch.intent,
    '',
    'OUTPUT',
    '- aliases: 意图里提到的人、机构、地点、产品的别名和不同语言写法。',
    '  例如「习近平」→「Xi Jinping」「习主席」「中国国家主席」。人名要给中英文两种写法。',
    '  如果意图里没有具体实体，给空数组。',
    '- relatedTerms: 报道这件事时很可能出现的词，中英文都要。8–20 个。',
    '- sourceHints: 这类内容通常出现在哪些媒体或网站的域名，5–12 个，只写域名。',
    '',
    '全部用 JSON 输出。'
  ].join('\n');

  const t0 = Date.now();
  const res = await provider.generate<RecallAids>(prompt, {
    schema: AIDS_SCHEMA as unknown as Record<string, unknown>,
    model: provider.fastModel,
    temperature: 0.3
  });
  const aids: RecallAids = {
    aliases: dedupe(res.data.aliases),
    relatedTerms: dedupe(res.data.relatedTerms),
    sourceHints: dedupe(res.data.sourceHints).map((s) => s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
    updatedAt: new Date().toISOString()
  };
  saveRecallAids(db, watch.id, aids);
  log({ event: 'watch.aids', phase: 'completed', entityId: watch.id, elapsedMs: Date.now() - t0,
        attrs: { aliases: aids.aliases.length, terms: aids.relatedTerms.length, sources: aids.sourceHints.length } });
  return aids;
}

const dedupe = (xs: unknown): string[] => {
  const arr = Array.isArray(xs) ? xs : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x ?? '').trim();
    if (!s || s.length > 60) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
};

/**
 * Everything a watch needs before it can take part in recall.
 *
 * Returns the REFRESHED watch. Callers must use the return value: recall aids
 * are written to the database, so a caller holding the pre-call object still
 * sees `recallAids: null` and would silently skip the alias recall arm.
 */
export async function prepareWatch(db: Db, provider: Provider, watch: Watch): Promise<Watch> {
  await ensureIntentVector(db, provider, watch);
  if (!watch.recallAids) await generateRecallAids(db, provider, watch);
  return getWatch(db, watch.id) ?? watch;
}
