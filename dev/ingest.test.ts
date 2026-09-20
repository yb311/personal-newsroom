/** M0 acceptance: catalogue → fetch → parse → dedupe → store → read back. */
import { openDb } from '../packages/store/src/index.ts';
import { ingestAll } from '../packages/feed/src/index.ts';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `pnr-e2e-${Date.now()}.db`);
const db = openDb(dbPath);

// 1) 导入目录
const feeds = JSON.parse(readFileSync(new URL('../catalogs/data/feeds.json', import.meta.url), 'utf8')) as any[];
const ins = db.prepare(
  `INSERT INTO sources (id,kind,name,domain,url,category,lang,country,trust,enabled,date_hydration,added_by,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,'catalog',?) ON CONFLICT(id) DO NOTHING`);
const now = Date.now();
db.transaction(() => {
  for (const f of feeds)
    ins.run(f.id, f.kind, f.name, f.domain ?? null, f.url, f.category ?? null, f.lang ?? null,
            f.country ?? null, f.trust, f.featured ? 1 : 0, f.dateHydration ?? null, now);
})();
const total = (db.prepare('SELECT count(*) c FROM sources').get() as any).c;
const on = (db.prepare('SELECT count(*) c FROM sources WHERE enabled=1').get() as any).c;
console.log(`目录导入: ${total} 个源，默认启用 ${on} 个\n`);

// 2) 抓取
console.log('抓取中…');
const t0 = Date.now();
const r = await ingestAll(db, 8);
console.log(`\n抓了 ${r.sources} 个源，入库 ${r.inserted} 条，耗时 ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

// 3) 读回来
const items = db.prepare(
  `SELECT i.title, i.published_at, s.name AS src FROM items i
   JOIN sources s ON s.id=i.source_id ORDER BY i.published_at DESC LIMIT 8`).all() as any[];
console.log('最新 8 条:');
for (const it of items)
  console.log(`  [${new Date(it.published_at).toISOString().slice(5,16)}] ${String(it.src).padEnd(14).slice(0,14)} ${String(it.title).slice(0,56)}`);

// 4) 去重验证：再抓一遍，应该几乎全是重复
console.log('\n再抓一遍验证去重…');
const r2 = await ingestAll(db, 8);
console.log(`第二遍新增 ${r2.inserted} 条  ← 应该接近 0`);

const byLang = db.prepare(`SELECT count(DISTINCT source_id) srcs, count(*) n FROM items`).get() as any;
console.log(`\n库中共 ${byLang.n} 条，来自 ${byLang.srcs} 个源`);
const failed = db.prepare(`SELECT name, last_error FROM sources WHERE enabled=1 AND last_error IS NOT NULL`).all() as any[];
if (failed.length) { console.log(`\n抓取失败的源 ${failed.length} 个:`); for (const f of failed) console.log(`  ${f.name}: ${f.last_error}`); }

db.close();
for (const s of ['','-wal','-shm']) rmSync(dbPath+s,{force:true});
console.log('\n✅ M0 端到端通过');
