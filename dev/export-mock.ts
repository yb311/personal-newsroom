import { openDb, readBody } from '../packages/store/src/index.ts';
import { listWatches, PRESETS } from '../packages/watch/src/index.ts';
import { newSinceYesterday, timeline, getDigest, recentFlashes } from '../packages/generate/src/index.ts';
import { writeFileSync } from 'node:fs';
const DIR = process.env.PNR_DATA_DIR!;
const db = openDb(`${DIR}/newsroom.db`);
const q = (s: string, ...a: any[]) => db.prepare(s).all(...a) as any[];
const sources = q(`SELECT s.id,s.name,s.kind,s.category,s.country,s.domain,s.enabled,s.last_error lastError,
  COUNT(i.id) total, SUM(CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END) unread
  FROM sources s LEFT JOIN items i ON i.source_id=s.id LEFT JOIN reading_state r ON r.item_id=i.id
  WHERE s.enabled=1 GROUP BY s.id ORDER BY s.name`);
const items = q(`SELECT i.id,i.title,i.url,i.published_at publishedAt,i.snippet,i.image_url imageUrl,i.author,
  s.name sourceName,s.id sourceId,i.body_state bodyState,i.body_words bodyWords,s.domain,
  NULL readAt,NULL starredAt,i.body_path bodyPath,i.body_error bodyError,i.lang
  FROM items i JOIN sources s ON s.id=i.source_id ORDER BY (i.body_state='ok') DESC, i.published_at DESC LIMIT 140`);
const bodies: any = {};
for (const it of items) {
  const b = readBody(it.bodyPath);
  if (b) bodies[it.id] = { html: b.html, words: b.words, source: b.source };
}
const ws = listWatches(db).map(w => ({ ...w, newCount: newSinceYesterday(db,w.id).length,
  timelineCount: timeline(db,w.id).length,
  passed: (db.prepare('SELECT COUNT(*) c FROM matches WHERE watch_id=? AND passed_gate=1').get(w.id) as any).c }));
const labels = new Map(ws.map(w=>[w.id,w.label]));
const flashes = recentFlashes(db, 48).map(f=>({...f, watchLabel: labels.get(f.watchId ?? '') ?? null}));
const deeps: any = {};
for (const r of q('SELECT item_id itemId, body_json b, sources_json s FROM deep_summaries')) {
  const parsed = JSON.parse(r.b);
  deeps[r.itemId] = { blocks: parsed.blocks, milestones: parsed.milestones ?? [], sources: JSON.parse(r.s) };
}
const d = new Date().toISOString().slice(0,10);
const timelines: any = {}; for (const w of ws) timelines[w.id] = { milestones: timeline(db,w.id), items: [] };
writeFileSync(new URL('../apps/desktop/dist/renderer/mock.json', import.meta.url), JSON.stringify({
  sources, items, bodies,
  cat: q('SELECT id,name,kind,category,country,domain,enabled,NULL lastError,0 unread,0 total FROM sources ORDER BY enabled DESC,name LIMIT 300'),
  watches: ws, presets: PRESETS.map(p=>({...p, enabled: ws.some(w=>w.id===p.id)})),
  today: { date: d, digest: getDigest(db, d), changes: ws.filter(w=>w.active).map(w=>({watchId:w.id,label:w.label,milestones:newSinceYesterday(db,w.id)})).filter(x=>x.milestones.length>0) },
  timelines, flashes, deeps, ai: { available: true, provider: 'gemini', outputLang: 'zh-CN' }
}));
console.log(`导出：${items.length} 条 · ${flashes.length} 快讯 · ${Object.keys(deeps).length} 篇深度 · ${ws.length} 关注`);
db.close();
