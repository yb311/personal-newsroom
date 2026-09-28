/** Catalogue search against the real bundled catalogue.  npm run test:catalogue */
import { openDb } from '../packages/store/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

const dir = mkdtempSync(join(tmpdir(), 'pnr-cat-'));
const db = openDb(join(dir, 'db.sqlite'));
const feeds = JSON.parse(readFileSync(new URL('../catalogs/data/feeds.json', import.meta.url), 'utf8')) as any[];
check(new Set(feeds.map((f) => f.id)).size === feeds.length, `目录里没有重复 id（${feeds.length} 个源）`);
check(feeds.every((f) => f.name.length <= 40), '源名称不超过 40 字');
// Hand-written coverage scores: one row per catalogue source, only known fields, whole numbers 1–10.
const { SCORE_FIELDS } = await import('../packages/core/src/catalog-labels.ts');
const scores = JSON.parse(readFileSync(new URL('../catalogs/data/source-scores.json', import.meta.url), 'utf8')) as { id: string; scores: Record<string, number> }[];
const feedIds = new Set(feeds.map((f) => f.id));
const scoreIds = new Set(scores.map((r) => r.id));
check(scores.every((r) => feedIds.has(r.id)) && scoreIds.size === scores.length, '评分表里的每个 id 都在目录里，且不重复');
const unscored = feeds.filter((f) => !scoreIds.has(f.id)).map((f) => f.id);
check(unscored.length === 0, `目录里每个源都有评分行${unscored.length ? `（缺 ${unscored.slice(0, 3).join(', ')}）` : ''}`);
check(scores.every((r) => Object.keys(r.scores).length > 0), '每个源至少在一个领域有分');
check(scores.every((r) => Object.entries(r.scores).every(([k, v]) => k in SCORE_FIELDS && Number.isInteger(v) && v >= 1 && v <= 10)),
      '领域都在固定清单里，分数是 1–10 的整数');

const ins = db.prepare(`INSERT INTO sources (id,kind,name,domain,url,category,country,trust,enabled,added_by,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,'catalog',0)`);
for (const f of feeds) ins.run(f.id, f.kind, f.name, f.domain ?? null, f.url, f.category ?? null, f.country ?? null, f.trust, f.featured ? 1 : 0);
const api = createApi(db, dir);
const cats = (q: string): Set<string | null> => new Set(api.catalogue({ q }).rows.map((s) => s.category));

check([...cats('国际新闻')].every((c) => c === 'world') && cats('国际新闻').size === 1, '「国际新闻」只出国际新闻类');
const news = cats('新闻');
check(news.has('news') && news.has('world'), `「新闻」同时出综合新闻和国际新闻（${[...news].join(',')}）`);
check(api.catalogue({ q: '美国' }).rows.every((s) => s.country === 'United States') && api.catalogue({ q: '美国' }).total > 0, '「美国」出美国的源');
check(api.catalogue({ q: 'bbc' }).rows[0]?.name.startsWith('BBC') === true, '「bbc」第一条是 BBC');
check(!api.catalogue({ q: 'ai' }).rows.some((s) => /spain|ain't|airbnb/i.test(`${s.country} ${s.name}`)), '「ai」不会命中 Spain、Airbnb 之类');
check(api.catalogue({ q: '财经' }).rows.every((s) => s.category === 'business-economy'), '「财经」出商业与经济类');
const facets = api.catalogue({ q: '新闻', country: 'India' });
check(facets.rows.every((s) => s.country === 'India') && facets.countries.length > 1, '国家筛选只收窄结果，筛选项数量不变');

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
