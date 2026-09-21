/**
 * The logic behind 今日 and 快讯, offline and deterministic: a scripted model
 * stands in for Gemini and records every prompt, and the network stages are
 * switched off. Each check is one of the defects found in the review.
 *
 *   npm run test:today
 */
process.env['PNR_DISABLE_FETCH'] = '1';
process.env['PNR_DISABLE_EXTRACT'] = '1';
process.env['PNR_DISABLE_SEARCH'] = '1';

import { openDb } from '../packages/store/src/index.ts';
import { localDateKey } from '../packages/core/src/index.ts';
import type { Provider, GenerateOptions, GenerateResult } from '../packages/ai/src/index.ts';
import { createWatch, getWatch } from '../packages/watch/src/index.ts';
import { runDaily, runFlashCheck, generateProgress, getDigest, newSinceYesterday, recentFlashes, openQuestions } from '../packages/generate/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

// ── a scripted model ───────────────────────────────────────────────────────
type Call = { kind: string; prompt: string };
const calls: Call[] = [];
let progressScript: (prompt: string) => unknown = () => ({ milestones: [] });
const idsIn = (prompt: string): string[] => [...prompt.matchAll(/^(i\d+) \|/gm)].map((m) => m[1]!);

const stub: Provider = {
  id: 'gemini', name: 'stub', fastModel: 'fast', writeModel: 'write', embeddingDims: 768,
  capabilities: { embedding: true, search: false, stream: true, structured: 'schema' },
  limits: { fast: { maxInputTokens: 100_000, maxOutputTokens: 8_000 }, write: { maxInputTokens: 100_000, maxOutputTokens: 8_000 } },
  vectorProfile: { provider: 'gemini', endpoint: 'stub', model: 'stub-embed', dimensions: 768, taskConfig: 'stub', inputVersion: 1 },
  pricing: undefined,
  async isAvailable() { return true; },
  async check() { return { ok: true }; },
  async embed(texts) {
    // Items about AI or the EU point the same way as the watches; others do not.
    return texts.map((t) => {
      const v = new Float32Array(768);
      v[/人工智能|欧盟|AI/.test(t) ? 0 : 1] = 1;
      return v;
    });
  },
  async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
    const keys = Object.keys((opts.schema as { properties: object }).properties);
    const kind = keys.includes('results') ? 'judge' : keys.includes('milestones') ? 'progress'
      : keys.includes('sections') ? 'digest' : keys.includes('flashes') ? 'flash' : 'aids';
    calls.push({ kind, prompt });
    let data: unknown;
    if (kind === 'aids') data = { aliases: [], relatedTerms: [], sourceHints: [] };
    if (kind === 'judge') {
      data = { results: [...prompt.matchAll(/^(i\d+) \| [^|]*\| (.*)$/gm)].map((m) =>
        ({ id: m[1], score: /苹果/.test(m[2]!) ? 2 : 9, reason: 'stub' })) };
    }
    if (kind === 'progress') data = progressScript(prompt);
    if (kind === 'digest') {
      const sections = [...prompt.matchAll(/^## watchId=(\S+)/gm)].map((m) => {
        const block = prompt.slice(prompt.indexOf(m[0]));
        return { watchId: m[1], heading: 'h', paragraphs: [{ text: `摘要 ${m[1]}`, itemIds: idsIn(block).slice(0, 1) }] };
      });
      data = { title: '今日', sections };
    }
    if (kind === 'flash') {
      const ids = idsIn(prompt);
      const watchIds = [...prompt.matchAll(/^(w-\S+) \|/gm)].map((m) => m[1]);
      data = { flashes: ids.includes('i1')
        ? [{ itemId: 'i1', alsoItemIds: ['i2'], watchIds, kind: 'new', importance: 8, title: '欧盟通过人工智能法案修订', body: '据材料。' }]
        : [] };
    }
    return { data: data as T, provider: 'gemini', model: 'stub', usedSearch: false };
  },
  async *stream() { throw new Error('unused'); },
  async search() { throw new Error('unused'); }
};

// ── fixture ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pnr-today-'));
const db = openDb(join(dir, 'db.sqlite'));
const now = Date.now();
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','源','http://x',0.9,0,'user',?)").run(now);
const addItem = (id: string, title: string, hoursAgo: number): void => {
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,snippet,published_at,discovered_at)
              VALUES (?,?,'s',?,?,?,?,?)`).run(id, id, `https://x/${id}`, title, `${title}。`, now - hoursAgo * 3600_000, now);
};
addItem('i1', '欧盟通过人工智能法案修订', 2);
addItem('i2', '欧盟人工智能法案修订获批', 3);
addItem('i3', '苹果发布新手机', 5);
addItem('i4', '人工智能旧闻：上周的 AI 峰会', 24 * 8);
const wA = createWatch(db, { origin: 'intent', label: 'AI 监管', intent: '我想跟进人工智能监管', keywords: ['人工智能'] });
const wB = createWatch(db, { origin: 'intent', label: '欧盟', intent: '我想了解欧盟政策' });
const opts = { dataDir: dir, lang: 'zh-CN' };

