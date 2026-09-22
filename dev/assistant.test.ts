/**
 * 新闻助手, offline.  npm run test:assistant
 *
 * A scripted model and fake search/download stand in for the network, so this
 * checks the whole turn: material from the library and online, bound citations,
 * follow-ups, duplicate clicks, cancellation, crash recovery and deletion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, writeBody } from '../packages/store/src/index.ts';
import { askAssistant, getChat, listChats, deleteChat, recoverAssistant, type AssistantDeps } from '../packages/generate/src/index.ts';
import type { Provider, GenerateOptions, GenerateResult, StreamEvent } from '../packages/ai/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'pnr-assistant-'));
const db = openDb(join(dir, 'newsroom.db')); const now = Date.now();
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','Wire','https://wire.test/rss',0.9,1,'user',?)`).run(now);
for (const [id, title, body] of [
  ['i1', 'City approves a new transit line', 'The city council approved the transit line on Tuesday. The budget is 2 billion dollars.'],
  ['i2', 'Transit line vote details', 'The vote passed 8 to 3 after a public hearing. Construction starts next year.']
] as const) {
  const path = writeBody(dir, { itemId: id, url: `https://wire.test/${id}`, html: `<p>${body}</p>`, text: body,
    words: body.split(' ').length, lang: 'en', source: 'page', engine: 'test', extractedAt: now });
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,body_state,body_path,body_words) VALUES (?,?,?,?,?,?,?,?, 'ok',?,?)`)
    .run(id, id, 's', `https://wire.test/${id}`, title, now, now, body, path, body.split(' ').length);
}

let answers = 0; let searches = 0; const prompts: string[] = [];
const provider = (search: boolean): Provider => ({
  id: 'gemini', name: 'fake', fastModel: 'fast', writeModel: 'write', embeddingDims: 0, vectorProfile: undefined, pricing: undefined,
  capabilities: { embedding: false, search, stream: true, structured: 'schema' },
  limits: { fast: { maxInputTokens: 8000, maxOutputTokens: 1000 }, write: { maxInputTokens: 16000, maxOutputTokens: 2000 } },
  async isAvailable() { return true; }, async check() { return { ok: true }; }, async embed() { return []; },
  async search() { searches++; return { provider: 'gemini', model: 'write', text: 'found', executed: true, sources: [{ url: 'https://web.test/a', title: 'Web A' }] }; },
  async generate<T>(_prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
    const data = (opts.operation === 'assistant_plan' ? { keywords: ['transit'], searchQuery: 'city transit line' } : { itemIds: ['i1', 'i2'] }) as T;
    return { data, provider: 'gemini', model: opts.model ?? 'fast', usedSearch: false };
  },
  async *stream<T>(prompt: string, opts: GenerateOptions): AsyncIterable<StreamEvent<T>> {
    prompts.push(prompt);
    if (prompt.includes('QUESTION: Cancel this answer')) {
      await new Promise<void>((_resolve, reject) => {
        if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    answers++;
    const data = { units: [
      { kind: 'paragraph', text: 'The council approved the line.', sourceRefIds: ['s1'], supported: true },
      { kind: 'paragraph', text: 'A claim with a made-up source.', sourceRefIds: ['s99'], supported: true },
      { kind: 'listItem', text: 'Some background.', sourceRefIds: [], supported: false }
    ] } as T;
    yield { type: 'partial', value: { units: [] } as Partial<T>, sequence: 1 };
    yield { type: 'final', result: { data, provider: 'gemini', model: 'write', usedSearch: false }, sequence: 2 };
  }
});
const deps: AssistantDeps = {
  news: async () => [{ title: 'Transit line approved', url: 'https://news.test/n1', publisher: 'News Co', publishedAt: now, snippet: 'Approved on Tuesday.' }],
  download: (async (url: string) => ({ url, body: Buffer.from('<p>page</p>'), contentType: 'text/html' })) as never,
  extract: (async () => ({ title: 'Web A', text: 'The transit line will run 12 kilometres. '.repeat(10) })) as never
};

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };
const events: any[] = [];

console.log('=== 新闻助手 ===');
const offline = await askAssistant(db, provider(true), dir, { question: 'What did the city decide about transit?', web: false, lang: 'en', requestId: 'r1' }, (e) => events.push(e), undefined, deps);
check(offline.sources.length === 2 && offline.sources.every((s) => s.kind === 'library'), '不联网时只用本地订阅的完整材料');
check(searches === 0 && prompts[0]!.includes('The budget is 2 billion dollars.'), '材料是正文原文，没有调用搜索');
const units = offline.messages.findLast((m) => m.answer)?.answer?.units ?? [];
check(units[0]?.supported === true && units[0].sourceRefIds[0] === 's1', '事实句绑定已登记的来源编号');
check(units[1]?.supported === false && units[1].sourceRefIds.length === 0, '编造的来源编号被去掉，并标为无来源');
check(events.some((e) => e.type === 'phase' && e.phase === 'library') && events.some((e) => e.type === 'complete'), '进度与完成事件');

const online = await askAssistant(db, provider(true), dir, { chatId: offline.id, question: 'How long is it?', web: true, lang: 'en', requestId: 'r2' }, (e) => events.push(e), undefined, deps);
check(online.id === offline.id && online.messages.length === 4, '追问留在同一个会话');
check(online.sources.some((s) => s.kind === 'web' && s.url === 'https://web.test/a') && online.sources.some((s) => s.kind === 'news'), '联网时加入网页和新闻搜索结果');
check(online.sources.filter((s) => s.kind === 'library').length === 2, '同一篇文章不重复登记');
check(prompts.at(-1)!.includes('User: What did the city decide about transit?'), '追问带上之前的对话');

await askAssistant(db, provider(true), dir, { chatId: offline.id, question: 'dup', web: false, lang: 'en', requestId: 'r2' }, () => {}, undefined, deps);
check(answers === 2, '重复点击同一请求不会再花一次钱');

const noSearch = await askAssistant(db, provider(false), dir, { question: 'transit news', web: true, lang: 'en', requestId: 'r3' }, () => {}, undefined, deps);
check(noSearch.id !== offline.id && noSearch.sources.some((s) => s.kind === 'news') && !noSearch.sources.some((s) => s.kind === 'web'), '厂商不支持搜索时仍能用新闻搜索');

const controller = new AbortController();
const cancelling = askAssistant(db, provider(false), dir, { chatId: offline.id, question: 'Cancel this answer', web: false, lang: 'en', requestId: 'r4' }, (e) => events.push(e), controller.signal, deps);
setTimeout(() => controller.abort(), 10);
const cancelled = await cancelling;
check(cancelled.messages.at(-1)?.status === 'cancelled' && events.some((e) => e.type === 'cancelled'), '停止生成后记为已取消');
const resumed = await askAssistant(db, provider(false), dir, { chatId: offline.id, question: 'Can I continue?', web: false, lang: 'en', requestId: 'r5' }, () => {}, undefined, deps);
check(resumed.messages.at(-1)?.status === 'complete', '取消后可以继续提问');

db.prepare("UPDATE assistant_messages SET status='pending' WHERE id=?").run(resumed.messages.at(-1)!.id);
recoverAssistant(db);
check(getChat(db, offline.id)!.messages.every((m) => m.status !== 'pending'), '异常退出留下的进行中回答会被恢复');

check(listChats(db).length === 2, '会话列表');
deleteChat(db, noSearch.id);
check(listChats(db).length === 1 && !getChat(db, noSearch.id), '删除会话');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
