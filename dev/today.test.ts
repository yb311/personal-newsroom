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
import { generateDigest } from '../packages/generate/src/digest.ts';
import { gateWatch, matchKeywords } from '../packages/recall/src/index.ts';
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
// Milestones are dated from the article they cite, not from "now": just after
// midnight an article from two hours ago is yesterday's, and a later date is rejected.
progressScript = (p) => ({
  milestones: idsIn(p).includes('i1') ? [{ occurredOn: localDateKey(now - 2 * 3600_000), summary: '欧盟通过修订', itemIds: ['i1'], isNew: true }] : [],
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
  milestones: [{ occurredOn: localDateKey(now - 3600_000), summary: '修订明年生效', itemIds: ['i5'], isNew: true,
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
const d2 = calls.find((c) => c.kind === 'digest');
check(Boolean(d2 && /^NEW（/m.test(d2.prompt) && d2.prompt.includes('修订明年生效')), '摘要围绕进展判断出的新进展来写（「昨天到今天」写进摘要）');
const heads = (getDigest(db, localDateKey())?.blocks ?? []).filter((b) => b.type === 'heading');
check(heads.length > 0 && heads.every((b) => 'watchId' in b && (b.watchId === wA.id || b.watchId === wB.id)), '摘要每一节都记下所属关注，可以跳到它的进展');
const t2 = api.today() as { watches: { id: string; newCount: number }[]; changes?: unknown };
check(t2.changes === undefined && t2.watches.some((w) => w.id === wA.id && w.newCount > 0), '今日不再单列「昨天到今天」，新进展数随关注返回');

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

// ── 7. review regressions: rejected evidence, event identity, told text ─────
console.log('\n=== 审阅回归：纠偏、进展去重与已展示记录 ===');
{
  const reviewDb = openDb(':memory:');
  try {
    const reviewApi = createApi(reviewDb, dir);
    reviewDb.prepare("INSERT INTO sources (id,kind,name,url,trust,created_at) VALUES ('s','rss','Source','https://example.com',0.9,?)").run(now);
    const watch = createWatch(reviewDb, { origin: 'intent', label: 'review', intent: 'policy', keywords: ['policy'] });
    for (const [id, age] of [['rejected', 1], ['allowed', 1], ['old', 100], ['keyword', 1]] as const) {
      reviewDb.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,snippet,published_at,discovered_at)
        VALUES (?,?,'s',?,'policy','policy',?,?)`).run(id, id, `https://example.com/${id}`, now - age * 3600_000, now);
      reviewDb.prepare(`INSERT INTO matches (watch_id,item_id,recalled_by,intent_score,passed_gate,judged_at,created_at)
        VALUES (?,?,'test',9,1,?,?)`).run(watch.id, id, id === 'keyword' ? null : now, now);
    }
    const addMilestone = (id: string, summary: string, itemIds: string[]): void => {
      reviewDb.prepare(`INSERT INTO milestones (id,watch_id,occurred_on,first_seen_at,summary,is_new,created_at)
        VALUES (?,?,?,?,?,1,?)`).run(id, watch.id, localDateKey(now - 100 * 3600_000), now, summary, now);
      for (const itemId of itemIds) reviewDb.prepare('INSERT INTO milestone_sources (milestone_id,item_id) VALUES (?,?)').run(id, itemId);
    };
    addMilestone('rejected-ms', 'REJECTED_EVENT', ['rejected']);
    addMilestone('mixed-ms', 'MIXED_EVENT', ['allowed', 'rejected']);
    addMilestone('old-ms', 'OLD_VALID_EVENT', ['old']);
    reviewApi.correct(watch.id, 'rejected', 'not_wanted');
    reviewApi.correct(watch.id, 'keyword', 'not_wanted');
    gateWatch(reviewDb, watch);
    matchKeywords(reviewDb, watch);
    const passed = (id: string): number => (reviewDb.prepare('SELECT passed_gate AS p FROM matches WHERE watch_id=? AND item_id=?').get(watch.id, id) as { p: number }).p;
    check(passed('rejected') === 0 && passed('keyword') === 0, 'AI 重新过闸和关键词重跑都不能覆盖「不要」');
    reviewApi.correct(watch.id, 'keyword', 'wanted');
    gateWatch(reviewDb, watch);
    check(passed('keyword') === 1, '最新反馈优先：改成「要」后，尚未 AI 判定的文章也保留');

    let digestPrompt = '';
    const sections = [
      { watchId: watch.id, heading: 'kept', paragraphs: [
        { text: 'VISIBLE', itemIds: ['allowed'] }, { text: 'INVALID_UNSHOWN', itemIds: ['invented'] }
      ] },
      { watchId: watch.id, heading: 'EMPTY_SECTION', paragraphs: [{ text: 'EMPTY_UNSHOWN', itemIds: [] }] },
      { watchId: watch.id, heading: '', paragraphs: [{ text: 'NO_HEADING_UNSHOWN', itemIds: ['allowed'] }] }
    ];
    const digestProvider: Provider = { ...stub, async generate<T>(prompt: string): Promise<GenerateResult<T>> {
      digestPrompt = prompt;
      return { data: { title: 'review', sections } as T, provider: 'gemini', model: 'stub', usedSearch: false };
    } };
    const result = await generateDigest(reviewDb, digestProvider, [watch], 'en');
    check(!digestPrompt.includes('REJECTED_EVENT') && !digestPrompt.includes('MIXED_EVENT') && !/^rejected \|/m.test(digestPrompt),
      '否定过的材料和依赖它的旧进展不会通过 NEW 重新进入摘要');
    check(digestPrompt.includes('OLD_VALID_EVENT') && /^old \|/m.test(digestPrompt), '窗口外仍通过判定的进展材料正常补回');
    check(result?.blocks.length === 2 && result.blocks[1]?.type === 'paragraph' && result.blocks[1].text === 'VISIBLE',
      '无效引用、空标题和没有有效段落的小节均不展示');
    const narratives = (): string[] => (reviewDb.prepare("SELECT narrative FROM told_records WHERE surface='digest'").all() as { narrative: string }[]).map((r) => r.narrative);
    check(narratives().join() === 'VISIBLE', '已告诉记录只包含真正展示的段落');
    sections[0]!.paragraphs = [{ text: 'REWRITTEN', itemIds: ['allowed'] }];
    await generateDigest(reviewDb, digestProvider, [watch], 'en');
    check(narratives().length === 1 && narratives()[0] === 'REWRITTEN', '同日重写替换记录，不残留旧段落');

    // A separate watch exercises baseline behaviour before it has any timeline.
    const events = createWatch(reviewDb, { origin: 'intent', label: 'events', intent: 'policy' });
    reviewDb.prepare(`INSERT INTO matches (watch_id,item_id,recalled_by,intent_score,passed_gate,judged_at,created_at)
      VALUES (?,'allowed','test',9,1,?,?)`).run(events.id, now, now);
    const eventDay = localDateKey(now - 3600_000);
    let script: Record<string, unknown>[] = [
      { occurredOn: eventDay, summary: 'Decision A', itemIds: ['allowed'], isNew: true, existingMilestoneId: '' },
      { occurredOn: eventDay, summary: 'Decision B', itemIds: ['allowed'], isNew: true, existingMilestoneId: '' }
    ];
    let eventPrompt = '';
    const eventProvider: Provider = { ...stub, async generate<T>(prompt: string): Promise<GenerateResult<T>> {
      eventPrompt = prompt;
      return { data: { milestones: script } as T, provider: 'gemini', model: 'stub', usedSearch: false };
    } };
    const first = await generateProgress(reviewDb, eventProvider, events, 'en');
    check(first.length === 2 && first.every((m) => !m.isNew), '同日同一报道的两个不同事件都保留，首次建仓仍不标新');
    const q = reviewDb.prepare("INSERT INTO open_questions (watch_id,question,asked_at) VALUES (?,'Resolved?',?)").run(events.id, now);
    script = [{ occurredOn: eventDay, summary: 'Decision A rephrased', itemIds: ['allowed'], isNew: false,
      existingMilestoneId: first[0]!.id, answersQuestionIds: [`Q${q.lastInsertRowid}`] }];
    const repeated = await generateProgress(reviewDb, eventProvider, events, 'en');
    check(eventPrompt.includes(first[0]!.id) && eventPrompt.includes('Decision A') && repeated.length === 0,
      '换说法的同一事件通过已有节点 id 去重，提示词提供完整叙述');
    const resolved = reviewDb.prepare('SELECT resolved_by AS id FROM open_questions WHERE id=?').get(q.lastInsertRowid) as { id: string };
    check(resolved.id === first[0]!.id, '重复事件回答悬念时指向真实存在的节点');
    script = [
      { occurredOn: eventDay, summary: 'Decision C', itemIds: ['allowed'], isNew: true, existingMilestoneId: 'rejected-ms' },
      { occurredOn: eventDay, summary: 'Decision C', itemIds: ['allowed'], isNew: true, existingMilestoneId: '' }
    ];
    const next = await generateProgress(reviewDb, eventProvider, events, 'en');
    check(next.length === 1 && next[0]?.isNew && next[0]?.summary === 'Decision C',
      '同来源的后续新事件保留，其他关注的 id 无效，同次完全重复仍去重');
    check((await generateProgress(reviewDb, eventProvider, events, 'en')).length === 0, '完全相同的事件跨次重跑仍去重');
  } finally { reviewDb.close(); }
}

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
