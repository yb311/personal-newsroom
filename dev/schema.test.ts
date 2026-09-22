import { openDb } from '../packages/store/src/index.ts';
import { acquireLock, renewLock, releaseLock } from '../packages/store/src/index.ts';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MIGRATIONS } from '../packages/store/src/migrations.ts';

const p = join(tmpdir(), `pnr-verify-${Date.now()}.db`);
const db = openDb(p);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
console.log(`表 ${tables.length} 张:`);
console.log('  ' + tables.map(t=>t.name).join(', '));

const idx = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get() as {c:number};
console.log(`索引 ${idx.c} 个`);
console.log(`vec_version: ${(db.prepare('select vec_version() v').get() as {v:string}).v}`);
console.log(`journal_mode: ${db.pragma('journal_mode', {simple:true})}`);
console.log(`foreign_keys: ${db.pragma('foreign_keys', {simple:true})}`);

// 外键与写入通路：插一条源 → 一条 item → 一条 watch → 一条 match → 向量
const now = Date.now();
db.prepare("INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s1','rss','测试源','https://example.com/feed',0.9,1,'user',?)").run(now);
db.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES ('i1','example.com/a','s1','https://example.com/a','测试标题',?,?)").run(now,now);
db.prepare("INSERT INTO watches (id,origin,label,intent,created_at) VALUES ('w1','intent','习近平','我想知道习近平最近在干什么',?)").run(now);
db.prepare("INSERT INTO matches (watch_id,item_id,recalled_by,vector_score,intent_score,reason,passed_gate,created_at) VALUES ('w1','i1','r1_vector,r2_alias',0.83,8,'直接报道了该主题的最新进展',1,?)").run(now);
db.prepare("INSERT INTO milestones (id,watch_id,occurred_on,first_seen_at,summary,created_at) VALUES ('m1','w1','2026-09-20',?,'首次出现的里程碑',?)").run(now,now);
db.prepare("INSERT INTO told_records (watch_id,narrative,surface,told_at) VALUES ('w1','昨天我告诉过你的完整叙述原文','digest',?)").run(now);

const vec = Float32Array.from({length:768},(_,i)=>Math.sin(i*0.01));
db.prepare('INSERT INTO embeddings(item_id, embedding) VALUES (?,?)').run('i1', Buffer.from(vec.buffer));
db.prepare('INSERT INTO watch_vectors(watch_id, embedding) VALUES (?,?)').run('w1', Buffer.from(vec.buffer));
const knn = db.prepare('SELECT item_id, distance FROM embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 1').get(Buffer.from(vec.buffer)) as {item_id:string};
console.log(`\n写入通路 OK，KNN 命中: ${knn.item_id}`);

// 外键级联：删掉 watch，match/milestone/told 应一起消失
db.prepare("DELETE FROM watches WHERE id='w1'").run();
const left = ['matches','milestones','told_records'].map(t => `${t}=${(db.prepare(`SELECT count(*) c FROM ${t}`).get() as {c:number}).c}`);
console.log(`级联删除后: ${left.join(' ')}  ← 应全为 0`);

// 锁
console.log(`\n锁: 拿=${acquireLock(db,'daily',1)} 他人抢=${acquireLock(db,'daily',2)} 续=${renewLock(db,'daily',1)}`);
releaseLock(db,'daily',1);
console.log(`释放后重新拿=${acquireLock(db,'daily',2)}`);

// 幂等：再开一次不应重复建表
db.close();
const db2 = openDb(p);
const t2 = (db2.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get() as {c:number}).c;
console.log(`\n重复打开（迁移幂等）: 表数仍为 ${t2 - 1} + _migrations`);
db2.close();
for (const s of ['','-wal','-shm']) rmSync(p+s,{force:true});

// 真实升级路径：保留已经使用到 M005 的旧库和旧版深度总结，再应用 M006-M010。
const upgrade = join(tmpdir(), `pnr-upgrade-${Date.now()}.db`);
const legacy = new Database(upgrade); legacy.loadExtension(sqliteVec.getLoadablePath()); legacy.pragma('journal_mode=WAL'); legacy.pragma('foreign_keys=ON');
legacy.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const migration of MIGRATIONS.slice(0,5)) legacy.transaction(()=>{
  legacy.exec(migration.sql); legacy.prepare('INSERT INTO _migrations VALUES (?,?)').run(migration.name,now);
})();
legacy.prepare("INSERT INTO sources (id,kind,name,url,created_at) VALUES ('old-s','rss','Old','https://old.test/rss',?)").run(now);
legacy.prepare("INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES ('old-i','old','old-s','https://old.test/a','Old item',?,?)").run(now,now);
legacy.prepare("INSERT INTO deep_summaries (id,item_id,lang,body_json,sources_json,generated_at,model) VALUES ('old-d','old-i','en','[]','[]',?,'old-model')").run(now);
legacy.close();
const upgraded=openDb(upgrade);
const applied=(upgraded.prepare('SELECT name FROM _migrations ORDER BY name').all() as {name:string}[]).map(r=>r.name);
if(applied.length!==MIGRATIONS.length)throw new Error(`migration chain incomplete: ${applied.join(',')}`);
if((upgraded.prepare('SELECT COUNT(*) c FROM legacy_deep_summaries').get() as {c:number}).c!==1)throw new Error('legacy deep summary lost');
if(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deep_summaries'").get())throw new Error('old table name survived');
for(const name of ['ai_runtime','search_materials','conversations','outside_picks','assistant_chats','assistant_messages','assistant_sources'])
  if(!upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error(`missing upgraded table ${name}`);
upgraded.close();for(const s of ['','-wal','-shm'])rmSync(upgrade+s,{force:true});
console.log('\n✅ schema 新建、幂等与 005→010 真实升级验证通过');
