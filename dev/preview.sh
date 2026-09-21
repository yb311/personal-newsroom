#!/bin/bash
# Renders the built UI in a plain browser against a snapshot of a real database.
# The renderer only ever talks to window.pnr, so stubbing that is enough to see
# the real components with real content — no Electron, no screen recording.
#
#   PNR_DATA_DIR=/path/to/data dev/preview.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/desktop/dist/renderer"
: "${PNR_DATA_DIR:?set PNR_DATA_DIR to a data directory}"

node --experimental-strip-types "$ROOT/dev/export-mock.ts" 2>&1 | grep -v "Warning\|Type Stripping" || true

cat > "$OUT/preview.html" <<'HTML'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>preview</title></head>
<body><div id="root"></div>
<script>
(async () => {
  const d = await (await fetch('./mock.json')).json();
  const read = new Set(), star = new Set();
  window.pnr = {
    listSources: async () => d.sources,
    listItems: async (o) => d.items
      .filter(i => !o.sourceId || i.sourceId === o.sourceId)
      .filter(i => o.filter !== 'unread' || !read.has(i.id))
      .filter(i => o.filter !== 'starred' || star.has(i.id))
      .map(i => ({...i, readAt: read.has(i.id)?Date.now():null, starredAt: star.has(i.id)?Date.now():null})),
    getItem: async (id) => { const i = d.items.find(x=>x.id===id); return i ? {...i, body: d.bodies[id] ?? null} : null; },
    markRead: async (id) => { read.add(id); },
    toggleStar: async (id) => { star.has(id) ? star.delete(id) : star.add(id); return star.has(id); },
    setSourceEnabled: async () => {}, catalogue: async () => d.cat,
    countItems: async (o) => d.items.filter(i => !o.sourceId || i.sourceId === o.sourceId).length,
    readingLanguages: async () => ({ available: [], selected: [] }), setReadingLanguages: async () => {},
    stats: async () => ({items: d.items.length, sources: d.sources.length, unread: d.items.length, lastRun: Date.now()}),
    refresh: async () => ({busy:false, inserted:0}), enrichOne: async () => null,
    openExternal: async () => {}, onProgress: () => () => {},
    aiStatus: async () => d.ai, saveAiSettings: async () => ({ mode: 'none', connected: false }),
    presets: async () => d.presets, watches: async () => d.watches,
    addWatch: async () => d.watches[0], editWatch: async () => d.watches[0],
    removeWatch: async () => {}, togglePreset: async () => {}, correct: async () => {},
    today: async () => d.today, headlines: async () => d.headlines, itemRefs: async () => [],
    watchTimeline: async (id) => d.timelines[id] ?? {milestones:[],items:[]},
    watchItems: async () => [],
    runWatches: async () => ({busy:false, watches:d.watches.length, digest:true}),
    runFlashes: async () => ({busy:false, published:0}),
    flashes: async () => d.flashes,
    deepSummary: async (id) => d.deeps[id] ? {summary: d.deeps[id]} : {error:'这条还没生成过深度总结'}
  };
  const html = await (await fetch('./index.html')).text();
  const l = document.createElement('link'); l.rel='stylesheet';
  l.href = html.match(/href="([^"]*index-[^"]*\.css)"/)[1]; document.head.appendChild(l);
  const s = document.createElement('script'); s.type='module';
  s.src = html.match(/src="([^"]*index-[^"]*\.js)"/)[1]; document.body.appendChild(s);
})();
</script></body></html>
HTML

lsof -ti:8899 >/dev/null 2>&1 || (cd "$OUT" && nohup python3 -m http.server 8899 >/dev/null 2>&1 & sleep 1)
echo "预览: http://127.0.0.1:8899/preview.html"
