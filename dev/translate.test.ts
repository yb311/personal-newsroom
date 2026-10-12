/**
 * 翻译, offline.  npm run test:translate
 *
 * A scripted model stands in for the provider (it "translates" by tagging each
 * text), the database is a scratch one. Checks how article HTML is cut into
 * blocks, that full-text, paragraph and batch translation share one cache and
 * never pay twice, that a changed headline is translated again, that articles
 * already in the target language are skipped, and the news assistant's
 * translation tools — including that a translation reaches the person exactly
 * as the translator returned it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, writeBody } from '../packages/store/src/index.ts';
import { segmentHtml, translateItem, translateItems, translateText, readTranslation, headlineTranslations, setTranslateOption, translateSettings,
  askAssistant, type AssistantDeps, type NavTarget } from '../packages/generate/src/index.ts';
import type { Provider, GenerateOptions, GenerateResult, StreamEvent } from '../packages/ai/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';
import { buildToolbox, type AppActions } from '../apps/desktop/src/agent-tools.ts';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

// ── blocks ───────────────────────────────────────────────────────────────────
console.log('=== 切块 ===');
const html = '<h2>Heading</h2><p>First <a href="https://x.test">link</a> &amp; more.</p><ul><li><p>Nested para</p></li><li>Plain item</li></ul>'
  + '<blockquote><p>Quoted</p></blockquote><pre><code>let x = 1;</code></pre><table><tr><th>Col</th><td>12</td><td>Cell text</td></tr></table>'
  + '<figure><img src="a.png"><figcaption>Caption here</figcaption></figure><p>   </p><div>Loose div text<br>second line</div>';
const seg = segmentHtml(html);
check(seg.blocks.map((b) => b.text).join('|') === 'Heading|First link & more.|Nested para|Plain item|Quoted|Col|Cell text|Caption here|Loose div text second line',
  `叶子块按文档顺序、只取最内层、跳过代码和纯数字（${seg.blocks.map((b) => b.text).join('|')}）`);
check(seg.html.includes('<h2 data-pnr-b="0"><span class="pnr-o">Heading</span></h2>') && seg.html.includes('<li data-pnr-b="2"><p') === false
  && seg.html.includes('<li><p data-pnr-b="2"><span class="pnr-o">Nested para</span></p></li>'), '块打上编号、原文包进 .pnr-o，外层不重复标');
check(seg.html.includes('<a href="https://x.test">link</a>') && seg.html.includes('<pre><code>let x = 1;</code></pre>'), '链接和代码原样保留');
check(segmentHtml(html).html === seg.html, '同样的 HTML 切出同样的编号（主进程和界面对得上）');
const loose = segmentHtml('Just text<br>more');
check(loose.blocks.length === 1 && loose.html.startsWith('<div data-pnr-b="0">'), '没有块元素的正文整体算一块');

// ── a scripted translator ────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pnr-translate-'));
const db = openDb(join(dir, 'newsroom.db')); const now = Date.now();
const calls: { operation: string; texts: string[] }[] = [];
let script: { route: string; calls?: { tool: string; args: unknown }[]; reply?: string }[] = [];
const tag = (s: string): string => `【译】${s}`;
const provider: Provider = {
  id: 'gemini', name: 'fake', fastModel: 'fast', writeModel: 'write', embeddingDims: 0, vectorProfile: undefined, pricing: undefined,
  capabilities: { embedding: false, search: false, stream: true, structured: 'schema' },
  limits: { fast: { maxInputTokens: 8000, maxOutputTokens: 1000 }, write: { maxInputTokens: 16000, maxOutputTokens: 2000 } },
  async isAvailable() { return true; }, async check() { return { ok: true }; }, async embed() { return []; },
  async search() { throw new Error('no search'); },
  async generate<T>(prompt: string, opts: GenerateOptions & { model?: string }): Promise<GenerateResult<T>> {
    const op = opts.operation ?? '';
    if (op === 'assistant_agent') {
      const s = script.shift() ?? { route: 'done', reply: 'ok' };
      return { data: { route: s.route, calls: (s.calls ?? []).map((c) => ({ tool: c.tool, args: JSON.stringify(c.args) })), more: false,
        reply: s.reply ?? '', keywords: [], searchQuery: '' } as T, provider: 'gemini', model: 'fast', usedSearch: false };
    }
    if (op === 'translate_text' && prompt.includes('TEXT:\n')) {
      const text = prompt.split('TEXT:\n')[1]!;
      calls.push({ operation: op, texts: [text] });
      return { data: { to: /[一-鿿]/.test(text) ? 'en' : 'zh-CN', text: tag(text) } as T, provider: 'gemini', model: 'fast', usedSearch: false };
    }
    if (op.startsWith('translate')) {
      const items = JSON.parse(prompt.split('TEXTS:\n')[1]!) as { i: number; text: string }[];
      calls.push({ operation: op, texts: items.map((x) => x.text) });
      // Leaves out anything containing "SKIPME", as a model sometimes drops an item.
      return { data: { items: items.filter((x) => !x.text.includes('SKIPME')).map((x) => ({ i: x.i, text: tag(x.text) })) } as T, provider: 'gemini', model: 'fast', usedSearch: false };
    }
    return { data: {} as T, provider: 'gemini', model: 'fast', usedSearch: false };
  },
  async *stream<T>(): AsyncIterable<StreamEvent<T>> {
    yield { type: 'final', result: { data: { units: [{ kind: 'paragraph', text: 'Answer.', sourceRefIds: [], supported: false }] } as T, provider: 'gemini', model: 'write', usedSearch: false }, sequence: 1 };
  }
};
const sent = (): number => calls.reduce((n, c) => n + c.texts.length, 0);

db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('wire','rss','Wire','https://wire.test/rss',0.9,1,'user',?)`).run(now);
const article = (id: string, title: string, lang: string, body: string | null, snippet = `${title} snippet`): void => {
  const path = body ? writeBody(dir, { itemId: id, url: `https://wire.test/${id}`, html: body, text: body.replace(/<[^>]+>/g, '\n'),
    words: 40, lang, source: 'page', engine: 'test', extractedAt: now }) : null;
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,body_state,body_path,body_words,lang)
    VALUES (?,?,?,?,?,?,?,?,?,?,40,?)`).run(id, id, 'wire', `https://wire.test/${id}`, title, now - Number(id.slice(1)) * 1000, now, snippet, body ? 'ok' : 'failed', path, lang);
};
article('a1', 'Talks resume in Geneva', 'en', '<p>Talks resumed on Monday.</p><p>Both sides met for six hours.</p><p>A third paragraph.</p>');
article('a2', 'Wahl in Berlin', 'de', '<p>Die Wahl war knapp.</p>');
article('a3', '北京今日晴', 'zh', '<p>今天天气晴朗。</p>');
article('a4', 'No body here', 'en', null);
article('a5', 'Partial SKIPME story', 'en', '<p>Good paragraph.</p><p>SKIPME paragraph.</p>');

console.log('\n=== 全文与段落 ===');
const target = 'zh-CN';
const one = await translateItem(db, provider, 'a1', target, { indices: [1], title: false });
check(sent() === 1 && one.blocks[1] === tag('Both sides met for six hours.') && !one.blocks[0] && one.title === null, '段落翻译只送那一段');
const full = await translateItem(db, provider, 'a1', target);
check(sent() === 4 && Object.keys(full.blocks).length === 3 && full.title === tag('Talks resume in Geneva'), '全文翻译不再送已译的段落（标题 + 2 段）');
const again = await translateItem(db, provider, 'a1', target);
check(sent() === 4 && Object.keys(again.blocks).length === 3, '再翻一次不花钱');
check(Object.keys(readTranslation(db, 'a1', target).blocks).length === 3, '读取缓存不调用模型');
check(headlineTranslations(db, ['a1'], target).get('a1')?.full === true, '整篇译完记为全文已译');
check(Object.keys(readTranslation(db, 'a1', 'en-US').blocks).length === 0, '换目标语言是另一份译文');
const partial = await translateItem(db, provider, 'a5', target);
check(Object.keys(partial.blocks).length === 1 && headlineTranslations(db, ['a5'], target).get('a5')?.full !== true, '模型漏掉的段落不拿原文充数、不算全文已译');
db.prepare("UPDATE items SET title = 'Talks resume in Geneva, again' WHERE id = 'a1'").run();
check(readTranslation(db, 'a1', target).title === null, '标题改了，旧译文不再算数');

console.log('\n=== 批量 ===');
calls.length = 0;
const titles = await translateItems(db, provider, dir, ['a1', 'a2', 'a3', 'a4'], target);
check(titles.skipped === 1 && titles.translated === 3 && calls.length === 1 && calls[0]!.operation === 'translate_titles', `标题批量：中文那篇跳过，其余一次调用（${JSON.stringify(titles)}）`);
const list = headlineTranslations(db, ['a1', 'a2', 'a3', 'a4'], target);
check(list.get('a2')?.title === tag('Wahl in Berlin') && list.get('a2')?.snippet === tag('Wahl in Berlin snippet') && !list.has('a3'), '列表读到译文标题和摘要');
calls.length = 0;
const twice = await translateItems(db, provider, dir, ['a1', 'a2', 'a4'], target);
check(calls.length === 0 && twice.translated === 0, '已经译过的标题不再送');
calls.length = 0;
const fulls = await translateItems(db, provider, dir, ['a2', 'a3', 'a4'], target, { full: true });
check(fulls.skipped === 1 && headlineTranslations(db, ['a2'], target).get('a2')?.full === true, `全文批量：外文译全文，中文跳过（${JSON.stringify(fulls)}）`);
const stop = new AbortController(); stop.abort();
const cancelled = await translateItems(db, provider, dir, ['a5'], target, { full: true, signal: stop.signal });
check(cancelled.cancelled === true && cancelled.translated === 0, '停止后不再翻译');

console.log('\n=== 划词 ===');
const picked = await translateText(provider, 'Hello world', target);
check(picked.text === tag('Hello world') && picked.to === 'zh-CN', '外文译成目标语言');
calls.length = 0;
await translateText(provider, 'Hello world', target);
check(calls.length === 0, '同一段文字本次运行不重复翻译');
check((await translateText(provider, '你好', target)).to === 'en', '已经是目标语言的文字译成英文');

console.log('\n=== 界面接口 ===');
const api = createApi(db, dir);
const got = api.getItem('a1')!;
check(got.body!.html.includes('data-pnr-b="2"') && Object.keys(got.translation.blocks).length === 3 && got.translation.total === 3, '打开文章时带上已有译文');
check(api.listItems({ limit: 10 }).find((r) => r.id === 'a2')?.titleTr === tag('Wahl in Berlin'), '文章列表带译文标题');
api.setAiOption('translateTarget', 'en-US');
check(translateSettings(db).target === 'en-US' && api.listItems({ limit: 10 }).every((r) => !r.titleTr), '换了目标语言，列表不显示别的语言的译文');
setTranslateOption(db, 'target', '');
check(translateSettings(db).target === 'zh-CN', '留空跟随撰写语言');

console.log('\n=== 新闻助手 ===');
const navigated: NavTarget[] = []; let batches = 0;
const actions: AppActions = {
  refresh: async () => ({}), runAll: async () => ({}), runFlashes: async () => ({}), runWatch: async () => ({}), rewriteDigest: async () => ({}),
  translateBatch: async (ids, isFull) => { batches++; return { ...await translateItems(db, provider, dir, ids, translateSettings(db).target, { full: isFull }) }; },
  uiLanguage: () => ({ choice: 'system', resolved: 'zh-CN' }), setUiLanguage: () => null,
  scheduleState: () => ({}), setSchedule: async () => ({}), setWake: async () => ({}),
  rssHub: { status: async () => ({}), setInstance: () => {}, install: async () => ({ ok: true }), remove: async () => true, instance: () => '' }
};
// The scratch database has no key, so the api's own provider lookup would say no_ai: use the scripted one.
api.translateText = async (text: string) => ({ ok: true as const, ...await translateText(provider, text, translateSettings(db).target) });
const toolbox = buildToolbox(db, api, actions, { navigate: (t) => navigated.push(t), changed: () => {} });
const deps: AssistantDeps = { news: async () => [], download: (async () => { throw new Error('offline'); }) as never, extract: (async () => ({ title: '', text: '' })) as never };
let n = 0;
const ask = (question: string, mode: 'ask' | 'auto' | 'full', steps: typeof script) => {
  script = steps;
  return askAssistant(db, provider, dir, { chatId: null, question, web: false, lang: 'zh-CN', requestId: `t${++n}`, mode }, () => {}, undefined, deps, toolbox);
};
const textChat = await ask('翻译：The vote passed narrowly.', 'ask', [
  { route: 'tools', calls: [{ tool: 'translate_text', args: { text: 'The vote passed narrowly.' } }] },
  { route: 'done', reply: '译好了。' }
]);
const units = textChat.messages.at(-1)!.answer!.units;
check(units[0]?.kind === 'translation' && units[0].text === tag('The vote passed narrowly.') && units[0].lang === 'zh-CN' && units[1]?.kind === 'note',
  '译文原样交给用户（不经模型转述），后面跟一句说明');
await ask('把第一篇翻译一下', 'ask', [{ route: 'tools', calls: [{ tool: 'translate_article', args: { itemId: 'a2', display: 'translation' } }] }, { route: 'done', reply: '已打开译文。' }]);
check(JSON.stringify(navigated.at(-1)) === JSON.stringify({ kind: 'item', itemId: 'a2', translate: 'translation' }), '翻译文章 = 打开文章并切到译文');
const batchAsk = await ask('把未读的外文标题都翻译了', 'ask', [{ route: 'tools', calls: [{ tool: 'translate_articles', args: { unread: true, full: false } }] }]);
const proposed = batchAsk.messages.at(-1)!.actions[0];
check(proposed?.status === 'proposed' && batches === 0 && proposed.view?.fields.some((f) => f.key === 'articles'), '批量翻译花钱：每次确认模式下先出卡片，显示篇数');
await ask('自动翻译外文文章', 'auto', [{ route: 'tools', calls: [{ tool: 'set_translation', args: { auto: true } }] }, { route: 'done', reply: '已开启。' }]);
check(translateSettings(db).auto === true, '自动改模式下直接改翻译设置');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
