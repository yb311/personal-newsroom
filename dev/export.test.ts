/**
 * 导出, offline.  npm run test:export
 *
 * A scratch database with an article, a daily brief, a flash and a watch.
 * Checks that article HTML becomes faithful Markdown, that a translated
 * article is exported the way the reader shows it, that every citation keeps a
 * numbered source with its real link (the same article keeps one number), that
 * the HTML page runs nothing, that OPML holds only feeds another reader can
 * open, and that a backup never carries an API key — not even in freed pages.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, writeBody, backupDatabase } from '../packages/store/src/index.ts';
import { buildExport, toMarkdown, toHtml, htmlToMarkdown, withTranslation, segmentHtml, hashText, type ExportLabels } from '../packages/generate/src/index.ts';
import { createWatch } from '../packages/watch/src/index.ts';
import { buildOpml } from '../packages/feed/src/index.ts';
import zh from '../apps/renderer/src/locales/zh-CN.json' with { type: 'json' };

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };
const labels: ExportLabels = zh.export.doc;
const opts = { labels, locale: 'zh-CN' };

// ── HTML → Markdown ──────────────────────────────────────────────────────────
console.log('=== 正文转 Markdown ===');
const md = htmlToMarkdown('<h1>Big</h1><h2>Sub</h2><p>One <strong> bold </strong>and <em>it</em> &amp; <a href="https://x.test/a">a link</a>, <a href="javascript:alert(1)">bad</a>.</p>'
  + '<ul><li>First</li><li><p>Second</p><ul><li>Nested</li></ul></li></ul><ol start="3"><li>Three</li></ol>'
  + '<blockquote><p>Quote one</p><p>Quote two</p></blockquote><pre><code>let x = 1;\nlet y = 2;</code></pre>'
  + '<table><tr><th>A</th><th>B</th></tr><tr><td>1|2</td><td>3</td></tr></table>'
  + '<figure><img src="https://x.test/p.jpg" alt="pic"><figcaption>Caption</figcaption></figure><p>Line<br>break with *star*</p><script>alert(1)</script>');
check(md.startsWith('## Big\n\n### Sub'), '正文标题降一级，文档标题是唯一的一级标题');
check(md.includes('One **bold** and *it* & [a link](https://x.test/a), bad.'), '粗体斜体贴着文字、实体解码、只保留网页链接');
check(md.includes('- First\n- Second\n\n  - Nested') && md.includes('3. Three'), `列表、嵌套列表和起始编号（${JSON.stringify(md.slice(md.indexOf('- First'), md.indexOf('3. Three') + 8))}）`);
check(md.includes('> Quote one\n>\n> Quote two'), '引用');
check(md.includes('```\nlet x = 1;\nlet y = 2;\n```'), '代码块原样保留换行');
check(md.includes('| A | B |\n| --- | --- |\n| 1\\|2 | 3 |'), '表格，单元格里的竖线转义');
check(md.includes('![pic](https://x.test/p.jpg)') && md.includes('*Caption*'), '图片和图注');
check(md.includes('Line  \nbreak with \\*star\\*') && !md.includes('alert'), '换行、星号转义、脚本丢弃');

// ── translation ─────────────────────────────────────────────────────────────
console.log('=== 译文 ===');
const body = '<h2>Heading</h2><p>Talks resumed.</p><p>Both sides met.</p>';
check(segmentHtml(body).blocks.length === 3, '与阅读器同样的切块');
check(withTranslation(body, { 1: '会谈恢复。' }, 'bilingual') === '<h2>Heading</h2><p>Talks resumed.<br><span class="pnr-t">会谈恢复。</span></p><p>Both sides met.</p>', '双语：译文跟在原文后');
check(withTranslation(body, { 0: '标题', 1: '会谈 <恢复>。' }, 'translated') === '<h2>标题</h2><p>会谈 &lt;恢复&gt;。</p><p>Both sides met.</p>', '译文：替换原文并转义，没译的块保留原文');

// ── a scratch library ───────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pnr-export-'));
const db = openDb(join(dir, 'newsroom.db')); const now = Date.now();
db.prepare(`INSERT INTO sources (id,kind,name,url,domain,category,trust,enabled,added_by,created_at) VALUES ('wire','rss','Wire & Co','https://wire.test/rss?a=1&b=2','wire.test','world',0.9,1,'user',?)`).run(now);
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('hub','rsshub','知乎日报','/zhihu/daily',0.9,1,'user',?)`).run(now);
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('map','news_sitemap','Sitemap','https://map.test/s.xml',0.9,1,'user',?)`).run(now);
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('off','rss','Off','https://off.test/rss',0.9,0,'catalog',?)`).run(now);
const item = (id: string, title: string, html: string | null): void => {
  const path = html ? writeBody(dir, { itemId: id, url: `https://wire.test/${id}`, html, text: html.replace(/<[^>]+>/g, ' '), words: 9, lang: 'en', source: 'page', engine: 'test', extractedAt: now }) : null;
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,body_state,body_path,body_words,lang)
    VALUES (?,?,'wire',?,?,?,?,?,?,?,9,'en')`).run(id, id, `https://wire.test/${id}`, title, now, now, `<p>${title} snippet</p>`, html ? 'ok' : 'failed', path);
};
item('i1', 'Talks resume in Geneva', body);
item('i2', 'Ceasefire holds', '<p>It held.</p>');
item('i3', 'No body here', null);
db.prepare(`INSERT INTO item_translations (item_id,target,title,title_hash,blocks_json,updated_at) VALUES ('i1','zh-CN','日内瓦会谈恢复',?,?,?)`)
  .run(hashText('Talks resume in Geneva'), JSON.stringify({ [hashText('Talks resumed.')]: '会谈恢复。' }), now);

console.log('=== 文章 ===');
const plain = buildExport(db, { kind: 'article', itemId: 'i1' }, opts)!;
check(plain.title === 'Talks resume in Geneva' && plain.meta[0] === 'Wire & Co' && plain.link === 'https://wire.test/i1', '标题、来源、原文链接');
const bi = buildExport(db, { kind: 'article', itemId: 'i1' }, { ...opts, translation: { mode: 'bilingual', target: 'zh-CN' } })!;
check(bi.subtitle === '日内瓦会谈恢复' && toMarkdown(bi, labels).includes('Talks resumed.  \n会谈恢复。'), '双语导出：标题下有译名，段落后有译文');
const tr = buildExport(db, { kind: 'article', itemId: 'i1' }, { ...opts, translation: { mode: 'translation', target: 'zh-CN' } })!;
check(tr.title === '日内瓦会谈恢复' && tr.lang === 'zh-CN' && toMarkdown(tr, labels).includes('会谈恢复。') && !toMarkdown(tr, labels).includes('Talks resumed.'), '只看译文导出：译名作标题、语言记为目标语言');
const none = toMarkdown(buildExport(db, { kind: 'article', itemId: 'i3' }, opts)!, labels);
check(none.includes('No body here snippet') && none.includes(labels.noBody), '没有正文时只给摘要，并明说');
check(buildExport(db, { kind: 'article', itemId: 'gone' }, opts) === null, '已不存在的内容返回 null');

console.log('=== 今日摘要与引用 ===');
const w = createWatch(db, { origin: 'intent', label: '日内瓦会谈', intent: '我想知道日内瓦会谈的进展' });
db.prepare(`INSERT INTO digests (id,edition_date,lang,title,body_json,generated_at) VALUES ('d1','2026-10-24','zh-CN','今日：会谈恢复',?,?)`).run(JSON.stringify([
  { type: 'heading', level: 2, text: '会谈', watchId: w.id },
  { type: 'paragraph', text: '双方恢复会谈。', sourceRefIds: ['i1', 'i2'] },
  { type: 'list', items: ['第一点', '第二点'], sourceRefIds: ['i1', 'missing'] }
]), now);
const digest = buildExport(db, { kind: 'digest', date: '2026-10-24' }, opts)!;
check(digest.sources.length === 2 && digest.sources[0]!.url === 'https://wire.test/i1' && digest.sources[1]!.title === 'Ceasefire holds', '来源按首次引用编号，同一篇保持同一个号，找不到的不编号');
const dmd = toMarkdown(digest, labels);
check(dmd.includes('*日内瓦会谈*\n\n## 会谈') && dmd.includes('双方恢复会谈。[^1][^2]') && dmd.includes('- 第二点[^1]'), '小标题上标所属关注，句末是脚注');
check(dmd.includes('[^1]: [Talks resume in Geneva](https://wire.test/i1) · Wire & Co ·') && dmd.includes('由「所闻」于'), '脚注里是真实标题、来源和链接，文末注明导出');
const html = toHtml(digest, labels);
check(html.includes('<html lang="zh-CN">') && html.includes(`default-src 'none'`) && !/<script/i.test(html), 'HTML 记语言、禁止脚本');
check(html.includes('<sup class="cite"><a href="#source-1">1</a></sup>') && html.includes('<li id="source-2"><a href="https://wire.test/i2">Ceasefire holds</a>'), 'HTML 角标链到文末来源');
check(html.includes('Wire &amp; Co'), 'HTML 转义来源名');

console.log('=== 快讯与关注 ===');
db.prepare(`INSERT INTO flashes (id,watch_ids_json,item_ids_json,batch_id,published_at,lang,title,body,importance,importance_reason,created_at)
  VALUES ('f1',?,?,'b',?,'zh-CN','停火维持','停火已维持一天。',9,'影响谈判走向',?)`).run(JSON.stringify([w.id]), JSON.stringify(['i2']), now, now);
const flash = toMarkdown(buildExport(db, { kind: 'flash', flashId: 'f1' }, opts)!, labels);
check(flash.includes('快讯 · ') && flash.includes(' · 重要') && flash.includes('停火已维持一天。[^1]') && flash.includes('**为什么重要**　影响谈判走向'), '快讯：时间、重要标记、正文引用、为什么重要');
db.prepare(`INSERT INTO milestones (id,watch_id,occurred_on,first_seen_at,summary,is_new,created_at) VALUES ('m1',?,'2026-10-20',?,'会谈中断',0,?)`).run(w.id, now, now);
db.prepare(`INSERT INTO milestones (id,watch_id,occurred_on,first_seen_at,summary,is_new,created_at) VALUES ('m2',?,'2026-10-23',?,'会谈恢复',1,?)`).run(w.id, now, now);
db.prepare(`INSERT INTO milestone_sources (milestone_id,item_id) VALUES ('m2','i1')`).run();
const watch = toMarkdown(buildExport(db, { kind: 'watch', watchId: w.id }, opts)!, labels);
check(watch.includes('> 我想知道日内瓦会谈的进展') && watch.indexOf('会谈恢复') < watch.indexOf('会谈中断') && watch.includes('会谈恢复[^1]'), '关注：原话、时间线最新在上、带来源');

console.log('=== 文章列表 ===');
const list = toMarkdown(buildExport(db, { kind: 'articles', title: 'Wire', itemIds: ['i2', 'i1'] }, opts)!, labels);
check(list.includes('- [Ceasefire holds](https://wire.test/i2) — Wire & Co'), '列表每行是链接加来源');

// ── OPML ────────────────────────────────────────────────────────────────────
console.log('=== OPML ===');
const opml = buildOpml(db, { title: 'Subs', lang: 'zh-CN' });
check(opml.count === 1 && opml.skipped === 2, `只写别的阅读器能打开的订阅（写 ${opml.count}，略过 ${opml.skipped}）`);
check(opml.xml.includes('<outline text="国际新闻" title="国际新闻">') && opml.xml.includes('text="Wire &amp; Co"') && opml.xml.includes('xmlUrl="https://wire.test/rss?a=1&amp;b=2"') && !opml.xml.includes('off.test'), '按分类分组、转义、未订阅的不写');
const own = buildOpml(db, { title: 'Subs', lang: 'en', rssHubInstance: 'http://127.0.0.1:1200/' });
check(own.count === 2 && own.xml.includes('xmlUrl="http://127.0.0.1:1200/zhihu/daily"') && own.xml.includes('<outline text="Other"'), '有自己的 RSSHub 实例时，路由写成实例地址');

// ── backup ──────────────────────────────────────────────────────────────────
console.log('=== 备份 ===');
const secret = 'AIzaSyEXAMPLE-not-a-real-key-123456';
for (const [k, v] of [['ai.geminiApiKey', secret], ['apify.token', `${secret}-apify`], ['ui.language', 'en']] as const)
  db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(k, v, now);
const copyPath = join(dir, 'backup.db');
await backupDatabase(db, copyPath);
const copy = new Database(copyPath, { readonly: true });
const keys = (copy.prepare('SELECT key FROM settings ORDER BY key').all() as { key: string }[]).map((r) => r.key);
check(keys.includes('ui.language') && !keys.some((k) => /apikey|token/i.test(k)), `备份保留设置、去掉密钥（${keys.join(', ')}）`);
check((copy.prepare('SELECT COUNT(*) n FROM items').get() as { n: number }).n === 3 && (copy.pragma('journal_mode', { simple: true }) as string) === 'delete', '内容完整，是单个文件');
copy.close();
check(!readFileSync(copyPath).includes(Buffer.from(secret)), '密钥在备份文件里连残留都没有');
check((db.prepare("SELECT value FROM settings WHERE key = 'ai.geminiApiKey'").get() as { value: string }).value === secret, '原库的密钥不受影响');

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
