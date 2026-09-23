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
  const read = new Set(), star = new Set(); const chats = []; const listeners = [];
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
    setSourceEnabled: async () => {}, catalogue: async () => ({ rows: d.cat, total: d.cat.length, categories: [], countries: [] }),
    countItems: async (o) => d.items.filter(i => !o.sourceId || i.sourceId === o.sourceId).length,
    readingLanguages: async () => ({ available: [], selected: [] }), setReadingLanguages: async () => {},
    stats: async () => ({items: d.items.length, sources: d.sources.length, unread: d.items.length, lastRun: Date.now()}),
    refresh: async () => ({busy:false, inserted:0}), enrichOne: async () => null,
    openExternal: async () => {}, onProgress: () => () => {},
    aiStatus: async () => d.ai, saveAiSettings: async () => ({ mode: 'none', connected: false }),
    presets: async (l) => l && l.startsWith('en') ? d.presetsEn : d.presets, watches: async () => d.watches,
    // ?lang=en previews the English interface.
    uiLanguage: async () => { const l = window.__ui ?? (new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh-CN'); return { choice: l, resolved: l }; },
    setUiLanguage: async (c) => { window.__ui = c; return { choice: c, resolved: c === 'en' ? 'en' : 'zh-CN' }; },
    scheduleState: async () => ({ enabled: false, dailyHour: 7, flashIntervalHours: 3, status: 'disabled', mode: 'launchAgent', lastRun: null }),
    socialStatus: async () => ({ instanceUrl: null, pack: { installed: false } }), onSocialProgress: () => () => {},
    hasApifyToken: async () => false, rssHubReady: async () => false, rsshubRoutes: async () => [],
    addWatch: async () => d.watches[0], editWatch: async () => d.watches[0],
    removeWatch: async () => {}, togglePreset: async () => {}, correct: async () => {},
    today: async (date) => (date && d.pastEditions?.[date]) || d.today, editions: async () => d.editions ?? [],
    headlines: async () => d.headlines, itemRefs: async () => [],
    watchTimeline: async (id) => d.timelines[id] ?? {milestones:[],items:[]},
    watchItems: async (id) => d.watchItems[id] ?? [], runWatch: async () => ({ mode: 'keywords', watches: 1 }),
    addPresets: async () => [], backgroundPrompt: async () => false, dismissBackgroundPrompt: async () => {},
    runWatches: async () => ({busy:false, watches:d.watches.length, digest:true}),
    runFlashes: async () => ({busy:false, published:0}),
    flashes: async () => d.flashes,
    setAiOption: async () => {},
    openSettings: async (section) => { window.open('./preview.html#settings' + (section ? ':' + section : ''), '_blank', 'width=720,height=580'); },
    broadcast: async () => {}, copyText: async () => {}, onUiLanguage: () => () => {},
    contextMenu: async (items) => { console.log('menu', items.map(i => i.label).filter(Boolean).join(' | ')); return null; },
    reportGet: async () => null, reportCancel: async () => true, onReportEvent: () => () => {}, reportAsk: async () => ({ error: 'preview' }),
    reportStart: async (input) => { await new Promise(r => setTimeout(r, 600)); const it = d.items.find(i => i.id === input.anchorItemId) ?? d.items[0];
      return { conversation: { id: 'c1', anchorItemId: it.id, lang: 'zh-CN', topic: input.topic, initialItemIds: [it.id], createdAt: Date.now(), updatedAt: Date.now(),
        sources: d.items.slice(0, 3).map((x, i) => ({ refId: 's' + (i + 1), itemId: x.id, basis: 'article', title: x.title, url: x.url, publisher: x.sourceName, publishedAt: x.publishedAt, materialText: '' })),
        messages: [{ id: 'q', sequence: 1, role: 'user', question: input.topic, answer: null, status: 'complete', model: null },
          { id: 'a', sequence: 2, role: 'assistant', question: null, status: 'complete', model: 'x', answer: { title: it.title, units: [
            { kind: 'paragraph', text: (it.snippet ?? it.title), sourceRefIds: ['s1'], supported: true },
            { kind: 'timeline', text: d.items[1].title, sourceRefIds: ['s2'], supported: true },
            { kind: 'timeline', text: d.items[2].title, sourceRefIds: ['s3'], supported: true }] } }] } }; },
    // The assistant answers from the first few articles, so the panel can be seen working.
    assistantList: async () => chats.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
    assistantGet: async (id) => chats.find(c => c.id === id) ?? null,
    assistantDelete: async (id) => { const i = chats.findIndex(c => c.id === id); if (i >= 0) chats.splice(i, 1); return true; },
    assistantCancel: async () => true, onAssistantEvent: (cb) => { listeners.push(cb); return () => {}; },
    assistantAsk: async (input) => {
      let chat = chats.find(c => c.id === input.chatId);
      if (!chat) { chat = { id: 'chat-' + Date.now(), title: input.question, lang: 'zh-CN', createdAt: Date.now(), updatedAt: Date.now(), messages: [], sources: [] }; chats.unshift(chat); }
      for (const phase of ['library', input.web ? 'web' : 'writing', 'writing']) {
        listeners.forEach(cb => cb({ requestId: input.requestId, chatId: chat.id, messageId: 'm', type: 'phase', phase }));
        await new Promise(r => setTimeout(r, 400));
      }
      const picked = d.items.slice(0, 3);
      picked.forEach((it, i) => { if (!chat.sources.some(s => s.url === it.url)) chat.sources.push({ refId: 's' + (chat.sources.length + 1), kind: i === 2 && input.web ? 'web' : 'library', itemId: it.id, title: it.title, url: it.url, publisher: it.sourceName, publishedAt: it.publishedAt }); });
      const refs = chat.sources.slice(-3).map(s => s.refId);
      const n = chat.messages.length;
      chat.messages.push({ id: 'u' + n, sequence: n + 1, role: 'user', content: input.question, answer: null, status: 'complete', web: input.web, error: null });
      chat.messages.push({ id: 'a' + n, sequence: n + 2, role: 'assistant', content: null, status: 'complete', web: input.web, error: null, answer: { units: [
        { kind: 'paragraph', text: picked[0].title + '。', sourceRefIds: [refs[0]], supported: true },
        { kind: 'listItem', text: picked[1].title, sourceRefIds: [refs[1]], supported: true },
        { kind: 'listItem', text: picked[2].title, sourceRefIds: [refs[2]], supported: true },
        { kind: 'paragraph', text: '背景信息示例。', sourceRefIds: [], supported: false }] } });
      chat.updatedAt = Date.now();
      return { chat: structuredClone(chat) };
    }
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
