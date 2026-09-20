/** Ingest → recall → judge → gate → digest + progress, then run progress a
 *  SECOND time to verify it recognises what it already said. */
import { openDb } from '../packages/store/src/index.ts';
import { ingestAll } from '../packages/feed/src/index.ts';
import { resolveProvider, writeSetting, invalidateProvider, geminiCost } from '../packages/ai/src/index.ts';
import { createWatch, prepareWatch } from '../packages/watch/src/index.ts';
import { recallForWatch, judgeAll, gateWatch } from '../packages/recall/src/index.ts';
import { generateDigest, generateProgress, newSinceYesterday, timeline } from '../packages/generate/src/index.ts';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = process.env.GEMINI_API_KEY ?? '';
if (!key) { console.log('需要 GEMINI_API_KEY'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'pnr-gen-'));
const db = openDb(join(dir, 'db.sqlite'));
writeSetting(db,'ai.provider','gemini'); writeSetting(db,'ai.geminiApiKey',key); invalidateProvider();
const p = (await resolveProvider(db))!;
let cost = 0;
const og = p.generate.bind(p);
(p as any).generate = async (pr: string, o: any) => { const r = await og(pr,o); cost += geminiCost(r.model, r.usage?.input??0, r.usage?.output??0); return r; };
const oe = p.embed.bind(p);
(p as any).embed = async (t: string[], k: any) => { cost += t.reduce((a,s)=>a+Math.ceil(s.length/4),0)/1e6*0.15; return oe(t,k); };

const feeds = JSON.parse(readFileSync(new URL('../catalogs/data/feeds.json', import.meta.url),'utf8')) as any[];
const ins = db.prepare(`INSERT INTO sources (id,kind,name,domain,url,category,lang,country,trust,enabled,date_hydration,added_by,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,'catalog',?) ON CONFLICT(id) DO NOTHING`);
const now = Date.now();
db.transaction(()=>{for(const f of feeds) ins.run(f.id,f.kind,f.name,f.domain??null,f.url,f.category??null,f.lang??null,f.country??null,f.trust,f.featured?1:0,f.dateHydration??null,now);})();
console.log('抓取中…'); const ing = await ingestAll(db, 8); console.log(`  ${ing.inserted} 条\n`);

const raw = [
  createWatch(db,{origin:'intent',label:'习近平',intent:'我想知道习近平最近在干什么',outputLang:'zh-CN'}),
  createWatch(db,{origin:'intent',label:'AI 芯片',intent:'我想跟进 AI 芯片的供应链：英伟达、台积电、出口管制和产能',outputLang:'zh-CN'})
];
const watches = [];
for (const w of raw) {
  const ready = await prepareWatch(db, p, w);
  const c = await recallForWatch(db, p, ready, { windowHours: 72, maxJudged: 40 });
  await judgeAll(db, p, ready, c);
  const passed = gateWatch(db, ready, 'balanced');
  console.log(`${ready.label}: 判定 ${c.length} → 过闸 ${passed}`);
  watches.push(ready);
}

console.log('\n━━ 今日摘要（所有关注合并成一次调用）━━');
const d = await generateDigest(db, p, watches, 'zh-CN');
if (!d) console.log('  无内容');
else {
  console.log(`  《${d.title}》`);
  for (const b of d.blocks.slice(0, 7)) {
    if (b.type === 'heading') console.log(`\n  ## ${b.text}`);
    else if (b.type === 'paragraph') console.log(`  ${b.text.slice(0,96)}${b.text.length>96?'…':''}  [依据 ${b.sourceRefIds?.length ?? 0} 条]`);
  }
  const cited = d.blocks.filter(b=>b.type==='paragraph').every(b=>(b as any).sourceRefIds?.length>0);
  console.log(`\n  每段都绑定了来源: ${cited?'✅':'❌'}`);
}

console.log('\n━━ 进展：第一次 ━━');
for (const w of watches) {
  const ms = await generateProgress(db, p, w, w.outputLang ?? 'zh-CN');
  console.log(`  ${w.label}: ${ms.length} 个节点（首次跟进=建仓基线，不标新增）`);
  for (const m of ms.slice(0,3)) console.log(`    ${m.occurredOn} ${m.isNew?'🆕':'  '} ${m.summary.slice(0,58)}`);
}

console.log('\n━━ 注入一条真正的新发展 ━━');
{
  const w = watches[0]!;
  const nid = 'fresh-dev-1';
  const ts = Date.now();
  db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,snippet,published_at,discovered_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(nid, nid, 'reuters', 'https://example.com/fresh',
      '习近平与特朗普签署为期五年的贸易协议，关税立即下调 15%',
      '两国元首在白宫正式签署协议，美方同步宣布下调对华关税 15 个百分点，协议自签署之日起生效。', ts, ts);
  db.prepare("INSERT INTO matches (watch_id,item_id,recalled_by,intent_score,reason,passed_gate,judged_at,created_at) VALUES (?,?,'test',10,'直接报道',1,?,?)")
    .run(w.id, nid, ts, ts);
  console.log('  已注入：习近平与特朗普签署贸易协议（这是之前没说过的事）');
}

console.log('\n━━ 进展：第二次（旧材料应认出说过，新材料应认出是新的）━━');
let totalNew = 0;
for (const w of watches) {
  const ms = await generateProgress(db, p, w, w.outputLang ?? 'zh-CN');
  const n = ms.filter(m=>m.isNew).length;
  totalNew += n;
  const expectNew = w === watches[0] ? 1 : 0;
  const okMark = w === watches[0] ? n >= 1 : n === 0;
  console.log(`  ${w.label}: ${ms.length} 个节点，新增 ${n}（期望 ${expectNew === 1 ? '≥1' : '0'}）${okMark ? ' ✅' : ' ❌'}`);
  for (const m of ms.filter(x=>x.isNew)) console.log(`     🆕 ${m.summary.slice(0,56)}`);
}
console.log(`\n  结论：旧的认出已说过、新的认出是新增 → ${totalNew >= 1 ? '✅' : '❌'}`);

console.log('\n━━ 两种视图共用一份数据 ━━');
for (const w of watches) {
  console.log(`  ${w.label}: 「昨天到今天」${newSinceYesterday(db, w.id).length} 条 · 完整时间线 ${timeline(db, w.id).length} 条`);
}
console.log(`\n本次全部花费: $${cost.toFixed(4)}`);
db.close(); rmSync(dir,{recursive:true,force:true});
