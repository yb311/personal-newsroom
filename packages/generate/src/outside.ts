import { createHash } from 'node:crypto';
import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { localDateKey, log } from '@pnr/core';
import type { Watch } from '@pnr/watch';

export interface OutsideSuggestion { label: string; intent: string; keywords: string[] }
export interface OutsidePick { id: string; date: string; lang: string; mode: 'ai'|'local'; title: string; reason: string; itemIds: string[]; suggestion: OutsideSuggestion; createdAt: number }
type Item = { id:string; title:string; snippet:string|null; publishedAt:number; lang:string|null; sourceName:string; domain:string|null };

const SCHEMA = { type:'object', properties:{ picks:{ type:'array', maxItems:5, items:{ type:'object', properties:{
  title:{type:'string'}, reason:{type:'string'}, itemIds:{type:'array',items:{type:'string'}}, suggestion:{type:'object',properties:{
    label:{type:'string'},intent:{type:'string'},keywords:{type:'array',items:{type:'string'}}
  },required:['label','intent','keywords'],additionalProperties:false}
},required:['title','reason','itemIds','suggestion'],additionalProperties:false }}},required:['picks'],additionalProperties:false } as const;

const setting = (db:Db,key:string):string => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value ?? '';
export function outsideEnabled(db:Db):boolean { return setting(db,'ai.outsidePicksEnabled') !== '0'; }
export function outsideFingerprint(db:Db,watches:Watch[],lang:string):string {
  return createHash('sha256').update(JSON.stringify({lang,reading:setting(db,'reader.languages'),watches:watches.filter(w=>w.active).map(w=>[w.id,w.intent,w.outputLang])})).digest('hex').slice(0,20);
}
const publisher = (item:Item):string => {
  const domain=(item.domain ?? item.sourceName).toLowerCase().replace(/^www\./,'');
  const parts=domain.split('.'); const suffix=parts.slice(-2).join('.');
  return /^(co|com|org|net)\.[a-z]{2}$/.test(suffix) ? parts.slice(-3).join('.') : suffix || item.sourceName.toLowerCase();
};
const words=(s:string):Set<string> => new Set((s.toLowerCase().match(/[a-z0-9]{3,}|[\u3400-\u9fff]{2,5}/g)??[]).filter(w=>!['the','and','for','with','from','this','that'].includes(w)));
const same=(a:Set<string>,b:Set<string>):boolean => { const n=[...a].filter(x=>b.has(x)).length; return n>=2 && n/Math.min(a.size||1,b.size||1)>=0.6; };

