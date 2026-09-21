/** 关注 logic, offline.  npm run test:watches */
import { openDb } from '../packages/store/src/index.ts';
import { upsertWatchVector, getWatchVector } from '../packages/ai/src/index.ts';
import { getWatch, recentCorrections } from '../packages/watch/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };
const dir = mkdtempSync(join(tmpdir(), 'pnr-watches-'));
const db = openDb(join(dir, 'db.sqlite'));
const api = createApi(db, dir);
const now = Date.now();
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','源','http://x',0.9,1,'user',?)").run(now);
db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES ('i1','i1','s','https://x/1','t',?,?)").run(now, now);

console.log('=== 主题库 ===');
const presets = api.presets();
check(presets.length >= 35 && new Set(presets.map((p) => p.group)).size === 5, `主题库 ${presets.length} 个主题、5 个分组`);
const ids = api.addPresets(['p-ai', 'p-ukraine', 'p-ai']);
check(ids.length === 3 && new Set(ids).size === 2, '多选一次添加，重复的不会加两遍');
check(getWatch(db, 'p-ai')!.keywords.includes('人工智能'), '预置主题自带关键词');
check(api.presets().find((p) => p.id === 'p-ai')!.enabled, '已添加的主题在主题库里标为已添加');

console.log('\n=== 纠偏 ===');
db.prepare("INSERT INTO matches (watch_id,item_id,recalled_by,intent_score,passed_gate,judged_at,created_at) VALUES ('p-ai','i1','r1_vector',7,1,?,?)").run(now, now);
api.correct('p-ai', 'i1', 'not_wanted', '只是顺带提到');
check((api.watchItems('p-ai') as unknown[]).length === 0, '点「不要」后这篇立刻从关注里消失');
check(recentCorrections(db, 'p-ai')[0]?.userNote === '只是顺带提到', '理由按原话保存，下次判断时交给 AI');
api.correct('p-ai', 'i1', 'wanted');
const back = api.watchItems('p-ai') as { verdict: string }[];
check(back.length === 1 && back[0]!.verdict === 'wanted', '改成「要」后回来了，并标着你的选择');

console.log('\n=== 改原话 ===');
upsertWatchVector(db, 'p-ai', new Float32Array(768).fill(0.1));
db.prepare("UPDATE watches SET recall_aids_json = '{}' WHERE id = 'p-ai'").run();
api.editWatch('p-ai', { label: '人工智能', intent: '我只想看人工智能芯片的出口管制' });
const w = getWatch(db, 'p-ai')!;
check(w.origin === 'customized' && w.intent.startsWith('我只想看'), '改了原话，变成自己的关注');
check(getWatchVector(db, 'p-ai') === null && w.recallAids === null, '旧的意图向量和辅助词被清掉，下次按新话重建');
const m = db.prepare("SELECT judged_at, passed_gate FROM matches WHERE watch_id='p-ai'").get() as { judged_at: number | null; passed_gate: number };
check(m.judged_at === null && m.passed_gate === 0, '按旧原话做的判断作废，下次重新判断');
api.editWatch('p-ai', { keywords: ['芯片', 'export controls'], sensitivity: 'less', outputLang: 'en-US', active: false });
const w2 = getWatch(db, 'p-ai')!;
check(w2.keywords.join() === '芯片,export controls' && w2.sensitivity === 'less' && w2.outputLang === 'en-US' && !w2.active,
      '关键词、松紧、输出语言、暂停都能单独保存');

console.log('\n=== 首次运行询问 ===');
check(api.backgroundPrompt() === true, '第一次会问是否开启后台更新');
api.dismissBackgroundPrompt();
check(api.backgroundPrompt() === false, '回答过就不再问');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
