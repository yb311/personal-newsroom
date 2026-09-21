import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../packages/store/src/index.ts';
import { generateOutsidePicks, readOutsidePicks } from '../packages/generate/src/index.ts';
import { createWatch, listWatches } from '../packages/watch/src/index.ts';

const dir=mkdtempSync(join(tmpdir(),'pnr-outside-')); const db=openDb(join(dir,'newsroom.db')); const now=Date.now();
const sources=[['a','news.alpha.com','Alpha'],['b','beta.net','Beta'],['c','gamma.org','Gamma'],['a2','world.alpha.com','Alpha World'],['d','delta.net','Delta']];
for(const [id,domain,name] of sources)db.prepare(`INSERT INTO sources (id,kind,name,domain,url,trust,enabled,added_by,created_at) VALUES (?,'rss',?,?,?,.8,1,'catalog',?)`).run(id,name,domain,`https://${domain}/rss`,now);
const add=(id:string,source:string,title:string,lang='en')=>db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,lang,body_state) VALUES (?,?,?,?,?,?,?,?,?,'pending')`).run(id,id,source,`https://x.test/${id}`,title,now,now,title,lang);
add('q1','a','Major quake strikes Coast City downtown'); add('q2','b','Major quake strikes Coast City overnight'); add('q3','c','Major quake strikes Coast City buildings');
add('two1','b','Central bank cuts interest rates today'); add('two2','d','Central bank cuts interest rates sharply');
add('dup1','a','Volcano eruption closes North Island airport'); add('dup2','a2','Volcano eruption closes North Island roads'); add('dup3','a','Volcano eruption closes North Island schools');
add('zh1','a','海岸城市发生重大地震','zh'); add('zh2','b','海岸城市发生重大地震','zh'); add('zh3','c','海岸城市发生重大地震','zh');
db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('reader.languages','["en"]',?)`).run(now);

let picks=await generateOutsidePicks(db,null,[],'en');
if(picks.length!==1||!picks[0]?.itemIds.includes('q3'))throw new Error('3-publisher/no-watch fallback failed');
if(picks.some(p=>p.itemIds.includes('two1')||p.itemIds.includes('dup1')))throw new Error('2 publishers or duplicate publisher passed');
const watch=createWatch(db,{origin:'intent',label:'Quake',intent:'I follow the Coast City quake',keywords:['quake']});
for(const id of ['q1','q2','q3'])db.prepare(`INSERT INTO matches (watch_id,item_id,recalled_by,passed_gate,created_at) VALUES (?,?,'keyword',1,?)`).run(watch.id,id,now);
picks=await generateOutsidePicks(db,null,listWatches(db,true),'en'); if(picks.some(p=>p.itemIds.includes('q1')))throw new Error('watched event was not excluded');
db.prepare(`UPDATE settings SET value='["zh"]',updated_at=? WHERE key='reader.languages'`).run(now);
picks=await generateOutsidePicks(db,null,listWatches(db,true),'en'); if(!picks.some(p=>p.itemIds.includes('zh1')))throw new Error('reading language filter failed');
db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('ai.outsidePicksEnabled','0',?)`).run(now);
if((await generateOutsidePicks(db,null,listWatches(db,true),'en')).length||readOutsidePicks(db,listWatches(db,true),'en').length)throw new Error('disabled picks still generated');
console.log('✅ 无 Watch、无 AI、3/2 家、同媒体多 feed、已关注、语言过滤与开关');
db.close(); rmSync(dir,{recursive:true,force:true});
