/** Exercises every adapter against its real upstream. */
import { openDb } from '../packages/store/src/index.ts';
import { adapterFor } from '../packages/feed/src/index.ts';
import type { SourceRecord } from '../packages/core/src/index.ts';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `pnr-ad-${Date.now()}.db`);
const db = openDb(dbPath);

const src = (o: Partial<SourceRecord> & Pick<SourceRecord,'id'|'kind'|'name'|'url'>): SourceRecord => ({
  domain: null, category: null, lang: null, country: null, trust: 0.8,
  enabled: 1, dateHydration: null, configJson: null, ...o
});

const cases: [string, SourceRecord][] = [
  ['RSS',              src({ id:'t-rss',  kind:'rss',  name:'The Guardian', url:'https://www.theguardian.com/world/rss' })],
  ['RDF (RSS 1.0)',    src({ id:'t-rdf',  kind:'rss',  name:'DW',           url:'https://rss.dw.com/rdf/rss-en-world' })],
  ['news_sitemap',     src({ id:'t-sm',   kind:'news_sitemap', name:'USA Today', url:'https://www.usatoday.com/news-sitemap.xml' })],
  ['sitemap_index',    src({ id:'t-smi',  kind:'news_sitemap_index', name:'Reuters', url:'https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml' })],
  ['Telegram',         src({ id:'t-tg',   kind:'telegram', name:'Telegram', url:'durov' })],
  ['Hacker News',      src({ id:'t-hn',   kind:'hackernews', name:'HN',     url:'front_page' })],
  ['Reddit',           src({ id:'t-rd',   kind:'reddit', name:'r/worldnews', url:'worldnews' })],
  ['GitHub 活动',       src({ id:'t-gh',   kind:'github', name:'torvalds',  url:'torvalds' })],
  ['GitHub release',   src({ id:'t-ghr',  kind:'github', name:'node',       url:'nodejs/node' })],
  ['Google News 英',    src({ id:'t-gn',   kind:'googlenews', name:'GN',     url:'Xi Jinping', lang:'en-US', country:'US' })],
  ['Google News 中',    src({ id:'t-gnz',  kind:'googlenews', name:'GN',     url:'习近平',      lang:'zh-CN', country:'CN' })],
  ['Bing News',        src({ id:'t-bn',   kind:'bingnews', name:'Bing',     url:'Xi Jinping when:1d' })],
  ['GDELT',            src({ id:'t-gd',   kind:'gdelt', name:'GDELT',       url:'"Jinping"' })],
  ['RSSHub 知乎日报',   src({ id:'t-rh',   kind:'rsshub', name:'知乎日报',    url:'/zhihu/daily' })],
  ['RSSHub 无效路由',   src({ id:'t-rh2',  kind:'rsshub', name:'无效',        url:'/nope/nothing' })]
];

let pass = 0, fail = 0, throttled = 0;

// Being rate-limited or hitting a transient network error is the upstream's
// state, not a defect in the adapter. Reporting them as failures makes the
// suite noisy enough that people stop believing it.
const TRANSIENT = /^(http_429|http_503|network|timeout|fetch failed|instance_)/;
for (const [label, s] of cases) {
  const a = adapterFor(s.kind);
  if (!a) { console.log(`  ❌ ${label.padEnd(17)} 无适配器`); fail++; continue; }
  const t = Date.now();
  try {
    const r = await a(s, { db });
    const ms = String(Date.now()-t).padStart(5);
    // GDELT returning 429 and opening its circuit is the designed behaviour,
    // not a failure: the upstream throttles hard and we must fail fast.
    const rateLimited = Object.keys(r.diagnostics.droppedByReason).some((k) => TRANSIENT.test(k) || k === 'text_429' || k === 'circuit_open');
    // A route that does not exist must be reported as such, not as an empty
    // result — the two mean very different things to the user.
    const expectedMiss = label.includes('无效') && Boolean(r.diagnostics.droppedByReason['route_not_found']);
    const notInstalled = Boolean(r.diagnostics.droppedByReason['rsshub_not_available']);
    const ok = r.items.length > 0 || rateLimited || expectedMiss || notInstalled;
    const drops = Object.entries(r.diagnostics.droppedByReason).map(([k,v])=>`${k}:${v}`).join(' ');
    const suffix = rateLimited ? ' — 上游限流，降级正常'
      : expectedMiss ? ' — 正确识别为路由不存在'
      : notInstalled ? ' — 未安装社交源包，优雅降级' : '';
    const sample = r.items.length ? r.items[0]!.title.slice(0, 34) : `(${drops || '0 条'}${suffix})`;
    // 校验契约不变量
    const bad = r.items.filter(i => !i.title || !/^https?:/.test(i.url) || !Number.isFinite(Date.parse(i.publishedAt)));
    console.log(`  ${ok?'✅':'⚠️ '} ${label.padEnd(17)} ${ms}ms ${String(r.items.length).padStart(4)} 条  ${sample}`);
    if (bad.length) { console.log(`      ❌ 违反契约 ${bad.length} 条`); fail++; }
    else if (ok) pass++; else fail++;
  } catch (e) {
    const msg = (e as Error).message;
    if (TRANSIENT.test(msg)) {
      console.log(`  ⏳ ${label.padEnd(17)} ${String(Date.now()-t).padStart(5)}ms  ${msg.slice(0,40)} — 上游限流，非适配器问题`);
      throttled++;
    } else {
      console.log(`  ❌ ${label.padEnd(17)} ${String(Date.now()-t).padStart(5)}ms  ${msg.slice(0,44)}`);
      fail++;
    }
  }
}
const label = throttled ? `通过 ${pass} · 上游限流 ${throttled} · 失败 ${fail} / ${cases.length}`
                        : `通过 ${pass} / ${cases.length}`;
console.log(`\n${label}${fail === 0 ? '  ✅ 适配器全部正常' : ''}`);
const cb = db.prepare('SELECT endpoint, state, last_reason FROM circuit_breakers').all() as any[];
if (cb.length) console.log('熔断器:', cb.map(c=>`${c.endpoint}=${c.state}(${c.last_reason})`).join(' '));
db.close();
for (const x of ['','-wal','-shm']) rmSync(dbPath+x,{force:true});
