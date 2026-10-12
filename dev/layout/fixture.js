/*
 * Browser side of the layout test: a stand-in for `window.pnr` (the bridge the
 * main process normally provides) backed by made-up data, so the real
 * components render with no database, no network and no AI.
 *
 * The data is chosen to be awkward on purpose: long and short names, Chinese and
 * English, a source with a duplicate name, many categories, long titles. A
 * layout that survives this fixture survives real feeds.
 *
 * `window.__fx` is the test's handle on the stub: it can hold a call open
 * (`hold`) to reproduce a slow refresh, and read what was called (`calls`).
 */
(() => {
  const cfg = window.__layoutConfig;
  const now = Date.now();
  const H = 3600e3;

  const names = [
    ['BBC News', 'international'], ['CNBC', 'international'], ['Deutsche Welle', 'international'],
    ['Deutsche Welle 英文', 'international'], ['France 24', 'international'], ['The Guardian', 'international'],
    ['半岛电视台', 'international'], ['南华早报', 'international'], ['路透社', 'international'],
    ['The Japan Times', 'asia'], ['The Straits Times Singapore Edition', 'asia'],
    ['哔哩哔哩 · 每周必看', 'custom'], ['知乎 · 知乎日报', 'custom'], ['豆瓣 · 即将上映', 'custom']
  ];
  const titles = [
    'Oil gains over 1% as Trump rejects Iranian proposal to reopen Hormuz Strait',
    'India’s TakeMe2Space to launch orbital computing satellite on SpaceX rocket',
    '一个夜晚与三个夏天：这部电影为什么值得在影院里看，而不是在手机上刷',
    'Com 31,9% das urnas apuradas, Flávio lidera com 50,74% contra 41,14% de Lula',
    '14亿人口，为何选不出一个好球队？经济学给出了答案',
    'Wife of Malaysia’s longest-serving PM Mahathir dies at 100',
    '泡泡玛特与段永平的“伟大操盘”（还有拆手办）',
    'FIA to investigate software bug after Bahrain GP in Malaysia'
  ];
  const sources = names.map(([name, category], i) => ({
    id: `s${i}`, name, kind: i >= 11 ? 'rsshub' : 'rss', category, country: i >= 9 ? 'JP' : null, domain: `example${i}.com`,
    enabled: 1, unread: 0, total: 0, lastError: null, newest: now
  }));
  const items = [];
  sources.forEach((s, si) => {
    for (let n = 0; n < 14; n++) {
      const title = titles[(si + n) % titles.length];
      items.push({
        id: `i${si}-${n}`, title, url: `https://example${si}.com/${n}`, publishedAt: now - (si * 20 + n * 7) * 60e3,
        snippet: `${title}。这是摘要的第二句，用来占满两行，检查列表行的省略号和行距是否正常，也检查长句子的换行。`,
        imageUrl: null, author: null, sourceName: s.name, sourceId: s.id, domain: s.domain,
        bodyState: 'ok', bodyWords: 520, readAt: n % 3 === 0 ? now : null, starredAt: null,
        lang: (si + n) % 5 === 3 ? 'pt' : (title.charCodeAt(0) > 255 ? 'zh' : 'en')
      });
    }
  });
  items.sort((a, b) => b.publishedAt - a.publishedAt);
  const read = new Set(items.filter((i) => i.readAt).map((i) => i.id));
  const withState = (i) => ({ ...i, readAt: read.has(i.id) ? now : null });
  const counted = () => sources.map((s) => {
    const own = items.filter((i) => i.sourceId === s.id);
    return { ...s, total: own.length, unread: own.filter((i) => !read.has(i.id)).length };
  });
  const scoped = (o) => items.filter((i) => (!o.sourceId || i.sourceId === o.sourceId)
    && (o.filter !== 'unread' || !read.has(i.id))).map(withState);

  // An article body as the reader core hands it over: paragraphs, and the wide things
  // pages put in them (a big picture, a long unbroken line, a table, a long link).
  const wide = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="#ccc"/></svg>`;
  const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>${titles[i % titles.length]}。${'正文第二句，用来撑满一行并换行。 Body text that keeps going. '.repeat(3)}</p>`).join('')
    + `<figure><img src="data:image/svg+xml,${encodeURIComponent(wide)}" width="1600" height="400" alt=""><figcaption>${'A long caption. '.repeat(8)}</figcaption></figure>`
    + `<pre>${'const veryLongLineOfCode = 1; '.repeat(12)}</pre>`
    + `<table><tr>${Array.from({ length: 8 }, (_, i) => `<th>Column ${i}</th>`).join('')}</tr><tr>${Array.from({ length: 8 }, () => '<td>some value</td>').join('')}</tr></table>`
    + `<p><a href="https://example.com/${'a-very-long-path-segment-'.repeat(8)}">https://example.com/${'a-very-long-path-segment-'.repeat(8)}</a></p>`
    + `<blockquote>${'Quoted words that go on for a while. '.repeat(6)}</blockquote>`;
  // Blocks marked as the main process marks them (segmentHtml), so translations have somewhere to go.
  let blockCount = 0;
  const marked = paragraphs.replace(/<(p|figcaption|th|td|blockquote)>([\s\S]*?)<\/\1>/g,
    (_m, tag, inner) => `<${tag} data-pnr-b="${blockCount++}"><span class="pnr-o">${inner}</span></${tag}>`);
  /** A translation as long as the text, mixed scripts as in the titles. */
  const translation = () => ({ target: 'zh-CN', title: `${titles[1]}（译文标题，故意写得很长，用来检查换行）`, total: blockCount,
    blocks: Object.fromEntries(Array.from({ length: blockCount }, (_, i) => [i, `译文第 ${i + 1} 段。${'这是一段比原文更长的译文，用来检查排版会不会被撑开。 '.repeat(3)}`])) });

  const watches = [
    { id: 'w1', origin: 'intent', label: '习近平最近在干什么', intent: '我想知道习近平最近在干什么', outputLang: null, active: true, keywords: ['习近平'], sensitivity: 'balanced',
      recallAids: null, lastRunAt: now - H, newCount: 2, timelineCount: 3, candidates: 10, passed: 4, openQuestions: 0 },
    { id: 'w2', origin: 'preset', label: 'Artificial intelligence and cybersecurity policy', intent: 'AI and cyber policy', outputLang: null, active: true, keywords: [], sensitivity: 'balanced',
      recallAids: null, lastRunAt: now - 5 * H, newCount: 0, timelineCount: 1, candidates: 4, passed: 1, openQuestions: 0 }
  ];
  const flashes = [0, 1, 2].map((n) => ({
    id: `f${n}`, watchIds: ['w1'], watchLabels: ['习近平最近在干什么'], watches: [{ id: 'w1', label: '习近平最近在干什么' }],
    publishedAt: now - n * H, itemPublishedAt: now - n * H, itemIds: [`i0-${n}`], title: titles[n], body: titles[n] + '。' + '正文。'.repeat(20),
    importance: 3, importanceReason: null, category: null, basis: 'article', followUpOf: null, followUp: null,
    sources: [{ id: `i0-${n}`, title: titles[n], url: 'https://example0.com', publishedAt: now, sourceName: 'BBC News' }], searchSources: []
  }));

  // A conversation with answers, citations and the cards of an agent's proposed changes, so the
  // assistant is checked with content in it, not only as an empty panel.
  const card = (n, tool, risk, status, view) => ({ id: `act${n}`, messageId: 'a1', sequence: n, tool, risk, args: {}, status, view, error: null, undoable: false, expired: false, createdAt: now });
  const chat = {
    id: 'c1', title: '关注美国大选', lang: 'zh-CN', createdAt: now, updatedAt: now,
    sources: [
      { refId: 's1', kind: 'library', itemId: 'i0-0', title: titles[0], url: 'https://example0.com/a', publisher: 'BBC News', publishedAt: now },
      { refId: 's2', kind: 'web', itemId: null, title: titles[2], url: 'https://example.org/b', publisher: 'example.org with a rather long name', publishedAt: now }
    ],
    messages: [
      { id: 'u1', sequence: 1, role: 'user', content: '我想知道习近平最近在干什么，顺便帮我关注美国大选和人工智能的监管动向', answer: null, status: 'complete', web: true, error: null, screenLabel: 'The Straits Times Singapore Edition', actions: [] },
      { id: 'a1', sequence: 2, role: 'assistant', content: null, status: 'complete', web: true, error: null, screenLabel: null,
        actions: [
          card(0, 'list_watches', 'read', 'done', null),
          card(1, 'create_watch', 'write', 'proposed', { subject: '美国大选', fields: [{ key: 'label', value: '美国大选', editable: true }, { key: 'intent', value: '我想知道美国大选的最新进展和各方的动向', editable: true }, { key: 'keywords', value: '美国大选、US Election、Electoral College' }] }),
          card(2, 'update_watch', 'write', 'proposed', { subject: '人工智能与网络安全', fields: [{ key: 'sensitivity', before: 'balanced', value: 'more' }, { key: 'intent', before: '人工智能', value: 'AI safety news only', editable: true, warn: true }] }),
          card(3, 'delete_watch', 'danger', 'proposed', { subject: '太空探索', fields: [{ key: 'intent', value: '太空探索的进展' }] })
        ],
        answer: { units: [
          { kind: 'paragraph', text: titles[0] + '。', sourceRefIds: ['s1'], supported: true },
          { kind: 'listItem', text: titles[2], sourceRefIds: ['s2'], supported: true },
          { kind: 'note', text: '请确认下面的改动。', sourceRefIds: [], supported: false }
        ] } }
    ]
  };

  const ai = (on) => ({
    available: on, provider: 'gemini', outputLang: 'zh-CN', hasGeminiKey: on, hasOpenAiKey: false, hasAnthropicKey: false, hasCompatibleKey: false,
    compatibleEndpoint: '', writeModel: '', fastModel: '', embedModel: '', contextTokens: '', ollamaHost: '', ollamaWriteModel: '', ollamaFastModel: '',
    ollamaEmbedModel: '', searchFillEnabled: true, outsidePicksEnabled: true, webSearch: on,
    translate: { target: 'zh-CN', choice: '', auto: false, selection: true },
    defaults: { gemini: { write: 'a', fast: 'b' }, openai: { write: 'a', fast: 'b' }, anthropic: { write: 'a', fast: 'b' } }
  });

  // Menu commands go to every window component that listens, as the main process's broadcast does.
  const commands = new Set();
  const fx = window.__fx = { calls: [], gate: {}, command: (c) => { for (const cb of [...commands]) cb(c); }, lang: cfg.lang, ai: cfg.ai, packReady: cfg.packReady };
  const waitIfHeld = async (name) => { if (fx.gate[name]) await fx.gate[name]; };
  /** Holds every call of `name` until the returned function is called — a slow network, on demand. */
  fx.block = (name) => { let open; fx.gate[name] = new Promise((r) => { open = r; }); return () => { delete fx.gate[name]; open(); }; };

  const handlers = {
    uiLanguage: async () => ({ choice: fx.lang, resolved: fx.lang }),
    aiStatus: async () => ai(fx.ai),
    listSources: async () => counted(),
    listItems: async (o) => scoped(o).slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? 60)),
    countItems: async (o) => scoped(o).length,
    getItem: async (id) => { const i = items.find((x) => x.id === id); return i ? { ...withState(i), body: { html: marked, words: 520, source: 'page' }, bodyError: null, translation: { target: 'zh-CN', title: null, blocks: {}, total: blockCount } } : null; },
    translateItem: async () => ({ ok: true, translation: translation() }),
    translateText: async (text) => ({ ok: true, to: 'zh-CN', text: `${text}（译文）`.repeat(2) }),
    translateTexts: async (texts) => ({ ok: true, texts: texts.map((x) => `${x}（译文）`) }),
    markRead: async (id, v) => { v ? read.add(id) : read.delete(id); },
    toggleStar: async () => true,
    stats: async () => ({ items: items.length, sources: sources.length, unread: items.length, lastRun: now - 60e3 }),
    refresh: async () => { fx.calls.push('refresh'); await waitIfHeld('refresh'); return { busy: false, inserted: 0 }; },
    runAll: async () => ({ busy: false, fetched: 0 }),
    runFlashes: async () => ({ busy: false, flashes: 0 }),
    watches: async () => watches,
    watchTimeline: async () => ({ milestones: [
      { id: 'm1', watchId: 'w1', occurredOn: '2026-10-02', summary: titles[0], itemIds: ['i0-0'], firstSeenAt: now, isNew: true },
      { id: 'm2', watchId: 'w1', occurredOn: '2026-09-28', summary: titles[2], itemIds: ['i0-1'], firstSeenAt: now - 90 * H, isNew: false }
    ], refs: [{ id: 'i0-0', title: titles[0], url: 'https://example0.com', publishedAt: now, sourceName: 'BBC News' }], questions: [] }),
    watchItems: async () => [],
    watchSeen: async () => true,
    flashes: async () => flashes,
    today: async () => ({ date: '2026-10-04', digest: null, outside: [], refs: [], watches: [], watchCount: 0 }),
    editions: async () => [],
    headlines: async () => [],
    catalogue: async (o) => {
      const rows = cfg.feeds.filter((f) => !o?.q || f.name.toLowerCase().includes(o.q.toLowerCase())).slice(0, o?.limit ?? 300)
        .map((f) => ({ id: f.id, name: f.name, kind: f.kind ?? 'rss', category: f.category ?? null, country: f.country ?? null, domain: f.domain ?? null, enabled: f.enabled ? 1 : 0, lastError: null, unread: 0, total: 0 }));
      const tally = (key) => [...rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) ?? 0) + 1), new Map())].filter(([k]) => k).map(([k, n]) => ({ key: k, count: n }));
      return { rows, total: rows.length, categories: tally('category'), countries: tally('country') };
    },
    setSourceEnabled: async () => {},
    rsshubRoutes: async () => cfg.routes,
    rssHubReady: async () => fx.packReady,
    socialStatus: async () => ({ instanceUrl: null, pack: { installed: fx.packReady } }),
    previewRoute: async () => ({ ok: true, titles: ['示例标题一', '示例标题二'] }),
    matchRoute: async () => null,
    addSource: async () => ({ ok: true, id: 'new', name: '新来源', items: 3 }),
    readingLanguages: async () => ({ available: [], selected: [] }),
    backgroundPrompt: async () => false,
    presets: async () => [],
    assistantList: async () => [{ id: 'c1', title: chat.title, updatedAt: now }], assistantGet: async (id) => (id === 'c1' ? structuredClone(chat) : null), assistantMode: async () => 'ask',
    scheduleState: async () => ({ enabled: false, supported: false, status: 'unsupported', dailyHour: 7, flashIntervalHours: 3, lastRun: null, wake: { on: false, status: 'unsupported', next: null } }),
    updateState: async () => ({ phase: 'upToDate', current: '0.1.2', version: null, percent: null, reason: null, checkedAt: now, auto: true }),
    hasApifyToken: async () => false,
    contextMenu: async () => null
  };
  window.pnr = new Proxy(handlers, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'onCommand') return (cb) => { commands.add(cb); return () => commands.delete(cb); };
      if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => () => {};
      return async () => null;
    }
  });
})();
