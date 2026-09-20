/** Full funnel on live news: ingest → recall (3 arms) → judge → gate,
 *  with the real token cost so the 15-cents-a-day model can be checked. */
import { openDb } from '../packages/store/src/index.ts';
import { ingestAll } from '../packages/feed/src/index.ts';
import { resolveProvider, writeSetting, invalidateProvider, geminiCost } from '../packages/ai/src/index.ts';
import { createWatch, prepareWatch } from '../packages/watch/src/index.ts';
import { recallForWatch, judgeAll, gateWatch } from '../packages/recall/src/index.ts';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = process.env.GEMINI_API_KEY ?? '';
if (!key) { console.log('需要 GEMINI_API_KEY'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'pnr-pipe-'));
const db = openDb(join(dir, 'db.sqlite'));
writeSetting(db, 'ai.provider', 'gemini'); writeSetting(db, 'ai.geminiApiKey', key); invalidateProvider();
const p = (await resolveProvider(db))!;

// 1) 灌入真实新闻
const feeds = JSON.parse(readFileSync(new URL('../catalogs/data/feeds.json', import.meta.url), 'utf8')) as any[];
const ins = db.prepare(`INSERT INTO sources (id,kind,name,domain,url,category,lang,country,trust,enabled,date_hydration,added_by,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,'catalog',?) ON CONFLICT(id) DO NOTHING`);
const now = Date.now();
db.transaction(() => { for (const f of feeds)
  ins.run(f.id,f.kind,f.name,f.domain??null,f.url,f.category??null,f.lang??null,f.country??null,f.trust,f.featured?1:0,f.dateHydration??null,now); })();
console.log('抓取中…');
const ing = await ingestAll(db, 8);
console.log(`  ${ing.sources} 个源 → ${ing.inserted} 条\n`);

// 2) 建两个关注
const watches = [
  createWatch(db, { origin: 'intent', label: '习近平', intent: '我想知道习近平最近在干什么', outputLang: 'zh-CN' }),
  createWatch(db, { origin: 'intent', label: 'AI 芯片', intent: 'I want to follow AI chip supply: Nvidia, TSMC, export controls and capacity', outputLang: 'en-US' })
];

let tokIn = 0, tokOut = 0, embedded = 0;
const origEmbed = p.embed.bind(p);
(p as any).embed = async (t: string[], k: any) => { embedded += t.reduce((a,s)=>a+Math.ceil(s.length/4),0); return origEmbed(t,k); };
const origGen = p.generate.bind(p);
let genCost = 0;
(p as any).generate = async (pr: string, o: any) => {
  const r = await origGen(pr,o);
  tokIn += r.usage?.input ?? 0; tokOut += r.usage?.output ?? 0;
  genCost += geminiCost(r.model, r.usage?.input ?? 0, r.usage?.output ?? 0);
  return r;
};

const total = (db.prepare('SELECT count(*) c FROM items').get() as any).c;
for (const w of watches) {
  console.log(`━━ ${w.label} ━━`);
  console.log(`   「${w.intent}」`);
  const t0 = Date.now();
  const ready = await prepareWatch(db, p, w);
  const cands = await recallForWatch(db, p, ready, { windowHours: 72, vectorTopN: 60, useSearch: true, maxJudged: 50 });
  const arms = { r1: 0, r2: 0, r3: 0 };
  for (const c of cands) { if (c.arms.has('r1_vector')) arms.r1++; if (c.arms.has('r2_alias')) arms.r2++; if (c.arms.has('r3_search')) arms.r3++; }
  console.log(`   进判定 ${cands.length} 条（库里共 ${total}）— 其中 R1 向量 ${arms.r1} · R2 别名 ${arms.r2} · R3 搜索 ${arms.r3}`);
  const judged = await judgeAll(db, p, ready, cands);
  const passed = gateWatch(db, ready, 'balanced');
  console.log(`   判定 ${judged.size} 条 → 过闸 ${passed} 条   耗时 ${((Date.now()-t0)/1000).toFixed(1)}s`);
  const top = db.prepare(`SELECT i.title, m.intent_score s, m.reason, m.recalled_by arms FROM matches m
    JOIN items i ON i.id=m.item_id WHERE m.watch_id=? AND m.passed_gate=1
    ORDER BY m.intent_score DESC LIMIT 4`).all(w.id) as any[];
  for (const t of top) console.log(`     ${String(t.s).padStart(2)}分 [${t.arms}] ${t.title.slice(0,52)}`);
  const rej = db.prepare(`SELECT i.title, m.intent_score s, m.reason FROM matches m JOIN items i ON i.id=m.item_id
    WHERE m.watch_id=? AND m.passed_gate=0 AND m.intent_score IS NOT NULL ORDER BY m.intent_score DESC LIMIT 2`).all(w.id) as any[];
  if (rej.length) { console.log('   被拦掉的边缘案例:'); for (const r of rej) console.log(`     ${String(r.s).padStart(2)}分 ${r.title.slice(0,44)} — ${String(r.reason).slice(0,34)}`); }
  console.log();
}

const cost = genCost + (embedded/1e6) * 0.15;
console.log('━━ 成本 ━━');
console.log(`   ${watches.length} 个关注 · ${total} 条新闻`);
console.log(`   生成 token: ${tokIn} 入 / ${tokOut} 出 · embed 约 ${embedded} token`);
console.log(`   本次花费: $${cost.toFixed(4)}  → 折合每关注 $${(cost/watches.length).toFixed(4)}`);
console.log(`   按 5 个关注估算每天: $${(cost/watches.length*5).toFixed(3)}（仅召回判定，不含写作）`);

db.close(); rmSync(dir,{recursive:true,force:true});
