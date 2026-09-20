import { openDb } from '../packages/store/src/index.ts';
import { resolveProvider, writeSetting, invalidateProvider, geminiCost } from '../packages/ai/src/index.ts';
import { listWatches } from '../packages/watch/src/index.ts';
import { generateFlashes, recentFlashes, generateDeepSummary } from '../packages/generate/src/index.ts';

const key = process.env.GEMINI_API_KEY ?? '';
const DIR = process.env.PNR_DATA_DIR!;
if (!key) { console.log('需要 key'); process.exit(0); }
const db = openDb(`${DIR}/newsroom.db`);
writeSetting(db,'ai.provider','gemini'); writeSetting(db,'ai.geminiApiKey',key); invalidateProvider();
const p = (await resolveProvider(db))!;
let cost = 0;
const og = p.generate.bind(p); (p as any).generate = async (a:any,b:any)=>{const r=await og(a,b);cost+=geminiCost(r.model,r.usage?.input??0,r.usage?.output??0);return r;};

console.log('━━ 快讯 ━━');
for (const w of listWatches(db, true)) {
  const f = await generateFlashes(db, p, w, 'zh-CN');
  console.log(`  ${w.label}: 发布 ${f.length} 条`);
  for (const x of f.slice(0,3))
    console.log(`    [${x.importance}分·${x.basis}${x.followUpOf?'·后续':''}] ${x.title.slice(0,50)}\n       ${x.body.slice(0,76)}`);
}
console.log(`\n  24 小时窗口内共 ${recentFlashes(db).length} 条`);

console.log('\n━━ 快讯去重：同样材料再跑一次 ━━');
let again = 0;
for (const w of listWatches(db, true)) again += (await generateFlashes(db, p, w, 'zh-CN')).length;
console.log(`  第二次新发 ${again} 条  ${again === 0 ? '✅ 认出已发过' : '⚠️ 仍发了 ' + again + ' 条'}`);

console.log('\n━━ 按需深度总结 ━━');
const seed = db.prepare(`SELECT i.id, i.title FROM matches m JOIN items i ON i.id=m.item_id
  WHERE m.passed_gate=1 ORDER BY m.intent_score DESC LIMIT 1`).get() as any;
console.log(`  对象：${seed.title.slice(0,56)}`);
const t0 = Date.now();
const d = await generateDeepSummary(db, p, DIR, seed.id, 'zh-CN');
if (!d) console.log('  ❌ 生成失败');
else {
  console.log(`  ${((Date.now()-t0)/1000).toFixed(1)}s · ${d.sources.length} 份材料 · ${d.blocks.length} 块 · ${d.milestones.length} 个节点`);
  for (const b of d.blocks.slice(0,3)) {
    if (b.type==='heading') console.log(`\n  《${b.text}》`);
    else if (b.type==='paragraph') console.log(`  ${b.text.slice(0,84)}…  [${(b as any).sourceRefIds?.join(' ')}]`);
  }
  const allCited = d.blocks.filter(b=>b.type==='paragraph').every(b=>(b as any).sourceRefIds?.length>0);
  console.log(`\n  每段都能溯源: ${allCited?'✅':'❌'}`);
  console.log(`  来源表: ${d.sources.slice(0,3).map(s=>`${s.refId}=${s.domain??'?'}`).join('  ')}`);
  const t1 = Date.now(); await generateDeepSummary(db, p, DIR, seed.id, 'zh-CN');
  console.log(`  二次（走缓存）: ${Date.now()-t1}ms  ${Date.now()-t1 < 60 ? '✅' : '❌'}`);
}
console.log(`\n本次花费 $${cost.toFixed(4)}`);
db.close();
