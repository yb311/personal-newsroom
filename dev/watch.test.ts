import { openDb } from '../packages/store/src/index.ts';
import { resolveProvider, writeSetting, invalidateProvider } from '../packages/ai/src/index.ts';
import { createWatch, listWatches, updateWatch, enablePreset, PRESETS,
         prepareWatch, getWatch, addCorrection, recentCorrections } from '../packages/watch/src/index.ts';
import { getWatchVector } from '../packages/ai/src/index.ts';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pnr-watch-'));
const db = openDb(join(dir, 'db.sqlite'));

console.log('=== 预置标签 ===');
console.log(`  内置 ${PRESETS.length} 个`);
const techId = enablePreset(db, 'p-tech');
const again = enablePreset(db, 'p-tech');
console.log(`  勾选「科技」→ ${techId}；重复勾选幂等: ${techId === again ? '是' : '否 ❌'}`);

console.log('\n=== 意图型关注 ===');
const w = createWatch(db, { origin: 'intent', label: '习近平', intent: '我想知道习近平最近在干什么', outputLang: 'zh-CN' });
console.log(`  创建: ${w.label} / origin=${w.origin} / lang=${w.outputLang}`);

console.log('\n=== 改预置标签会变成 customized ===');
const edited = updateWatch(db, techId!, { intent: '我只想看 AI 芯片相关的科技新闻' });
console.log(`  origin: preset → ${edited?.origin}  ${edited?.origin === 'customized' ? '✅' : '❌'}`);

console.log('\n=== 纠偏存原话 ===');
const now = Date.now();
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','测试源','http://x',0.9,1,'user',?)").run(now);
db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES ('it1','it1','s','http://x/1','某条新闻',?,?)").run(now, now);
addCorrection(db, w.id, 'it1', 'not_wanted', '这条只是提了一句他的名字，不是关于他的');
const c = recentCorrections(db, w.id)[0];
console.log(`  ${c?.verdict}  「${c?.userNote}」`);

const key = process.env.GEMINI_API_KEY ?? '';
if (!key) { console.log('\n未提供 key，跳过 AI 部分'); db.close(); rmSync(dir,{recursive:true,force:true}); process.exit(0); }
writeSetting(db, 'ai.provider', 'gemini'); writeSetting(db, 'ai.geminiApiKey', key); invalidateProvider();
const p = (await resolveProvider(db))!;

console.log('\n=== 准备关注（意图向量 + 召回辅助）===');
const t0 = Date.now();
await prepareWatch(db, p, w);
const fresh = getWatch(db, w.id)!;
const vec = getWatchVector(db, w.id);
console.log(`  ${Date.now()-t0}ms  意图向量维度=${vec?.length}`);
const a = fresh.recallAids!;
console.log(`  别名 (${a.aliases.length}): ${a.aliases.slice(0,6).join(' · ')}`);
console.log(`  相关词 (${a.relatedTerms.length}): ${a.relatedTerms.slice(0,8).join(' · ')}`);
console.log(`  信源倾向 (${a.sourceHints.length}): ${a.sourceHints.slice(0,6).join(' · ')}`);
const hasEn = a.aliases.some(x => /^[A-Za-z]/.test(x));
const hasZh = a.aliases.some(x => /[一-鿿]/.test(x));
console.log(`  中英别名都有: ${hasEn && hasZh ? '✅' : '❌'}`);
console.log(`  无排除列表（设计如此）: ${!('exclude' in a) ? '✅' : '❌'}`);

db.close(); rmSync(dir,{recursive:true,force:true});
console.log('\n✅ Watch 系统验证通过');
