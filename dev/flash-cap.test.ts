import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../packages/store/src/index.ts';
import { generateFlashes, type SearchFillContext } from '../packages/generate/src/flashes.ts';
import { createWatch, listWatches } from '../packages/watch/src/index.ts';
import type { Provider } from '../packages/ai/src/index.ts';

const dir=mkdtempSync(join(tmpdir(),'pnr-flash-cap-'));const db=openDb(join(dir,'newsroom.db'));const now=Date.now();
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','Source','https://x.test/rss',.8,1,'user',?)`).run(now);
const zh=createWatch(db,{origin:'intent',label:'中文',intent:'关注中文事件',outputLang:'zh-CN'});
const en=createWatch(db,{origin:'intent',label:'English',intent:'Follow English events',outputLang:'en-US'});
for(let i=0;i<6;i++){
  const id=`i${i}`;db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,body_state) VALUES (?,?,?,?,?,?,?,?, 'pending')`).run(id,id,'s',`https://x.test/${id}`,`Important event ${i}`,now,now,`Confirmed summary ${i}`);
  db.prepare(`INSERT INTO matches (watch_id,item_id,recalled_by,intent_score,passed_gate,created_at) VALUES (?,?,'r1_ai',9,1,?)`).run(i<3?zh.id:en.id,id,now);
}
const provider:Provider={
  id:'gemini',name:'fake',fastModel:'fast',writeModel:'write',embeddingDims:0,vectorProfile:undefined,pricing:undefined,
  capabilities:{embedding:false,search:true,stream:false,structured:'schema'},limits:{fast:{maxInputTokens:8000,maxOutputTokens:1000},write:{maxInputTokens:16000,maxOutputTokens:2000}},
  async isAvailable(){return true;},async check(){return{ok:true};},async embed(){return[];},async *stream(){},async search(){return{provider:'gemini',model:'write',text:'',executed:true,sources:[]};},
  async generate<T>(prompt,opts){
    const ids=[...prompt.matchAll(/^(i\d+) \|/gm)].map(m=>m[1]!);
    const flashes=ids.map(id=>({itemId:id,alsoItemIds:[],watchIds:[],kind:'new',importance:9,importanceReason:'urgent',category:'test',title:`Flash ${id}`,body:`Body ${id}`}));
    return{data:{flashes} as T,provider:'gemini',model:opts.model??'write',usedSearch:false};
  }
};
let fills=0;const context:SearchFillContext={remaining:5,byEvent:new Map()};
const fakeFill:typeof import('../packages/generate/src/search-fill.ts').fillFromSearch=async(database,_provider,input)=>{
  fills++;const materialId=`material-${input.itemId}`;
  database.prepare(`INSERT INTO search_materials (id,target_item_id,event_title,event_time,date_estimated,provider,model,search_text,filled_text,publishable,created_at) VALUES (?,?,?,?,0,'gemini','write','evidence','filled',1,?)`).run(materialId,input.itemId,input.title,input.publishedAt,Date.now());
  return{materialId,publishable:true,title:`Filled ${input.itemId}`,body:'Verified body',sourceRefIds:[],sources:[]};
};
const watches=listWatches(db,true);const first=await generateFlashes(db,provider,watches.filter(w=>w.outputLang==='zh-CN'),'zh-CN',context,fakeFill);
const second=await generateFlashes(db,provider,watches.filter(w=>w.outputLang==='en-US'),'en-US',context,fakeFill);
assert.equal(first.length,3);assert.equal(second.length,3);assert.equal(fills,5);assert.equal(context.remaining,0);
assert.equal([...first,...second].filter(f=>f.basis==='search').length,5);
console.log('✅ 搜索补全额度在多语言快讯之间共享，整个运行最多 5 个事件');
db.close();rmSync(dir,{recursive:true,force:true});
