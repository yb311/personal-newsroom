import { openDb, readBody } from '../packages/store/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';
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
// The app's own IPC layer, so the preview shows exactly what the app would.
const api = createApi(db, DIR);
const ws = api.watches() as { id: string }[];
const flashes = api.flashes(48);
const timelines: any = {}; for (const w of ws) timelines[w.id] = api.watchTimeline(w.id);
const watchItems: any = {}; for (const w of ws) watchItems[w.id] = api.watchItems(w.id, 80);
writeFileSync(new URL('../apps/desktop/dist/renderer/mock.json', import.meta.url), JSON.stringify({
  sources, items, bodies,
  cat: q('SELECT id,name,kind,category,country,domain,enabled,NULL lastError,0 unread,0 total FROM sources ORDER BY enabled DESC,name LIMIT 300'),
  watches: ws, presets: api.presets(), presetsEn: api.presets('en'),
  today: api.today(), headlines: api.headlines(24, 4),
  timelines, watchItems, flashes, ai: { available: true, provider: 'gemini', outputLang: 'zh-CN', searchFillEnabled: true }
}));
console.log(`导出：${items.length} 条 · ${flashes.length} 快讯 · ${ws.length} 关注`);
db.close();
