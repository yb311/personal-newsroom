/** 按关注挑源, offline.  npm run test:source-suggest */
import { openDb } from '../packages/store/src/index.ts';
import type { Provider, GenerateOptions, GenerateResult } from '../packages/ai/src/index.ts';
import { createWatch, deleteWatch, suggestSources, addWatchSources, listWatchSources } from '../packages/watch/src/index.ts';
import { sourcesToFetch } from '../packages/feed/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };
const dir = mkdtempSync(join(tmpdir(), 'pnr-suggest-'));
const db = openDb(join(dir, 'db.sqlite'));
const api = createApi(db, dir);

const src = db.prepare(`INSERT INTO sources (id,kind,name,domain,url,category,country,trust,enabled,added_by,created_at,scores_json)
                        VALUES (?,'rss',?,?,?,?,?,0.8,?,'catalog',0,?)`);
src.run('asahi', '朝日新聞', 'asahi.com', 'http://a', 'news', 'Japan', 0, JSON.stringify({ asia: 9, world: 5 }));
src.run('japantoday', 'Japan Today', 'japantoday.com', 'http://b', 'news', 'Japan', 0, JSON.stringify({ asia: 7 }));
src.run('bbc', 'BBC', 'bbc.com', 'http://c', 'world', null, 1, JSON.stringify({ world: 9, asia: 7 }));
src.run('chess', 'Chess News', 'chess.com', 'http://d', 'chess', null, 0, JSON.stringify({ sports: 5 }));
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('mine','rss','我的','http://e',0.9,0,'user',0)`).run();

let prompt = '';
const stub = {
  id: 'gemini', name: 'stub', fastModel: 'fast', writeModel: 'write', embeddingDims: 768,
  capabilities: { embedding: false, search: false, stream: false, structured: 'schema' },
  async generate<T>(p: string, _o: GenerateOptions): Promise<GenerateResult<T>> {
    prompt = p;
    // The model lists the weaker source first, repeats one and invents another.
    return { data: { fields: ['asia', 'not-a-field'], sources: [
      { id: 'japantoday', reason: '日本本地英文新闻' }, { id: 'asahi', reason: '日本大报' },
      { id: 'asahi', reason: '重复' }, { id: 'nhk-invented', reason: '编的' }, { id: 'bbc', reason: '已订阅' }
    ] } as T, model: 'fast', usage: { input: 1, output: 1 } } as GenerateResult<T>;
  }
} as unknown as Provider;

console.log('=== 挑源 ===');
const w = createWatch(db, { origin: 'intent', label: '日本政治', intent: '我想跟进日本政局，尤其是首相和国会' });
const picks = await suggestSources(db, stub, w, { lang: 'zh-CN' });
check(prompt.includes(w.intent), 'prompt 里放的是关注原话');
check(prompt.includes('asahi | 朝日新聞') && prompt.includes('asia:9'), 'prompt 里有目录和评分');
check(!prompt.includes('bbc |') && !prompt.includes('mine |'), '已订阅的源和用户自己加的源不在候选里');
check(picks.map((p) => p.sourceId).join() === 'asahi,japantoday', `编造的、重复的、已订阅的都丢掉，按相关领域评分排序（${picks.map((p) => p.sourceId).join()}）`);
check(picks[0]!.field === 'asia' && picks[0]!.score === 9 && picks[0]!.reason === '日本大报', '带上评分所在领域和理由');

console.log('\n=== 仅用于关注 / 订阅 ===');
addWatchSources(db, w.id, ['asahi'], 'back');
addWatchSources(db, w.id, ['japantoday'], 'front');
const fetched = new Set(sourcesToFetch(db).map((s) => s.id));
check(fetched.has('asahi') && fetched.has('japantoday') && fetched.has('bbc') && !fetched.has('chess'), '仅用于关注的源也会被抓取');
const reading = new Set((api.listSources() as { id: string }[]).map((s) => s.id));
check(!reading.has('asahi') && reading.has('japantoday'), '仅用于关注的源不出现在阅读，订阅的出现');
const cat = api.catalogue({ q: 'asahi' }).rows.find((r) => r.id === 'asahi');
check(Boolean(cat?.background), '来源目录里标出「仅用于关注」');
check(listWatchSources(db, w.id).map((s) => `${s.sourceId}:${s.placement}`).join() === 'japantoday:front,asahi:back', '关注的设置页能列出它的来源');
const again = await suggestSources(db, stub, w);
check(!prompt.includes('asahi |') && !again.some((p) => p.sourceId === 'asahi'), '已经挑过的源不再推荐');

api.moveWatchSource(w.id, 'asahi', 'front');
check((db.prepare("SELECT enabled FROM sources WHERE id='asahi'").get() as { enabled: number }).enabled === 1, '在设置页点「订阅」会加进阅读');
api.moveWatchSource(w.id, 'asahi', 'back');

console.log('\n=== 删除关注 ===');
deleteWatch(db, w.id);
const after = new Set(sourcesToFetch(db).map((s) => s.id));
check(!after.has('asahi') && after.has('japantoday'), '删除关注后，仅用于关注的源停止抓取，订阅的保留');

console.log('\n=== 没有 AI ===');
const w2 = createWatch(db, { origin: 'intent', label: 'x', intent: 'x' });
check((await api.suggestSources([w2.id], 'zh-CN')).length === 0, '没配 AI 时返回空，界面不弹窗');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
