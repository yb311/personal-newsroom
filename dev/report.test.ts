import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, writeBody } from '../packages/store/src/index.ts';
import { startReport, askReport, getReport } from '../packages/generate/src/index.ts';
import type { Provider, GenerateOptions, GenerateResult, StreamEvent } from '../packages/ai/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'pnr-report-'));
const db = openDb(join(dir, 'newsroom.db')); const now = Date.now();
db.prepare(`INSERT INTO sources (id,kind,name,url,trust,enabled,added_by,created_at) VALUES ('s','rss','Wire','https://wire.test/rss',0.9,1,'user',?)`).run(now);
for (const [id, title, body] of [['i1','City approves a new transit line','The city council approved the transit line on Tuesday. The budget is 2 billion dollars.'],['i2','Transit line vote details','The vote passed 8 to 3 after a public hearing. Construction starts next year.']] as const) {
  const path = writeBody(dir, { itemId:id, url:`https://wire.test/${id}`, html: `<p>${body}</p>`, text: body,
    words: body.split(' ').length, lang:'en', source:'page', engine:'test', extractedAt:now });
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,body_state,body_path,body_words) VALUES (?,?,?,?,?,?,?,?, 'ok',?,?)`)
    .run(id, id, 's', `https://wire.test/${id}`, title, now, now, body, path, body.split(' ').length);
}

let answers = 0; let failNext = false;
const provider: Provider = {
  id:'gemini', name:'fake', fastModel:'fast', writeModel:'write', embeddingDims:0, vectorProfile:undefined, pricing:undefined,
  capabilities:{embedding:false,search:false,stream:true,structured:'schema'}, limits:{fast:{maxInputTokens:8000,maxOutputTokens:1000},write:{maxInputTokens:16000,maxOutputTokens:2000}},
  async isAvailable(){return true;}, async check(){return {ok:true};}, async embed(){return [];}, async search(){return {provider:'gemini',model:'write',text:'',executed:false,sources:[]};},
  async generate<T>(_prompt:string, opts:GenerateOptions & {model?:string}):Promise<GenerateResult<T>> {
    const data = (opts.operation === 'report_select' ? {itemIds:['i1','i2']} : {}) as T;
    return {data,provider:'gemini',model:opts.model ?? 'fast',usedSearch:false};
  },
  async *stream<T>(prompt:string, opts:GenerateOptions):AsyncIterable<StreamEvent<T>> {
    if (prompt.includes('QUESTION: Cancel this answer')) {
      await new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once:true });
      });
    }
    if (failNext) { failNext = false; yield {type:'error',error:new Error('boom') as never,sequence:1}; return; }
    answers++; const data = {title:`Answer ${answers}`,units:[{kind:'paragraph',text:'The council approved the line.',sourceRefIds:['s1'],supported:true}]} as T;
    yield {type:'partial',value:{title:`Answer ${answers}`} as Partial<T>,sequence:1};
    yield {type:'final',result:{data,provider:'gemini',model:'write',usedSearch:false},sequence:2};
  }
};

const events:any[]=[]; const request1='request-1';
const first = await startReport(db, provider, dir, {anchorItemId:'i1',itemIds:['i1'],topic:'Transit line',lang:'en',requestId:request1}, e=>events.push(e));
if (first.sources.length !== 2 || first.sources.some(s=>!s.materialText.includes('The'))) throw new Error('full source snapshots missing');
if (!first.messages.find(m=>m.answer)?.answer?.units[0]?.sourceRefIds.length) throw new Error('sentence citation missing');
const restored = getReport(db,{anchorItemId:'i1',lang:'en'}); if (restored?.id !== first.id || answers !== 1) throw new Error('restore generated again');
const second = await askReport(db,provider,dir,first.id,'What happens next?','request-2',false,e=>events.push(e));
if (second.messages.filter(m=>m.role==='assistant'&&m.status==='complete').length !== 2) throw new Error('follow-up not persisted');
await askReport(db,provider,dir,first.id,'duplicate','request-2',false,e=>events.push(e)); if (answers !== 2) throw new Error('duplicate request charged twice');
const controller = new AbortController();
const cancelling = askReport(db,provider,dir,first.id,'Cancel this answer','request-cancel',false,e=>events.push(e),controller.signal);
setTimeout(()=>controller.abort(),10);
const cancelled = await cancelling;
if (!cancelled.messages.some(m=>m.question==='Cancel this answer'&&m.status==='complete')
  || !cancelled.messages.some(m=>m.role==='assistant'&&m.status==='cancelled')) throw new Error('cancelled turn not persisted');
const afterCancel = await askReport(db,provider,dir,first.id,'Can I continue?','request-after-cancel',false,e=>events.push(e));
if (!afterCancel.messages.some(m=>m.question==='Can I continue?') || !events.some(e=>e.type==='cancelled')) throw new Error('conversation did not recover after cancellation');
const restarted = await startReport(db,provider,dir,{anchorItemId:'i1',itemIds:['i1'],topic:'Transit line',lang:'en',restart:true,requestId:'request-3'},e=>events.push(e));
if (restarted.id === first.id) throw new Error('restart reused old conversation');
failNext = true;
const failed = await startReport(db,provider,dir,{anchorItemId:'i2',itemIds:['i2'],topic:'Vote',lang:'en',requestId:'request-fail'},e=>events.push(e));
if (!failed.messages.some(m=>m.status==='failed')) throw new Error('failure not recorded');
const retried = await startReport(db,provider,dir,{anchorItemId:'i2',itemIds:['i2'],topic:'Vote',lang:'en',requestId:'request-retry'},e=>events.push(e));
if (retried.id === failed.id || !retried.messages.some(m=>m.status==='complete')) throw new Error('failed report was restored instead of retried');
console.log('✅ 完整材料、逐句引用、追问、恢复、重复点击、取消后续问与重新开始、失败后重开不会卡在失败页');
db.close(); rmSync(dir,{recursive:true,force:true});
