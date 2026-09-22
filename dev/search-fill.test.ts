import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../packages/store/src/index.ts';
import { fillFromSearch } from '../packages/generate/src/search-fill.ts';
import type { Provider } from '../packages/ai/src/index.ts';

const dir=mkdtempSync(join(tmpdir(),'pnr-search-fill-')); const db=openDb(join(dir,'newsroom.db')); const now=Date.now();
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('seed','rss','Seed','https://seed.test/rss',.8,1,'user',?)`).run(now);
db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at) VALUES ('seed-item','seed','seed','https://seed.test/a','Exact launch event',?,?)`).run(now,now);
const provider:Provider={
  id:'gemini',name:'fake',fastModel:'fast',writeModel:'write',embeddingDims:0,vectorProfile:undefined,pricing:undefined,
  capabilities:{embedding:false,search:true,stream:false,structured:'schema'},limits:{fast:{maxInputTokens:8000,maxOutputTokens:1000},write:{maxInputTokens:16000,maxOutputTokens:2000}},
  async isAvailable(){return true;},async check(){return{ok:true};},async embed(){return[];},async *stream(){},
  async search(){return{provider:'gemini',model:'write',text:'grounded',executed:true,sources:[
    {url:'https://good.test/story',title:'Exact launch confirmed'},
    {url:'https://other.test/story',title:'Different launch'},
    {url:'https://down.test/story',title:'Unavailable'}]};},
  async generate<T>(_prompt,opts){
    const data=opts.operation==='search_validate'
      ? {sources:[{refId:'s1',relevant:true,supported:true},{refId:'s2',relevant:false,supported:true},{refId:'forged',relevant:true,supported:true}]}
      : {publishable:true,title:'Confirmed launch',body:'The exact launch was confirmed.',sourceRefIds:['s1','s2','forged']};
    return{data:data as T,provider:'gemini',model:opts.model??'fast',usedSearch:false};
  }
};
const result=await fillFromSearch(db,provider,{itemId:'seed-item',title:'Exact launch event',publishedAt:now,lang:'en'}, {
  async download(url){if(url.includes('down'))throw new Error('blocked');return{url,body:new TextEncoder().encode(url),contentType:'text/html',status:200,headers:{}} as any;},
  async extract(url){const exact=url.includes('good');return{title:exact?'Exact launch confirmed':'A different event',text:(exact?'The exact launch event happened today. ':'A different event happened years ago. ').repeat(12),html:'',words:100,lang:'en',engine:'test'} as any;}
});
assert.equal(result.publishable,true); assert.deepEqual(result.sourceRefIds,['s1']);
assert.deepEqual(result.sources.map(s=>[s.refId,s.accessible,s.relevant,s.supported]),[
  ['s1',true,true,true],['s2',true,false,true],['s3',false,false,false]
]);
assert.equal((db.prepare('SELECT COUNT(*) n FROM search_material_sources WHERE material_id=?').get(result.materialId) as any).n,3);
assert.equal((db.prepare('SELECT COUNT(*) n FROM items WHERE id LIKE ?').get('search-%') as any).n,2);
console.log('✅ 搜索补全仅采用可访问、同一事件且绑定过的来源；失败来源保留审计记录');
db.close();rmSync(dir,{recursive:true,force:true});
