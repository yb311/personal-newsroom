import type { Db } from '@pnr/store';
import { createWatch, listWatches } from './watch.ts';

/**
 * Preset topics are just watches with a pre-written intent sentence.
 *
 * They are not a separate mechanism: ticking one creates the same object that
 * writing a sentence creates, runs down the same pipeline, and exposes the same
 * editable recall aids. Presets are the one-click floor; a sentence is the
 * ceiling.
 */
export interface Preset { id: string; label: string; intent: string }

export const PRESETS: Preset[] = [
  { id: 'p-tech',      label: '科技',     intent: '我想看科技行业的重要进展：新产品发布、技术突破、大公司的战略动作和监管变化。' },
  { id: 'p-ai',        label: '人工智能', intent: '我想跟进人工智能领域的进展：新模型、研究突破、产品落地、算力与芯片，以及相关的监管和争议。' },
  { id: 'p-world',     label: '国际时政', intent: '我想了解国际政治的重要动态：国家间关系的变化、重大外交事件、冲突与谈判的最新进展。' },
  { id: 'p-economy',   label: '财经',     intent: '我想看经济和金融的重要消息：央行政策、通胀与就业数据、重大并购、市场剧烈波动背后的原因。' },
  { id: 'p-china',     label: '中国',     intent: '我想了解中国的重要新闻：政策发布、经济数据、社会事件，以及外界对中国的重要报道。' },
  { id: 'p-science',   label: '科学',     intent: '我想看科学研究的重要成果：医学、生物、物理、太空探索方面有实质进展的发现。' },
  { id: 'p-climate',   label: '气候环境', intent: '我想关注气候与环境议题：极端天气事件、能源转型、环境政策和相关的科学研究。' },
  { id: 'p-security',  label: '安全与冲突', intent: '我想了解战争、冲突与安全局势的最新进展，包括军事行动、停火谈判和人道状况。' },
  { id: 'p-business',  label: '商业',     intent: '我想看商业世界的重要变化：公司财报、领导层变动、行业格局转变和重大投资。' },
  { id: 'p-culture',   label: '文化',     intent: '我想看文化领域值得一读的内容：影视、音乐、出版、艺术方面的重要作品和现象。' }
];

/** Creates a watch from a preset. Idempotent. */
export function enablePreset(db: Db, presetId: string): string | null {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) return null;
  const existing = listWatches(db).find((w) => w.id === p.id);
  if (existing) return existing.id;
  return createWatch(db, { id: p.id, origin: 'preset', label: p.label, intent: p.intent }).id;
}
