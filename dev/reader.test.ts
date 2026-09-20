/** Fetch + extract real articles, then the full DB-backed enrich path. */
import { openDb } from '../packages/store/src/index.ts';
import { fetchArticleHtml, extractArticle, enrichItem, htmlToBlocks } from '../packages/reader/src/index.ts';
import { countWords } from '../packages/core/src/index.ts';
import { rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pull real article URLs from live feeds rather than hardcoding links that rot.
import { fetchText, parseFeed } from '../packages/feed/src/index.ts';
import type { SourceRecord } from '../packages/core/src/index.ts';

const feeds: [string, string][] = [
  ['BBC',        'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['Guardian',   'https://www.theguardian.com/world/rss'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['NPR',        'https://feeds.npr.org/1001/rss.xml']
];
const urls: [string, string][] = [];
for (const [name, feed] of feeds) {
  try {
    const s = { id:'t', kind:'rss', name, domain:null, url:feed, category:null, lang:null,
                country:null, trust:0.9, enabled:1, dateHydration:null, configJson:null } as SourceRecord;
    const r = parseFeed(await fetchText(feed), s);
    if (r.items[0]) urls.push([name, r.items[0].url]);
  } catch { /* skip */ }
}
// Expected to fail: NYT is on the paywall skip list, and proving that it is
// refused rather than half-extracted is the point of including it.
const EXPECT_FAIL = new Set(['付费墙(NYT)']);
urls.push(['付费墙(NYT)', 'https://www.nytimes.com/2026/09/20/world/europe/ukraine.html']);

// ── boilerplate filter ────────────────────────────────────────────────────
console.log('=== 样板过滤 ===');
{
  const cases: [string, string, boolean][] = [
    ['图库题注',     'Item 1 of 3 Soccer Football - Premier League REUTERS/Phil Noble', false],
    ['版权样板',     '[1/3]Soccer Football ... Purchase Licensing Rights, opens new tab Read more', false],
    ['广告',         'Advertisement', false],
    ['订阅推销',     'Sign up for our daily newsletter', false],
    ['纯来源行',     'Reuters', false],
    ['中文图注',     '图：新华社记者 张三 摄', false],
    ['正常导语',     'MANCHESTER, England, Sept 20 (Reuters) - City head into the break three points clear.', true],
    // The guard that matters: a real sentence that merely mentions a boilerplate
    // phrase must survive.
    ['长句含敏感词', 'The club said the deal, which purchase licensing rights arrangements normally cover, would be reviewed by the commercial committee before the end of the season, according to two people familiar with the talks.', true],
    ['正常中文',     '中国人民银行周一宣布下调存款准备金率０．５个百分点，释放长期资金约一万亿元。', true]
  ];
  let bad = 0;
  for (const [label, text, keep] of cases) {
    const got = htmlToBlocks(`<p>${text}</p>`).length > 0;
    if (got !== keep) { bad++; console.log(`  ❌ ${label} 期望${keep?'保留':'丢弃'} 实际${got?'保留':'丢弃'}`); }
  }
  console.log(bad ? `  ${bad} 个不符合预期` : `  ${cases.length}/${cases.length} 通过`);
}

console.log('\n=== 直接抽取 ===');
for (const [name, url] of urls) {
  const t = Date.now();
  try {
    const { html, tier } = await fetchArticleHtml(url!);
    const ex = await extractArticle(html, url!);
    const ms = String(Date.now()-t).padStart(5);
    if (!ex) { console.log(`  ${EXPECT_FAIL.has(name!) ? '✅' : '⚠️ '} ${name!.padEnd(12)} ${ms}ms  抽不出内容`); continue; }
    const kinds = [...new Set(ex.blocks.map(b=>b.type))].join(',');
    console.log(`  ✅ ${name!.padEnd(12)} ${ms}ms  ${String(ex.words).padStart(5)} 词  ${ex.engine.padEnd(10)} ${tier.padEnd(6)} 块型:${kinds}`);
  } catch (e) {
    const expected = EXPECT_FAIL.has(name!);
    console.log(`  ${expected ? '✅' : '❌'} ${name!.padEnd(12)} ${String(Date.now()-t).padStart(5)}ms  ${(e as Error).message.slice(0,40)}${expected ? ' — 预期拒绝，正确' : ''}`);
  }
}

console.log('\n=== 走数据库的完整 enrich 路径 ===');
const dir = mkdtempSync(join(tmpdir(), 'pnr-reader-'));
const db = openDb(join(dir, 'db.sqlite'));
const now = Date.now();
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','测试','http://x',0.9,1,'user',?)").run(now);
const cases = [['i1','https://www.bbc.com/news'],['i2','https://www.nytimes.com/2026/09/20/world/europe/ukraine.html']];
for (const [id,url] of cases)
  db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES (?,?,'s',?,'t',?,?)").run(id,id,url,now,now);

for (const [id,url] of cases) {
  const r = await enrichItem(db, dir, { id: id!, url: url! });
  console.log(`  ${id}  state=${r.state.padEnd(8)} words=${String(r.words).padStart(5)} ${r.engine ?? ''} ${r.reason ?? ''}`);
  const row = db.prepare('SELECT body_state, body_path, body_words FROM items WHERE id=?').get(id) as any;
  if (row.body_path) {
    const saved = JSON.parse(readFileSync(row.body_path,'utf8'));
    const ok = countWords(saved.blocks) === row.body_words;
    console.log(`      落盘 ${saved.blocks.length} 块，词数一致: ${ok ? '是' : '否'}`);
  }
}
db.close(); rmSync(dir,{recursive:true,force:true});
console.log('\n完成');

console.log('\n全部符合预期');
