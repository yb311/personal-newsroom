/**
 * Live smoke test of the reading path: real feeds, real pages, the database.
 *
 * Extraction quality itself is measured offline and reproducibly by the Go
 * benchmark (`npm run reader:test`, native/reader/core/benchmark_test.go).
 * This checks the wiring around it against today's web.
 */
import { openDb, readBody } from '../packages/store/src/index.ts';
import { fetchFeed } from '../packages/feed/src/index.ts';
import { enrichItem } from '../packages/reader/src/index.ts';
import type { SourceRecord } from '../packages/core/src/index.ts';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = (name: string, url: string, kind: SourceRecord['kind'] = 'rss'): SourceRecord =>
  ({ id: 't', kind, name, domain: null, url, category: null, lang: null, country: null,
     trust: 0.9, enabled: 1, dateHydration: null, configJson: null });

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

console.log('=== 解析：实体、语言 ===');
const usat = await fetchFeed(src('USA Today', 'https://www.usatoday.com/news-sitemap.xml', 'news_sitemap'), { kind: 'sitemap' });
check(usat.items.length > 50, `USA Today sitemap ${usat.items.length} 条`);
check(!usat.items.some((i) => /&#?\w+;/.test(i.title)), '标题里没有残留的 &#39; 之类实体');
const reuters = await fetchFeed(src('路透社', 'https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml', 'news_sitemap_index'), { kind: 'sitemap_index' });
const foreign = reuters.items.filter((i) => /reuters\.com\/(es|pt|fr|de)\//.test(i.url));
// Reuters labels these "en". A few are headed only by an internal code
// ("OFRBS Summary") that has no language to detect, so not every one can be.
const caught = foreign.filter((i) => i.lang !== 'en').length;
check(foreign.length === 0 || caught / foreign.length >= 0.9,
      `路透社外语文章按内容识别语言（${caught}/${foreign.length}）`);

console.log('\n=== 抽取：走数据库的完整 enrich 路径 ===');
const feeds: [string, string][] = [
  ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['Guardian', 'https://www.theguardian.com/world/rss'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['DW 中文', 'https://rss.dw.com/xml/rss-chi-all']
];
const dir = mkdtempSync(join(tmpdir(), 'pnr-reader-'));
const db = openDb(join(dir, 'db.sqlite'));
const now = Date.now();
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','测试','http://x',0.9,1,'user',?)").run(now);
const cases: [string, string, string][] = [];
for (const [name, url] of feeds) {
  const r = await fetchFeed(src(name, url));
  const it = r.items.find((i) => !/\/(video|live|av)\//.test(i.url));
  if (it) cases.push([name, `i${cases.length}`, it.url]);
}
// Expected to be refused: NYT is on the paywall list, and proving that it is
// refused rather than half-extracted is the point of including it.
cases.push(['付费墙(NYT)', 'nyt', 'https://www.nytimes.com/2026/09/20/world/europe/ukraine.html']);

for (const [name, id, url] of cases) {
  db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES (?,?,'s',?,'t',?,?)").run(id, id, url, now, now);
  const r = await enrichItem(db, dir, { id, url });
  if (id === 'nyt') { check(r.state === 'blocked', `${name} 被诚实拒绝（${r.reason}）`); continue; }
  const row = db.prepare('SELECT body_path AS p, body_words AS w FROM items WHERE id=?').get(id) as { p: string; w: number };
  const body = readBody(row.p);
  check(r.state === 'ok' && body !== null && body.words === row.w && !/<script/i.test(body.html),
        `${name.padEnd(10)} ${r.state} ${String(r.words).padStart(5)} 词 ${r.engine ?? r.reason ?? ''}`);
}
db.close(); rmSync(dir, { recursive: true, force: true });

console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