// ── 1. daily run ───────────────────────────────────────────────────────────
console.log('=== 今日：第一次运行 ===');
progressScript = (p) => ({
  milestones: idsIn(p).includes('i1') ? [{ occurredOn: localDateKey(now), summary: '欧盟通过修订', itemIds: ['i1'], isNew: true }] : [],
  openQuestions: /^Q\d+:/m.test(p) ? [] : ['欧盟何时正式实施修订？']
});
const r1 = await runDaily(db, stub, opts);
check(r1.digest === true && r1.mode === 'ai', `运行完成（${JSON.stringify(r1)}）`);
const digest = getDigest(db, localDateKey());
check(digest !== null, `摘要按本地日期 ${localDateKey()} 保存，能被「今日」读到`);
const api = createApi(db, dir);
check((api.today() as { digest: unknown }).digest !== null, 'ipc.today() 读到当天摘要');
const firstProgress = calls.findIndex((c) => c.kind === 'progress');
const firstDigest = calls.findIndex((c) => c.kind === 'digest');
check(firstProgress >= 0 && firstProgress < firstDigest, '先判断进展，后写摘要');
const writing = calls.filter((c) => c.kind === 'progress' || c.kind === 'digest');
check(writing.every((c) => !idsIn(c.prompt).includes('i4')), '8 天前的高分旧闻不进摘要/进展材料');
check(!calls.some((c) => c.kind === 'judge' && idsIn(c.prompt).includes('i4')), '旧闻不在召回窗口内');
check(openQuestions(db, wA.id).some((q) => q.question.includes('正式实施')), '悬念被保存');

// ── 2. second daily run: new development, questions, no re-judging ─────────
console.log('\n=== 今日：第二次运行 ===');
addItem('i5', '欧盟人工智能法案修订明年生效', 1);
calls.length = 0;
progressScript = (p) => ({
  milestones: [{ occurredOn: localDateKey(now), summary: '修订明年生效', itemIds: ['i5'], isNew: true,
                 answersQuestionIds: [...p.matchAll(/^(Q\d+):/gm)].map((m) => m[1]) }],
  openQuestions: []
});
await runDaily(db, stub, opts);
const judged = calls.filter((c) => c.kind === 'judge').flatMap((c) => idsIn(c.prompt));
check(judged.length > 0 && judged.every((id) => id === 'i5'), `只判定新文章（这次判定：${[...new Set(judged)].join(',') || '无'}）`);
const p2 = calls.find((c) => c.kind === 'progress' && c.prompt.includes('我想跟进人工智能监管'))!;
check(/^Q\d+: 欧盟何时正式实施修订？/m.test(p2.prompt), '上次的悬念进入这次的进展判断');
check(openQuestions(db, wA.id).length === 0, '回答了的悬念被标为已解决');
const fresh = newSinceYesterday(db, wA.id).map((m) => m.summary);
check(fresh.includes('修订明年生效'), `同一天的第二个新进展没有被丢掉（昨天到今天：${fresh.join('、')}）`);

// ── 3. told records written after the run started are ignored ─────────────
console.log('\n=== 进展：本次运行写入的「已告诉」不算 ===');
const before = Date.now();
db.prepare("INSERT INTO told_records (watch_id, narrative, surface, told_at) VALUES (?, '本次运行刚写的摘要', 'digest', ?)").run(wA.id, before + 1000);
calls.length = 0;
await generateProgress(db, stub, getWatch(db, wA.id)!, 'zh-CN', { toldBefore: before });
check(!calls[0]!.prompt.includes('本次运行刚写的摘要'), '同一次运行里的摘要不会让新进展变成「已告诉」');

// ── 4. flashes: one call, one flash per event, shared across watches ───────
console.log('\n=== 快讯 ===');
calls.length = 0;
const f1 = await runFlashCheck(db, stub, opts);
check(calls.filter((c) => c.kind === 'flash').length === 1, '所有关注只调用一次写作');
const rows = recentFlashes(db, 24);
check(rows.length === 1 && rows[0]!.watchIds.length === 2, `同一事件只出一条快讯，挂在两个关注下（${rows.length} 条）`);
check(rows[0]!.itemIds.join(',') === 'i1,i2', '合并的材料都记在这条快讯上');
check(rows[0]!.basis === 'snippet', '没抓到正文时标「仅依据摘要」，不再谎称搜索补全');
check(rows[0]!.itemPublishedAt === now - 2 * 3600_000, '记录新闻本身的发布时间');
calls.length = 0;
await runFlashCheck(db, stub, opts);
const again = calls.find((c) => c.kind === 'flash');
check(!again || !/^i[12] \|/m.test(again.prompt), '已发过的事件不会再次成为候选');
check(f1.flashes === 1, `运行结果：${JSON.stringify(f1)}`);

// ── 5. keyword mode without AI ─────────────────────────────────────────────
console.log('\n=== 没有 AI：关键词匹配 ===');
const wC = createWatch(db, { origin: 'intent', label: '手机', intent: '手机新品', keywords: ['手机'] });
const r5 = await runDaily(db, null, opts);
const hits = db.prepare("SELECT item_id FROM matches WHERE watch_id = ? AND passed_gate = 1 AND recalled_by = 'keyword'").all(wC.id);
check(r5.mode === 'keywords' && hits.length === 1, `按关键词命中 ${hits.length} 篇`);
await runDaily(db, stub, opts);
const passedUnjudged = db.prepare('SELECT COUNT(*) c FROM matches WHERE watch_id = ? AND passed_gate = 1 AND judged_at IS NULL').get(wC.id) as { c: number };
check(passedUnjudged.c === 0, '接上 AI 后，只凭关键词通过的会先交给 AI 判断');

// ── 6. deleting a watch ────────────────────────────────────────────────────
api.removeWatch(wB.id);
const left = recentFlashes(db, 24);
check(left.length === 1 && left[0]!.watchIds.join() === wA.id, '删除关注后，共享的快讯只剩在另一个关注下');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
