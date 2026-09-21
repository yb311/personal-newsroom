/**
 * npm run audit:recall — how well each recall arm finds what the person
 * wanted, and what the AI stages cost.
 *
 * This is the hard evidence the architecture asks for: whether dropping
 * keyword filtering was right. For every watch with labels it measures the
 * recall of each arm — R1 (intent vector), R2 (aliases and keywords), R3
 * (search engines) — of their union, and of plain keyword matching on the
 * watch's keywords (what the no-AI mode does). It also checks the judge's
 * verdicts against the labels, and sums token use and cost from logged runs.
 *
 * Labels come from the 👍/👎 the person gives on the watch page (stored as
 * corrections) and, optionally, a file of hand labels:
 *   [{ "watchId": "p-ai", "itemId": "…", "relevant": true }, …]
 *
 *   PNR_DATA_DIR=<a copy of the data folder> npm run audit:recall -- [labels.json] [days]
 *
 * Read-only: the database is opened read-only.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../packages/store/src/index.ts';
import { keywordMatcher } from '../packages/recall/src/index.ts';

const dataDir = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const db = new Database(join(dataDir, 'newsroom.db'), { readonly: true, fileMustExist: true });
const labelFile = process.argv.slice(2).find((a) => a.endsWith('.json'));
const days = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 7);

// ── labels ────────────────────────────────────────────────────────────────
const labels = new Map<string, Map<string, boolean>>();   // watch → item → relevant
const setLabel = (w: string, i: string, rel: boolean): void => {
  if (!labels.has(w)) labels.set(w, new Map());
  labels.get(w)!.set(i, rel);
};
// Latest verdict per item wins.
for (const c of db.prepare('SELECT watch_id, item_id, verdict FROM corrections ORDER BY created_at, id').all() as { watch_id: string; item_id: string; verdict: string }[]) {
  setLabel(c.watch_id, c.item_id, c.verdict === 'wanted');
}
if (labelFile && existsSync(labelFile)) {
  for (const l of JSON.parse(readFileSync(labelFile, 'utf8')) as { watchId: string; itemId: string; relevant: boolean }[]) setLabel(l.watchId, l.itemId, l.relevant);
}

const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%`.padStart(5) : '    –');

console.log(`数据：${dataDir}`);
console.log(`标注：${[...labels.values()].reduce((n, m) => n + m.size, 0)} 条（来自 👍/👎${labelFile ? ` 和 ${labelFile}` : ''}）\n`);

// ── recall per arm ───────────────────────────────────────────────────────
const watches = db.prepare('SELECT id, label, keywords_json FROM watches').all() as { id: string; label: string; keywords_json: string | null }[];
const item = db.prepare('SELECT title, snippet FROM items WHERE id = ?');
const match = db.prepare('SELECT recalled_by, intent_score, passed_gate FROM matches WHERE watch_id = ? AND item_id = ?');
const arms = ['r1_vector', 'r2_alias', 'r3_search'] as const;
const total = { rel: 0, arm: { r1_vector: 0, r2_alias: 0, r3_search: 0 } as Record<string, number>, union: 0, kw: 0, tp: 0, fp: 0, fn: 0, tn: 0 };

console.log('召回率（标为「要」的文章里，各路找到了多少）');
console.log(`  ${'关注'.padEnd(14)} ${'要'.padStart(4)}  R1向量 R2别名 R3搜索  并集   仅关键词`);
for (const w of watches) {
  const l = labels.get(w.id);
  if (!l || l.size === 0) continue;
  const relevant = [...l.entries()].filter(([, r]) => r).map(([id]) => id);
  const keywords = w.keywords_json ? JSON.parse(w.keywords_json) as string[] : [];
  const kw = keywordMatcher(keywords);
  const found: Record<string, number> = { r1_vector: 0, r2_alias: 0, r3_search: 0 };
  let union = 0, kwHits = 0;
  const missed: string[] = [];
  for (const id of relevant) {
    const m = match.get(w.id, id) as { recalled_by: string } | undefined;
    const by = new Set((m?.recalled_by ?? '').split(','));
    for (const a of arms) if (by.has(a)) found[a]!++;
    if (arms.some((a) => by.has(a))) union++;
    else missed.push(id);
    const it = item.get(id) as { title: string; snippet: string | null } | undefined;
    if (it && kw(`${it.title}\n${it.snippet ?? ''}`)) kwHits++;
  }
  // The judge against the labels, over items it scored.
  for (const [id, rel] of l) {
    const m = match.get(w.id, id) as { intent_score: number | null; passed_gate: number } | undefined;
    if (!m || m.intent_score === null) continue;
    if (m.passed_gate && rel) total.tp++; else if (m.passed_gate) total.fp++; else if (rel) total.fn++; else total.tn++;
  }
  console.log(`  ${w.label.slice(0, 12).padEnd(14)} ${String(relevant.length).padStart(4)}  ${arms.map((a) => pct(found[a]!, relevant.length)).join('  ')}  ${pct(union, relevant.length)}   ${keywords.length ? pct(kwHits, relevant.length) : ' 无关键词'}`);
  for (const id of missed.slice(0, 3)) console.log(`      没召回：${(item.get(id) as { title: string } | undefined)?.title.slice(0, 60) ?? id}`);
  total.rel += relevant.length; total.union += union; total.kw += kwHits;
  for (const a of arms) total.arm[a]! += found[a]!;
}
if (total.rel) {
  console.log(`  ${'合计'.padEnd(14)} ${String(total.rel).padStart(4)}  ${arms.map((a) => pct(total.arm[a]!, total.rel)).join('  ')}  ${pct(total.union, total.rel)}   ${pct(total.kw, total.rel)}`);
  const judged = total.tp + total.fp + total.fn + total.tn;
  console.log(`\nAI 判定（与标注对照，${judged} 条）：留下的里 ${pct(total.tp, total.tp + total.fp).trim()} 确实想要；想要的里 ${pct(total.tp, total.tp + total.fn).trim()} 被留下`);
} else {
  console.log('  （还没有标注。在「关注 → 相关报道」里点 👍/👎，或提供标注文件。）');
}

// ── cost from logged runs ───────────────────────────────────────────────────
console.log(`\n最近 ${days} 天的 AI 用量`);
const requests = db.prepare(`SELECT operation,input_tokens,output_tokens,cost_usd,cost_known FROM ai_requests WHERE created_at>=?`)
  .all(Date.now() - days * 864e5) as { operation: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; cost_known: number }[];
const byStage = new Map<string, { calls: number; tin: number; tout: number; cost: number; unknown: number }>();
for (const request of requests) {
  const s = byStage.get(request.operation) ?? { calls: 0, tin: 0, tout: 0, cost: 0, unknown: 0 };
  s.calls++; s.tin += request.input_tokens ?? 0; s.tout += request.output_tokens ?? 0;
  if (request.cost_known) s.cost += request.cost_usd ?? 0; else s.unknown++;
  byStage.set(request.operation, s);
}
if (byStage.size === 0) console.log('  （这段时间没有记录到 AI 调用。）');
let sum = 0;
for (const [stage, s] of [...byStage.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
  sum += s.cost;
  console.log(`  ${stage.padEnd(20)} ${String(s.calls).padStart(4)} 次  输入 ${String(s.tin).padStart(8)}  输出 ${String(s.tout).padStart(7)}  $${s.cost.toFixed(4)}${s.unknown ? ` · ${s.unknown} 次费用未知` : ''}`);
}
if (byStage.size) console.log(`  ${'合计'.padEnd(20)} $${sum.toFixed(4)}（约 $${(sum / days).toFixed(4)} / 天；未知价格未冒充为零）`);
db.close();
