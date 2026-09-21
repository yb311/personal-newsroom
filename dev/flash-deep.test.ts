import { openDb } from '../packages/store/src/index.ts';
import { resolveProvider, geminiCost } from '../packages/ai/src/index.ts';
import { listWatches } from '../packages/watch/src/index.ts';
import { generateFlashes, recentFlashes, startReport, askReport } from '../packages/generate/src/index.ts';

const key = process.env.GEMINI_API_KEY ?? '';
const DIR = process.env.PNR_DATA_DIR!;
if (!key) { console.log('需要 key'); process.exit(0); }
const db = openDb(`${DIR}/newsroom.db`);
const p = (await resolveProvider(db))!;
let cost = 0;
const og = p.generate.bind(p); (p as any).generate = async (a:any,b:any)=>{const r=await og(a,b);cost+=geminiCost(r.model,r.usage?.input??0,r.usage?.output??0)??0;return r;};

console.log('━━ 快讯 ━━');
for (const w of listWatches(db, true)) {
  const f = await generateFlashes(db, p, [w], 'zh-CN');
  console.log(`  ${w.label}: 发布 ${f.length} 条`);
  for (const x of f.slice(0,3))
    console.log(`    [${x.importance}分·${x.basis}${x.followUpOf?'·后续':''}] ${x.title.slice(0,50)}\n       ${x.body.slice(0,76)}`);
}
console.log(`\n  24 小时窗口内共 ${recentFlashes(db).length} 条`);

console.log('\n━━ 快讯去重：同样材料再跑一次 ━━');
let again = 0;
for (const w of listWatches(db, true)) again += (await generateFlashes(db, p, [w], 'zh-CN')).length;
console.log(`  第二次新发 ${again} 条  ${again === 0 ? '✅ 认出已发过' : '⚠️ 仍发了 ' + again + ' 条'}`);

console.log('\n━━ 深度报道会话 ━━');
const seed = db.prepare(`SELECT i.id, i.title FROM matches m JOIN items i ON i.id=m.item_id
  WHERE m.passed_gate=1 ORDER BY m.intent_score DESC LIMIT 1`).get() as any;
console.log(`  对象：${seed.title.slice(0,56)}`);
const t0 = Date.now(); const event = () => {};
const d = await startReport(db, p, DIR, { anchorItemId: seed.id, itemIds: [seed.id], topic: seed.title, lang: 'zh-CN', restart: true, requestId: crypto.randomUUID() }, event);
console.log(`  ${((Date.now()-t0)/1000).toFixed(1)}s · ${d.sources.length} 份完整材料 · ${d.messages.length} 条消息`);
const a = d.messages.findLast(m => m.answer)?.answer;
console.log(`  逐条可溯源: ${a?.units.every(u => !u.supported || u.sourceRefIds.length > 0) ? '✅' : '❌'}`);
const followed = await askReport(db, p, DIR, d.id, '还有哪些关键事实存在分歧？', crypto.randomUUID(), false, event);
console.log(`  两轮追问: ${followed.messages.filter(m => m.role === 'assistant' && m.status === 'complete').length === 2 ? '✅' : '❌'}`);
console.log(`\n本次花费 $${cost.toFixed(4)}`);
db.close();
