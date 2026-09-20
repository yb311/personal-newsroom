import { openDb } from '../packages/store/src/index.ts';
import { resolveProvider, writeSetting, aiAvailable, invalidateProvider,
         embedItems, nearestItems, upsertWatchVector, pruneVectors } from '../packages/ai/src/index.ts';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pnr-ai-'));
const db = openDb(join(dir, 'db.sqlite'));

console.log('=== 无 key 时的降级 ===');
process.env.PNR_IGNORE_ENV_KEY = '1';   // 模拟出厂状态：没有任何环境变量
invalidateProvider();
const noKey = await aiAvailable(db);
console.log(`  aiAvailable: ${noKey}  ← 应为 false ${noKey ? '❌' : '✅'}`);
delete process.env.PNR_IGNORE_ENV_KEY;

const key = process.env.GEMINI_API_KEY ?? '';
if (!key) { console.log('\n未提供 GEMINI_API_KEY，跳过联网测试'); process.exit(0); }
writeSetting(db, 'ai.provider', 'gemini');
writeSetting(db, 'ai.geminiApiKey', key);
invalidateProvider();

const p = await resolveProvider(db);
if (!p) { console.log('  ❌ 解析不到 provider'); process.exit(1); }
console.log(`\n=== provider: ${p.name} (write=${p.writeModel} fast=${p.fastModel}) ===`);

// 结构化输出
console.log('\n=== 结构化输出 ===');
const schema = {
  type: 'object',
  properties: {
    results: { type: 'array', items: {
      type: 'object',
      properties: { id: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } },
      required: ['id', 'score', 'reason']
    }}
  },
  required: ['results']
};
const prompt = [
  '用户原话：「我想知道习近平最近在干什么」',
  '', '判断下面每条新闻跟这句话的相关度（0-10），并用一句中文说明理由。',
  '', 'ITEMS:',
  'a1: Xi Jinping meets Trump in Beijing for historic summit',
  'a2: Manchester City beat Sunderland to maintain 100% league start',
  'a3: 习近平就生态文明建设作出重要指示'
].join('\n');
const t0 = Date.now();
const r = await p.generate<{results:{id:string;score:number;reason:string}[]}>(prompt, { schema, model: p.fastModel, temperature: 0 });
console.log(`  ${Date.now()-t0}ms  model=${r.model}  token in/out=${r.usage?.input}/${r.usage?.output}`);
for (const x of r.data.results) console.log(`    ${x.id}  ${String(x.score).padStart(4)}  ${x.reason.slice(0,44)}`);
const ok = (r.data.results.find(x=>x.id==='a1')?.score ?? 0) > (r.data.results.find(x=>x.id==='a2')?.score ?? 10);
console.log(`  相关的分数高于无关的: ${ok ? '是' : '否 ❌'}`);

// 向量 + 缓存
console.log('\n=== 向量与缓存 ===');
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','t','u',0.9,1,'user',?)").run(Date.now());
const docs = [
  { id: 'i1', text: '习近平会见特朗普，双方就贸易问题达成初步共识' },
  { id: 'i2', text: '曼城击败桑德兰，保持联赛全胜开局' },
  { id: 'i3', text: '中国国家主席出席亚太经合组织会议并发表讲话' }
];
for (const d of docs)
  db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES (?,?,'s',?,?,?,?)")
    .run(d.id, d.id, 'http://x/'+d.id, d.text, Date.now(), Date.now());
const t1 = Date.now();
const v1 = await embedItems(db, p, docs);
console.log(`  首次 embed ${v1.size} 条: ${Date.now()-t1}ms  ${v1.size === docs.length ? '✅' : '❌ 应为 ' + docs.length}`);
const t2 = Date.now();
const v2 = await embedItems(db, p, docs);
const cachedMs = Date.now()-t2;
console.log(`  二次（走缓存）: ${cachedMs}ms  ${cachedMs < 50 ? '✅ 命中缓存' : '❌ 未命中'}`);
console.log(`  维度: ${v1.get('i1')?.length}`);

const [q] = await p.embed(['习近平最近在干什么'], 'query');
upsertWatchVector(db, 'w1', q!);
const near = nearestItems(db, q!, 3);
console.log('  意图向量最近邻:');
for (const n of near) {
  const title = (db.prepare('SELECT title FROM items WHERE id=?').get(n.itemId) as any).title;
  console.log(`    ${n.distance.toFixed(4)}  ${title.slice(0,36)}`);
}
const top = near[0]?.itemId;
console.log(`  最近的是习近平相关条目: ${top === 'i1' || top === 'i3' ? '是' : '否 ❌'}`);

// 清理策略
db.prepare("UPDATE items SET published_at=? WHERE id='i2'").run(Date.now() - 400*864e5);
console.log(`\n=== 向量清理 ===\n  剪掉 ${pruneVectors(db, 180)} 条旧向量  ← 应为 1`);

db.close(); rmSync(dir, {recursive:true, force:true});
console.log('\n✅ AI 层验证通过');
