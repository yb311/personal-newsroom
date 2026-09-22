import { openDb } from '../packages/store/src/index.ts';
import { resolveProvider, geminiCost } from '../packages/ai/src/index.ts';
import { listWatches } from '../packages/watch/src/index.ts';
import { generateFlashes, recentFlashes, askAssistant } from '../packages/generate/src/index.ts';

const key = process.env.GEMINI_API_KEY ?? '';
const DIR = process.env.PNR_DATA_DIR!;
if (!key) { console.log('需要 key'); process.exit(0); }
const db = openDb(`${DIR}/newsroom.db`);
const p = (await resolveProvider(db))!;
let cost = 0;
const og = p.generate.bind(p); (p as any).generate = async (a:any,b:any)=>{const r=await og(a,b);cost+=geminiCost(r.model,r.usage?.input??0,r.usage?.output??0)??0;return r;};

console.log('━━ 快讯 ━━');
const watches=listWatches(db,true);
const flashes=await generateFlashes(db,p,watches,'zh-CN',{remaining:5,byEvent:new Map()});
console.log(`  跨 ${watches.length} 个关注合并写作：发布 ${flashes.length} 条（全局上限 5）`);
for (const x of flashes.slice(0,5))
  console.log(`    [${x.importance}分·${x.basis}${x.followUpOf?'·后续':''}] ${x.title.slice(0,50)}\n       ${x.body.slice(0,76)}`);
console.log(`\n  24 小时窗口内共 ${recentFlashes(db).length} 条`);

console.log('\n━━ 快讯去重：同样材料再跑一次 ━━');
const again=(await generateFlashes(db,p,watches,'zh-CN',{remaining:5,byEvent:new Map()})).length;
console.log(`  第二次新发 ${again} 条  ${again === 0 ? '✅ 认出已发过' : '⚠️ 仍发了 ' + again + ' 条'}`);

console.log('\n━━ 新闻助手 ━━');
const seed = db.prepare(`SELECT i.id, i.title FROM matches m JOIN items i ON i.id=m.item_id
  WHERE m.passed_gate=1 ORDER BY m.intent_score DESC LIMIT 1`).get() as any;
console.log(`  问题：${seed.title.slice(0,56)} 最新进展如何？`);
const t0 = Date.now(); const event = () => {};
const d = await askAssistant(db, p, DIR, { question: `${seed.title} 最新进展如何？`, web: true, lang: 'zh-CN', requestId: crypto.randomUUID() }, event);
console.log(`  ${((Date.now()-t0)/1000).toFixed(1)}s · ${d.sources.length} 份材料 · ${d.messages.length} 条消息`);
const a = d.messages.findLast(m => m.answer)?.answer;
console.log(`  逐条可溯源: ${a?.units.every(u => !u.supported || u.sourceRefIds.length > 0) ? '✅' : '❌'}`);
const followed = await askAssistant(db, p, DIR, { chatId: d.id, question: '还有哪些关键事实存在分歧？', web: false, lang: 'zh-CN', requestId: crypto.randomUUID() }, event);
console.log(`  两轮追问: ${followed.messages.filter(m => m.role === 'assistant' && m.status === 'complete').length === 2 ? '✅' : '❌'}`);
console.log(`\n本次花费 $${cost.toFixed(4)}`);
db.close();
