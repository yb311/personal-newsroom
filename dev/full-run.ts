/** One complete run, then export everything the UI needs so the result can be
 *  inspected in the renderer. */
import { openDb } from '../packages/store/src/index.ts';
import { ingestAll } from '../packages/feed/src/index.ts';
import { enrichPending } from '../packages/reader/src/index.ts';
import { resolveProvider, writeSetting, invalidateProvider, geminiCost } from '../packages/ai/src/index.ts';
import { createWatch, enablePreset, prepareWatch, listWatches, PRESETS } from '../packages/watch/src/index.ts';
import { recallForWatch, judgeAll, gateWatch } from '../packages/recall/src/index.ts';
import { generateDigest, generateProgress, newSinceYesterday, timeline, getDigest } from '../packages/generate/src/index.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY ?? '';
const DIR = process.env.PNR_DATA_DIR!;
mkdirSync(DIR, { recursive: true });
const db = openDb(`${DIR}/newsroom.db`);

const feeds = JSON.parse(readFileSync(new URL('../catalogs/data/feeds.json', import.meta.url), 'utf8')) as any[];
const ins = db.prepare(`INSERT INTO sources (id,kind,name,domain,url,category,lang,country,trust,enabled,date_hydration,added_by,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,'catalog',?) ON CONFLICT(id) DO NOTHING`);
const now = Date.now();
db.transaction(()=>{for(const f of feeds) ins.run(f.id,f.kind,f.name,f.domain??null,f.url,f.category??null,f.lang??null,f.country??null,f.trust,f.featured?1:0,f.dateHydration??null,now);})();

console.log('抓取…'); const ing = await ingestAll(db, 8);
console.log(`  ${ing.inserted} 条`);
console.log('抽正文…'); const en = await enrichPending(db, DIR, 30, 5);
console.log(`  ok=${en.ok} blocked=${en.blocked} failed=${en.failed}`);

if (key) {
  writeSetting(db,'ai.provider','gemini'); writeSetting(db,'ai.geminiApiKey',key); writeSetting(db,'outputLang','zh-CN');
  invalidateProvider();
  const p = (await resolveProvider(db))!;
  let cost = 0;
  const og = p.generate.bind(p); (p as any).generate = async (a:any,b:any)=>{const r=await og(a,b);cost+=geminiCost(r.model,r.usage?.input??0,r.usage?.output??0);return r;};
  const oe = p.embed.bind(p); (p as any).embed = async (t:string[],k:any)=>{cost+=t.reduce((a,s)=>a+Math.ceil(s.length/4),0)/1e6*0.15;return oe(t,k);};

  enablePreset(db, 'p-ai');
  createWatch(db,{origin:'intent',label:'习近平',intent:'我想知道习近平最近在干什么',outputLang:'zh-CN'});
  const ready = [];
  for (const w of listWatches(db, true)) {
    console.log(`关注「${w.label}」…`);
    const r = await prepareWatch(db, p, w);
    const c = await recallForWatch(db, p, r, { windowHours: 72, maxJudged: 40 });
    await judgeAll(db, p, r, c);
    console.log(`  判定 ${c.length} → 过闸 ${gateWatch(db, r, 'balanced')}`);
    ready.push(r);
  }
  console.log('写摘要…');
  const d = await generateDigest(db, p, ready, 'zh-CN');
  console.log(`  《${d?.title ?? '无'}》`);
  for (const w of ready) { const ms = await generateProgress(db, p, w, 'zh-CN'); console.log(`  ${w.label} 时间线 ${ms.length} 个节点`); }
  console.log(`\n总花费 $${cost.toFixed(4)}`);
}

// 导出 UI mock
const q = (s: string, ...a: any[]) => db.prepare(s).all(...a) as any[];
const sources = q(`SELECT s.id,s.name,s.kind,s.category,s.country,s.domain,s.enabled,s.last_error lastError,
  COUNT(i.id) total, SUM(CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END) unread
  FROM sources s LEFT JOIN items i ON i.source_id=s.id LEFT JOIN reading_state r ON r.item_id=i.id
  WHERE s.enabled=1 GROUP BY s.id ORDER BY s.name`);
const items = q(`SELECT i.id,i.title,i.url,i.published_at publishedAt,i.snippet,i.image_url imageUrl,i.author,
  s.name sourceName,s.id sourceId,i.body_state bodyState,i.body_words bodyWords,s.domain,
  NULL readAt,NULL starredAt,i.body_path bodyPath,i.body_error bodyError
  FROM items i JOIN sources s ON s.id=i.source_id ORDER BY (i.body_state='ok') DESC, i.published_at DESC LIMIT 140`);
const bodies: Record<string, unknown> = {};
for (const it of items) if (it.bodyPath && existsSync(it.bodyPath))
  try { bodies[it.id] = JSON.parse(readFileSync(it.bodyPath,'utf8')).blocks; } catch {}
const ws = listWatches(db).map(w => ({ ...w, newCount: newSinceYesterday(db,w.id).length,
  timelineCount: timeline(db,w.id).length,
  passed: (db.prepare('SELECT COUNT(*) c FROM matches WHERE watch_id=? AND passed_gate=1').get(w.id) as any).c }));
const onIds = new Set(ws.map(w=>w.id));
const today = { date: new Date().toISOString().slice(0,10), digest: getDigest(db, new Date().toISOString().slice(0,10)),
  changes: ws.filter(w=>w.active).map(w=>({watchId:w.id,label:w.label,milestones:newSinceYesterday(db,w.id)})).filter(x=>x.milestones.length>0) };
const timelines: Record<string, unknown> = {};
for (const w of ws) timelines[w.id] = { milestones: timeline(db, w.id), items: [] };
writeFileSync('apps/desktop/dist/renderer/mock.json', JSON.stringify({
  sources, items, bodies, cat: q('SELECT id,name,kind,category,country,domain,enabled,NULL lastError,0 unread,0 total FROM sources ORDER BY enabled DESC,name LIMIT 300'),
  watches: ws, presets: PRESETS.map(p=>({...p, enabled: onIds.has(p.id)})), today, timelines,
  ai: { available: Boolean(key), provider: 'gemini', outputLang: 'zh-CN' }
}));
console.log(`\n导出 mock：${items.length} 条 · ${Object.keys(bodies).length} 篇正文 · ${ws.length} 个关注 · 摘要 ${today.digest?'有':'无'} · 变化 ${today.changes.length} 组`);
db.close();