function rows(db:Db):Item[] {
  const reading=JSON.parse(setting(db,'reader.languages')||'[]') as string[];
  const language=reading.length ? `AND (i.lang IS NULL OR i.lang IN (${reading.map(()=>'?').join(',')}))` : '';
  return db.prepare(`SELECT i.id,i.title,i.snippet,i.published_at AS publishedAt,i.lang,s.name AS sourceName,s.domain FROM items i LEFT JOIN sources s ON s.id=i.source_id WHERE i.published_at>=? AND COALESCE(s.added_by,'')!='search' ${language} ORDER BY i.published_at DESC LIMIT 1000`).all(Date.now()-24*3600_000,...reading) as Item[];
}
function watchedIds(db:Db,watches:Watch[]):Set<string> {
  if(!watches.length)return new Set(); const ids=watches.map(w=>w.id);
  return new Set((db.prepare(`SELECT DISTINCT item_id AS id FROM matches WHERE passed_gate=1 AND watch_id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as {id:string}[]).map(r=>r.id));
}
function localPicks(items:Item[],seen:Set<string>,lang:string):OutsidePick[] {
  const clusters:{seed:Item;profile:Set<string>;items:Item[]}[]=[];
  for(const item of items){ if(seen.has(item.id))continue; const profile=words(item.title); const group=clusters.find(c=>Math.abs(c.seed.publishedAt-item.publishedAt)<18*3600_000&&same(c.profile,profile)); if(group)group.items.push(item); else clusters.push({seed:item,profile,items:[item]}); }
  return clusters.filter(c=>new Set(c.items.map(publisher)).size>=3).sort((a,b)=>new Set(b.items.map(publisher)).size-new Set(a.items.map(publisher)).size||b.seed.publishedAt-a.seed.publishedAt).slice(0,5).map((c,i)=>({
    id:`outside-${localDateKey()}-local-${i}`,date:localDateKey(),lang,mode:'local',title:c.seed.title,
    reason:lang.startsWith('zh')?`${new Set(c.items.map(publisher)).size} 家独立媒体正在报道这件事。`:`${new Set(c.items.map(publisher)).size} independent publishers are reporting this event.`,itemIds:c.items.map(x=>x.id),
    suggestion:{label:c.seed.title.slice(0,40),intent:lang.startsWith('zh')?`我想持续关注：${c.seed.title}`:`I want to keep following: ${c.seed.title}`,keywords:[...c.profile].slice(0,8)},createdAt:Date.now()
  }));
}

/** 关注之外 is part of the daily paper: written once a day, again only when
 *  the watches, reading languages or output language change. */
const OUTSIDE_DONE = 'outside.lastRun';
export function outsideDue(db:Db,watches:Watch[],lang:string):boolean {
  return outsideEnabled(db) && setting(db,OUTSIDE_DONE) !== `${localDateKey()}|${outsideFingerprint(db,watches,lang)}`;
}

export async function generateOutsidePicks(db:Db,provider:Provider|null,watches:Watch[],lang:string):Promise<OutsidePick[]> {
  if(!outsideEnabled(db))return []; const items=rows(db); const seen=watchedIds(db,watches); const fp=outsideFingerprint(db,watches,lang); const date=localDateKey();
  let picks:OutsidePick[]=[]; let aiFailed=false;
  if(provider&&items.length){
    try {
      const header=['Find 3-5 important events from the last 24 hours that are outside every enabled watch. Fewer is correct when evidence is weak.',`OUTPUT_LANGUAGE: ${lang}`,'WATCHES (original user wording):',...watches.map(w=>`${w.id}|${w.label}|${w.intent}`),'ARTICLES:'];
      const lines=items.map(i=>`${i.id}|${i.lang??''}|${i.sourceName}|${i.title}|${i.snippet??''}`); const budget=Math.max(8_000,provider.limits.write.maxInputTokens*3-header.join('\n').length-6_000);
      const chunks:string[][]=[]; let chunk:string[]=[]; let size=0; for(const line of lines){ if(chunk.length&&size+line.length>budget){chunks.push(chunk);chunk=[];size=0;} chunk.push(line);size+=line.length; } if(chunk.length)chunks.push(chunk);
      const raw:any[]=[]; for(const part of chunks){ const result=await provider.generate<{picks:any[]}>([...header,...part].join('\n'),{schema:SCHEMA as unknown as Record<string,unknown>,model:provider.writeModel,temperature:0.2,operation:'outside_picks'}); raw.push(...(result.data.picks??[])); }
      let candidates=raw;
      if(chunks.length>1&&raw.length){ const merged=await provider.generate<{picks:any[]}>(['Merge duplicate events from these batch candidates and choose at most 5. Preserve only supplied article ids.',`OUTPUT_LANGUAGE: ${lang}`,JSON.stringify(raw)].join('\n'),{schema:SCHEMA as unknown as Record<string,unknown>,model:provider.writeModel,temperature:0,operation:'outside_picks_merge'}); candidates=merged.data.picks??[]; }
      const valid=new Map(items.map(i=>[i.id,i])); picks=candidates.flatMap((p:any,i:number):OutsidePick[]=>{ const ids:string[]=[...new Set<string>(((p.itemIds??[]) as unknown[]).map(String).filter((id:string)=>valid.has(id)&&!seen.has(id)))]; if(!ids.length)return[]; return [{id:`outside-${date}-ai-${i}`,date,lang,mode:'ai',title:String(p.title).trim(),reason:String(p.reason).trim(),itemIds:ids,suggestion:{label:String(p.suggestion?.label??p.title).trim(),intent:String(p.suggestion?.intent??'').trim(),keywords:((p.suggestion?.keywords??[]) as unknown[]).map(String).slice(0,12)},createdAt:Date.now()}]; }).filter(p=>p.title&&p.reason).slice(0,5);
    } catch(error){ aiFailed=true; log({event:'outside.generate',phase:'failed',reasonDetail:String(error).slice(0,160)}); }
  }
  if(aiFailed){ const existing=readOutsidePicks(db,watches,lang); if(existing.length)return existing; }
  if(!picks.length)picks=localPicks(items,seen,lang);
  if(!picks.length){ const existing=readOutsidePicks(db,watches,lang); if(existing.length)return existing; }
  db.transaction(()=>{ if(provider&&!aiFailed) db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(OUTSIDE_DONE,`${date}|${fp}`,Date.now());
    db.prepare('DELETE FROM outside_picks WHERE edition_date=? AND lang=?').run(date,lang); const ins=db.prepare('INSERT INTO outside_picks (id,edition_date,lang,mode,event_title,importance_reason,item_ids_json,suggestion_json,config_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'); for(const p of picks)ins.run(p.id,date,lang,p.mode,p.title,p.reason,JSON.stringify(p.itemIds),JSON.stringify(p.suggestion),fp,p.createdAt); })();
  return picks;
}

export function readOutsidePicks(db:Db,watches:Watch[],lang:string):OutsidePick[]{
  if(!outsideEnabled(db))return[]; const fp=outsideFingerprint(db,watches,lang);
  return (db.prepare('SELECT id,edition_date AS date,lang,mode,event_title AS title,importance_reason AS reason,item_ids_json AS itemIds,suggestion_json AS suggestion,created_at AS createdAt FROM outside_picks WHERE edition_date=? AND lang=? AND config_fingerprint=? ORDER BY created_at DESC').all(localDateKey(),lang,fp) as any[]).map(r=>({...r,itemIds:JSON.parse(r.itemIds),suggestion:JSON.parse(r.suggestion)}));
}
