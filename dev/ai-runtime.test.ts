import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../packages/store/src/index.ts';
import { embedItems, ensureVectorProfile } from '../packages/ai/src/index.ts';
import { aiPrescreenWatches, rankAndCap, type Candidate } from '../packages/recall/src/index.ts';
import { createWatch, listWatches } from '../packages/watch/src/index.ts';
import type { Provider, VectorProfile } from '../packages/ai/src/index.ts';

const dir=mkdtempSync(join(tmpdir(),'pnr-ai-runtime-'));const db=openDb(join(dir,'newsroom.db'));const now=Date.now();
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','Source','https://x.test/rss',.8,1,'user',?)`).run(now);
for(const [id,title] of [['i1','Mars mission launches'],['i2','Central bank changes rates']] as const)
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet) VALUES (?,?,?,?,?,?,?,?)`).run(id,id,'s',`https://x.test/${id}`,title,now,now,title);
createWatch(db,{origin:'intent',label:'Space',intent:'Tell me about the Mars mission'});
createWatch(db,{origin:'intent',label:'Rates',intent:'Tell me about central bank interest rates'});
const watches=listWatches(db,true);
const base=(generate:Provider['generate']):Provider=>({
  id:'openai-compatible',name:'fake',fastModel:'fast',writeModel:'write',embeddingDims:0,vectorProfile:undefined,pricing:undefined,
  capabilities:{embedding:false,search:false,stream:false,structured:'schema'},limits:{fast:{maxInputTokens:8000,maxOutputTokens:1000},write:{maxInputTokens:16000,maxOutputTokens:2000}},
  async isAvailable(){return true;},async check(){return{ok:true};},generate,async *stream(){},async search(){return{provider:'openai-compatible',model:'write',text:'',executed:false,sources:[]};},async embed(){return[];}
});
const mapped=await aiPrescreenWatches(db,base(async<T>(_p,o)=>({data:{results:[
  {articleId:'i1',watchIds:[watches[0]!.id]},{articleId:'i2',watchIds:[watches[1]!.id]}
]} as T,provider:'openai-compatible',model:o.model??'fast',usedSearch:false})),watches,48);
assert.deepEqual([...mapped.matches.get(watches[0]!.id)!],['i1']);
assert.deepEqual([...mapped.matches.get(watches[1]!.id)!],['i2']);
// Remembered: the same window again asks nothing and returns the same verdicts.
let asked=0;
const cached=await aiPrescreenWatches(db,base(async()=>{asked++;throw new Error('should not be asked');}),watches,48);
assert.equal(asked,0);
assert.deepEqual([...cached.matches.get(watches[0]!.id)!],['i1']);
assert.deepEqual([...cached.matches.get(watches[1]!.id)!],['i2']);
// A new article is the only one sent; when that fails it is kept for every watch, and asked again next time.
db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet) VALUES ('i3','i3','s','https://x.test/i3','Rocket test',?,?,'Rocket test')`).run(now,now);
const widened=await aiPrescreenWatches(db,base(async(p)=>{asked++;assert.ok(p.includes('i3:')&&!p.includes('i1:'));throw new Error('temporary outage');}),watches,48);
assert.equal(asked,1);
for(const watch of watches){assert.ok(widened.matches.get(watch.id)?.has('i3'));assert.deepEqual([...widened.degraded.get(watch.id)!],['i3']);}
assert.equal((db.prepare("SELECT COUNT(*) c FROM prescreen_results WHERE item_id='i3'").get() as {c:number}).c,0);

const candidate=(id:string,arms:Candidate['arms'],publishedAt=now):Candidate=>({itemId:id,title:id,snippet:null,sourceName:'s',publishedAt,arms});
const ranked=rankAndCap([candidate('old-ai',new Set(['r1_ai']),now-10*864e5),candidate('fresh-alias',new Set(['r2_alias'])),candidate('search',new Set(['r3_search']))],1);
assert.equal(ranked[0]?.itemId,'old-ai');

let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
const profile=(model:string):VectorProfile=>({provider:'openai-compatible',endpoint:'http://local',model,dimensions:768,taskConfig:'default',inputVersion:1});
const embeddingProvider=(model:string):Provider=>({
  ...base(async<T>(_p,o)=>({data:{} as T,provider:'openai-compatible',model:o.model??'fast',usedSearch:false})),
  capabilities:{embedding:true,search:false,stream:false,structured:'schema'},embeddingDims:768,vectorProfile:profile(model),
  async embed(texts){await gate;return texts.map(()=>Float32Array.from({length:768},(_,i)=>i/768));}
});
const p1=embeddingProvider('embed-v1'); const pending=embedItems(db,p1,[{id:'i1',text:'Mars'}]);
await new Promise(resolve=>setImmediate(resolve));
const before=(db.prepare('SELECT vector_generation generation FROM ai_runtime WHERE id=1').get() as any).generation;
ensureVectorProfile(db,embeddingProvider('embed-v2')); release();
await assert.rejects(pending,/vector_generation_changed/);
assert.equal((db.prepare('SELECT COUNT(*) n FROM embedding_cache_meta').get() as any).n,0);
assert.equal((db.prepare('SELECT vector_generation generation FROM ai_runtime WHERE id=1').get() as any).generation,before+1);
console.log('✅ 多 Watch 初筛、失败只扩不减、R1 AI 排序及向量换代防旧结果回写');
db.close();rmSync(dir,{recursive:true,force:true});
