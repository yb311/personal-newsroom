import { ChevronLeft, ChevronRight, CircleDot, ExternalLink, FileSearch, ListFilter, MessageSquareText, PanelLeft, Plus, RefreshCw, RotateCcw, Search, Star } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiStatus, ItemRow, MenuEntry, OutsidePick, ReportAnchor, SourceRow } from './types.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { ItemList } from './components/ItemList.tsx';
import { Reader } from './components/Reader.tsx';
import { Catalogue } from './components/Catalogue.tsx';
import { Today } from './components/Today.tsx';
import { Watches, type WatchRequest } from './components/Watches.tsx';
import { Flashes } from './components/Flashes.tsx';
import { BackgroundPrompt } from './components/BackgroundPrompt.tsx';
import { Assistant } from './components/Assistant.tsx';
import { Report } from './components/Report.tsx';
import { SplitDivider, storedWidth } from './components/SplitDivider.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ago } from './i18n.ts';
import type { WatchTab } from './components/Watches.tsx';

export type Filter = 'all' | 'unread' | 'starred';
export type Tab = 'today' | 'flashes' | 'watches' | 'read';
export const TABS: Tab[] = ['today', 'flashes', 'watches', 'read'];
/** Opens a deep report; every surface that shows news can start one. */
export type OpenReport = (anchor: ReportAnchor) => void;

/** The long operations the window starts. Each has one home: the control that starts it
 *  sits with what it updates, and only that control spins while it runs. */
type Job = 'fetch' | 'flashes' | 'daily';

/** How many articles the list loads at a time. */
const PAGE = 200;
const LIST = { min: 250, max: 460, fallback: 320, key: 'pnr.listWidth' };
const PANEL = { min: 320, max: 620, fallback: 380, key: 'pnr.assistantWidth' };
/** The sidebar's width, and the narrowest workspace that still splits list and
 *  detail side by side — keep in step with `.sidebar` and `@container workspace` in app.css. */
const SIDEBAR = 220;
const SPLIT_MIN = 620;
const readFlag = (key: string, fallback: boolean): boolean => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
};
const saveFlag = (key: string, on: boolean): void => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* optional */ } };

export default function App() {
  const { t, i18n } = useTranslation();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  /** Shown on request although it does not fit; cleared when the window resizes. */
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [listWidth, setListWidth] = useState(() => storedWidth(LIST.key, LIST.min, LIST.max, LIST.fallback));
  const [panelWidth, setPanelWidth] = useState(() => storedWidth(PANEL.key, PANEL.min, PANEL.max, PANEL.fallback));
  const [assistantOpen, setAssistantOpen] = useState(() => readFlag('pnr.assistantOpen', false));
  const [tab, setTab] = useState<Tab>('read');
  const [report, setReport] = useState<ReportAnchor | null>(null);
  const [restartReport, setRestartReport] = useState(0);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [current, setCurrent] = useState<ItemRow | null>(null);
  const [query, setQuery] = useState('');
  const [watchQuery, setWatchQuery] = useState('');
  const [importantOnly, setImportantOnly] = useState(false);
  const [counts, setCounts] = useState<{ flashes?: number; watches?: number; fresh?: number }>({});
  const [job, setJob] = useState<Job | null>(null);
  const busy = job !== null;
  const [note, setNote] = useState('');
  const [lastRun, setLastRun] = useState<number | null>(null);
  const [showCatalogue, setShowCatalogue] = useState(false);
  const [askBackground, setAskBackground] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const [watchRequest, setWatchRequest] = useState<WatchRequest | null>(null);
  const requestId = useRef(0);
  const operation = useRef(false);
  /** Set once the person picks a view, so the launch check below never overrides them. */
  const navigated = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aiReady = Boolean(ai?.available);

  const loadSources = useCallback(async () => setSources(await window.pnr.listSources()), []);
  const loadItems = useCallback(async () => {
    const request = ++requestId.current;
    const scope = { ...(sourceId ? { sourceId } : {}), filter };
    const [rows, count] = await Promise.all([window.pnr.listItems({ ...scope, limit: PAGE }), window.pnr.countItems(scope)]);
    if (request === requestId.current) { setItems(rows); setTotal(count); }
  }, [sourceId, filter]);
  const loadMore = async (): Promise<void> => {
    const request = requestId.current;
    const more = await window.pnr.listItems({ ...(sourceId ? { sourceId } : {}), filter, limit: PAGE, offset: items.length });
    if (request === requestId.current) setItems((prev) => [...prev, ...more.filter((m) => !prev.some((p) => p.id === m.id))]);
  };
  const loadAi = useCallback(async () => setAi(await window.pnr.aiStatus()), []);
  const loadStats = useCallback(async () => setLastRun((await window.pnr.stats()).lastRun), []);
  /** New developments across the watches: the badge on 关注, where they are told in full. */
  const loadFresh = useCallback(async () => {
    const ws = await window.pnr.watches();
    setCounts((c) => ({ ...c, fresh: ws.reduce((n, w) => n + (w.active ? w.newCount : 0), 0) }));
  }, []);

  useEffect(() => { void loadSources(); void loadAi(); }, [loadSources, loadAi]);
  useEffect(() => { void loadFresh(); }, [loadFresh, revision]);
  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    const resized = (): void => { setWindowWidth(window.innerWidth); setSidebarPinned(false); };
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);

  useEffect(() => window.pnr.onProgress((p) => {
    const x = p as { phase?: string; label?: string };
    const key = { watch: 'app.progress.watch', writing: 'app.progress.writing', extract: 'app.progress.extract', fetch: 'app.progress.fetch' }[x.phase ?? ''];
    if (key && operation.current) setNote(t(key, { label: x.label }));
  }), [t]);

  /** One long-running operation at a time; its outcome stays in the toolbar subtitle for a few seconds. */
  const perform = async (kind: Job, message: string, task: () => Promise<string>): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    clearTimeout(noticeTimer.current);
    setJob(kind); setNote(message);
    try { setNote(await task()); }
    catch { setNote(t('app.failed')); }
    finally {
      operation.current = false; setJob(null); setRevision((v) => v + 1);
      void loadStats();
      noticeTimer.current = setTimeout(() => setNote(''), 6000);
    }
  };
  const failure = (error: string): string => error.replace(/^Error:\s*/, '').slice(0, 80);
  const refresh = (): Promise<void> => perform('fetch', t('app.refreshing'), async () => {
    const r = await window.pnr.refresh();
    await Promise.all([loadSources(), loadItems()]);
    // First-run consent: once reading works, ask once about background updates.
    if (!r.busy && !r.error && await window.pnr.backgroundPrompt()) setAskBackground(true);
    return r.busy ? t('app.busy') : r.error ? t('app.refreshFailed', { error: failure(r.error) }) : t('app.refreshed', { count: r.inserted ?? 0 });
  });
  const runFlashes = (): Promise<void> => perform('flashes', t('app.flashChecking'), async () => {
    const r = await window.pnr.runFlashes();
    void loadItems(); void loadSources();
    return r.busy ? t('app.busy') : r.error ? t('app.runFailed', { error: failure(r.error) })
      : t('app.flashDone', { count: r.flashes ?? 0 }) + (r.failed ? t('app.partial', { count: r.failed }) : '');
  });
  /** Writes today's edition: fetch, update every watch, judge what is new, then the brief. */
  const runDaily = (): Promise<void> => perform('daily', t('app.briefWriting'), async () => {
    const r = await window.pnr.runWatches();
    void loadItems(); void loadSources();
    return r.busy ? t('app.busy') : r.error ? t('app.runFailed', { error: failure(r.error) })
      : r.mode === 'keywords' ? t('app.watchesKeywords', { count: r.watches ?? 0 })
      : (r.digest ? t('app.briefDone') : t('app.briefNone')) + (r.failed ? t('app.partial', { count: r.failed }) : '');
  });

  // First launch: fetch once so the app is not empty; open 今日 when a brief exists.
  useEffect(() => {
    void (async () => {
      const s = await window.pnr.stats();
      setLastRun(s.lastRun);
      if (s.items === 0 && s.sources > 0) void refresh();
      if ((await window.pnr.today()).digest && !navigated.current) setTab('today');
    })();
  }, []);

  const toggleAssistant = (open = !assistantOpen): void => {
    setAssistantOpen(open); saveFlag('pnr.assistantOpen', open);
    // Opening it is a request to ask something; it does not take focus at launch.
    if (open) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.assistant .composer textarea')?.focus());
  };
  const openSettings = (section?: string): void => { void window.pnr.openSettings(section); };

  // As a macOS split view does: the assistant docks while the workspace keeps
  // room for list and detail, and floats over it in a window too narrow for
  // that. The sidebar gives way first — it collapses while it does not fit and
  // returns when it does, unless it was hidden on purpose.
  const floating = assistantOpen && windowWidth - panelWidth - 1 < SPLIT_MIN;
  const docked = assistantOpen && !floating;
  const sidebarFits = windowWidth - SIDEBAR - 1 - (docked ? panelWidth + 1 : 0) >= SPLIT_MIN;
  const sidebarShown = sidebarVisible && (sidebarFits || sidebarPinned);
  const showSidebar = (show: boolean): void => { setSidebarVisible(show); setSidebarPinned(show && !sidebarFits); };
  const go = (next: Tab): void => { navigated.current = true; setReport(null); setTab(next); };

  // Menu and cross-window commands. A ref keeps the handler current without re-subscribing.
  const command = useRef<(c: string) => void>(() => {});
  command.current = (c: string) => {
    if (c === 'settingsChanged') { void loadAi(); void loadItems(); void loadSources(); setRevision((v) => v + 1); return; }
    if (document.querySelector('dialog[open]')) return;
    if (c === 'sidebar') showSidebar(!sidebarShown);
    else if (c === 'assistant') toggleAssistant();
    // ⌘F searches what is shown when it can be searched (阅读, 关注), else the articles.
    else if (c === 'search') { if (report || (tab !== 'read' && tab !== 'watches')) go('read'); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.toolbar .search-field input')?.focus()); }
    else if (c === 'subscribe') setShowCatalogue(true);
    else if (c === 'refresh') void refresh();
    else if ((TABS as string[]).includes(c)) go(c as Tab);
  };
  useEffect(() => window.pnr.onCommand?.((c) => command.current(c)), []);

  const patchItem = (id: string, patch: Partial<ItemRow>): void => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    setCurrent((c) => (c?.id === id ? { ...c, ...patch } : c));
  };
  const setRead = async (id: string, read: boolean): Promise<void> => {
    await window.pnr.markRead(id, read);
    patchItem(id, { readAt: read ? Date.now() : null });
    void loadSources();
  };
  const onSelect = (id: string): void => { setSelected(id); void setRead(id, true); };
  const onStar = async (id: string): Promise<void> => {
    const on = await window.pnr.toggleStar(id);
    patchItem(id, { starredAt: on ? Date.now() : null });
  };

  /** Opens one article in the reader, from a citation, a headline or the assistant. */
  const openItem = (id: string): void => { go('read'); onSelect(id); };
  const openReport: OpenReport = (anchor) => { if (aiReady) setReport(anchor); else openSettings('ai'); };
  const followOutside = (draft: OutsidePick['suggestion']): void => { setWatchRequest({ draft }); go('watches'); };
  const addWatch = (): void => { setWatchRequest({ draft: null }); go('watches'); };
  /** Opens one watch, by default on its timeline — where its developments are told. */
  const openWatch = (id: string, section: WatchTab = 'timeline'): void => { setWatchRequest({ open: id, section }); go('watches'); };
  const pickSource = (id: string | undefined): void => { go('read'); setFilter('all'); setSourceId(id); setSelected(null); setQuery(''); };
  const pickFilter = (value: Filter): void => { go('read'); setSourceId(undefined); setFilter(value); setSelected(null); setQuery(''); };

  /** The native context menu for one article, wherever it is shown. */
  const articleMenu = async (it: ItemRow): Promise<void> => {
    const entries: MenuEntry[] = [
      { id: 'open', label: t('menu.openOriginal') },
      { id: 'report', label: t('report.open'), enabled: aiReady },
      { separator: true },
      { id: 'read', label: it.readAt ? t('reader.markUnread') : t('reader.markRead') },
      { id: 'star', label: it.starredAt ? t('list.unstar') : t('list.star') },
      { separator: true },
      { id: 'copy', label: t('menu.copyLink') }
    ];
    const choice = await window.pnr.contextMenu(entries);
    if (choice === 'open') void window.pnr.openExternal(it.url);
    else if (choice === 'report') openReport({ anchorItemId: it.id, itemIds: [it.id], topic: it.title });
    else if (choice === 'read') void setRead(it.id, !it.readAt);
    else if (choice === 'star') void onStar(it.id);
    else if (choice === 'copy') void window.pnr.copyText(it.url);
  };
  const sourceMenu = async (s: SourceRow): Promise<void> => {
    const choice = await window.pnr.contextMenu([{ id: 'off', label: t('sidebar.unsubscribe') }, { separator: true }, { id: 'manage', label: t('menu.manageSubscriptions') }]);
    if (choice === 'off') {
      await window.pnr.setSourceEnabled(s.id, false);
      if (sourceId === s.id) pickFilter('all');
      void loadSources(); void loadItems();
    } else if (choice === 'manage') setShowCatalogue(true);
  };

  const needle = query.trim().toLocaleLowerCase();
  const visibleItems = needle ? items.filter((i) => `${i.title} ${i.sourceName ?? ''} ${i.snippet ?? ''}`.toLocaleLowerCase().includes(needle)) : items;
  const selectedIndex = visibleItems.findIndex((i) => i.id === selected);
  const stepArticle = (delta: number): void => {
    const next = visibleItems[selectedIndex < 0 ? 0 : selectedIndex + delta];
    if (next) onSelect(next.id);
  };
  const article = selected && current?.id === selected ? current : null;

  // Title and subtitle, as in Mail: what is shown, and its state.
  const source = sources.find((s) => s.id === sourceId);
  const title = report ? t('report.title') : tab === 'read' ? (source?.name ?? t(`filters.${filter}`)) : t(`tabs.${tab}`);
  const today = new Intl.DateTimeFormat(i18n.language, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const subtitle = note || (report ? report.topic.split('\n')[0]
    : tab === 'read' ? [t('app.articleCount', { count: needle ? visibleItems.length : total }), lastRun ? t('app.lastRun', { when: ago(lastRun) }) : t('app.neverRun')].join(' · ')
    : tab === 'today' ? today
    : tab === 'flashes' ? t(importantOnly ? 'flashes.subtitleImportant' : 'flashes.subtitle', { count: counts.flashes ?? 0 })
    : t('watches.count', { count: counts.watches ?? 0 }));
  // Every tab shares one list column, so it keeps its width across them.
  const listDivider = <SplitDivider width={listWidth} onChange={setListWidth} min={LIST.min} max={LIST.max} fallback={LIST.fallback}
    storageKey={LIST.key} edge="before" label={t('app.resizeList')} />;
  const spinner = (kind: Job) => <RefreshCw size={16} className={job === kind ? 'spinning' : ''} />;

  return (
    <div className={`app ${sidebarShown ? '' : 'sidebar-hidden'} ${floating ? 'assistant-floating' : ''}`}
         style={{ '--list-width': `${listWidth}px`, '--panel-width': `${panelWidth}px` } as CSSProperties}>
      {sidebarShown && (
        <Sidebar tab={report ? null : tab} onTab={go} sources={sources} sourceId={sourceId} filter={filter} fresh={counts.fresh ?? 0}
          onPickSource={pickSource} onPickFilter={pickFilter} onSourceMenu={(s) => void sourceMenu(s)}
          onAdd={() => setShowCatalogue(true)} onSettings={() => openSettings()} onHide={() => showSidebar(false)} aiReady={aiReady} />
      )}
      <main className="workspace">
        {/* As in Mail: what acts on the list sits above the list, what acts on the
            item sits above the item. A refresh button therefore always sits next
            to the name of the list it refreshes. */}
        <header className={`toolbar ${report ? 'whole' : ''}`}>
          <div className="toolbar-list">
            {!sidebarShown && <button className="tool" aria-label={t('app.showSidebar')} title={`${t('app.showSidebar')} (⌘⌃S)`} onClick={() => showSidebar(true)}><PanelLeft size={17} /></button>}
            {report && <button className="tool" aria-label={t('common.back')} title={t('common.back')} onClick={() => setReport(null)}><ChevronLeft size={18} /></button>}
            {!report && tab === 'read' && selected && <button className="tool narrow-only" aria-label={t('reader.back')} title={t('reader.back')} onClick={() => setSelected(null)}><ChevronLeft size={18} /></button>}
            <div className="toolbar-title">
              <h1>{title}</h1>
              <p>{busy && <span className="spinner" aria-hidden />}{subtitle}</p>
            </div>
            {!report && tab === 'read' && <button className="tool" onClick={() => void refresh()} disabled={busy}
              title={`${t('app.refresh')} (⌘R)`} aria-label={t('app.refresh')}>{spinner('fetch')}</button>}
            {!report && tab === 'flashes' && <>
              {/* A filter toggle, as Mail's: it narrows the list the title counts. */}
              <button className="tool" aria-pressed={importantOnly} title={t('flashes.importantOnly')} aria-label={t('flashes.importantOnly')}
                onClick={() => setImportantOnly((v) => !v)}><ListFilter size={16} /></button>
              {aiReady && <button className="tool" disabled={busy} title={t('app.checkFlashes')} aria-label={t('app.checkFlashes')}
                onClick={() => void runFlashes()}>{spinner('flashes')}</button>}
            </>}
            {!report && tab === 'watches' && <button className="tool" title={t('watches.add')} aria-label={t('watches.add')} onClick={addWatch}><Plus size={17} /></button>}
          </div>
          <div className="toolbar-detail">
            {report && <button className="tool" title={t('report.restart')} aria-label={t('report.restart')} onClick={() => setRestartReport((v) => v + 1)}><RotateCcw size={16} /></button>}
            {!report && tab === 'read' && <>
              <div className="tool-group">
                <button className="tool" aria-label={t('app.prevArticle')} title={t('app.prevArticle')} disabled={selectedIndex <= 0} onClick={() => stepArticle(-1)}><ChevronLeft size={17} /></button>
                <button className="tool" aria-label={t('app.nextArticle')} title={t('app.nextArticle')} disabled={!visibleItems.length || selectedIndex === visibleItems.length - 1} onClick={() => stepArticle(1)}><ChevronRight size={17} /></button>
              </div>
              <button className="tool" disabled={!article} aria-pressed={Boolean(article?.starredAt)} title={article?.starredAt ? t('list.unstar') : t('list.star')} aria-label={t('list.star')}
                onClick={() => { if (article) void onStar(article.id); }}><Star size={16} fill={article?.starredAt ? 'currentColor' : 'none'} /></button>
              <button className="tool" disabled={!article} title={article?.readAt ? t('reader.markUnread') : t('reader.markRead')} aria-label={article?.readAt ? t('reader.markUnread') : t('reader.markRead')}
                onClick={() => { if (article) void setRead(article.id, !article.readAt); }}><CircleDot size={16} /></button>
              <button className="tool" disabled={!article} title={t('reader.original')} aria-label={t('reader.original')}
                onClick={() => { if (article) void window.pnr.openExternal(article.url); }}><ExternalLink size={16} /></button>
              <button className="tool" disabled={!article || !aiReady} title={aiReady ? t('report.open') : t('report.needAi')} aria-label={t('report.open')}
                onClick={() => { if (article) openReport({ anchorItemId: article.id, itemIds: [article.id], topic: article.title }); }}><FileSearch size={16} /></button>
            </>}
            <span className="grow" />
            {!report && tab === 'read' && <label className="search-field"><Search size={13} />
              <input type="search" aria-label={t('list.search')} placeholder={t('list.search')} value={query}
                onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} /></label>}
            {!report && tab === 'watches' && <label className="search-field"><Search size={13} />
              <input type="search" aria-label={t('watches.search')} placeholder={t('watches.search')} value={watchQuery}
                onChange={(e) => setWatchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setWatchQuery(''); }} /></label>}
            <button className="tool" aria-pressed={assistantOpen} onClick={() => toggleAssistant()}
                    title={`${t('assistant.toggle')} (⌘J)`} aria-label={t('assistant.toggle')}><MessageSquareText size={17} /></button>
          </div>
        </header>
        <div className="workspace-body"><ErrorBoundary key={report ? 'report' : tab}>
          {report ? <Report anchor={report} lang={ai?.outputLang ?? 'zh-CN'} restart={restartReport} onOpen={openItem} />
          : tab === 'read' ? <div className={`split-view ${selected ? 'has-selection' : ''}`}>
            <ItemList items={visibleItems} onMore={items.length < total && !needle ? () => void loadMore() : undefined}
              remaining={total - items.length} selected={selected} onSelect={onSelect} onMenu={(it) => void articleMenu(it)}
              query={query} onClearQuery={() => setQuery('')} filter={filter} empty={sources.length === 0} onAdd={() => setShowCatalogue(true)} />
            {listDivider}
            <Reader id={selected} onLoaded={setCurrent} />
          </div>
          : tab === 'today' ? <Today aiReady={aiReady} revision={revision} writing={job === 'daily'} busy={busy} divider={listDivider} onSetup={() => openSettings('ai')}
              onWrite={() => void runDaily()} onOpen={openItem} onRead={(id) => void setRead(id, true)} onReport={openReport} onFollow={followOutside}
              onAddWatch={addWatch} onOpenWatch={openWatch} />
          : tab === 'flashes' ? <Flashes aiReady={aiReady} revision={revision} important={importantOnly} divider={listDivider} onSetup={() => openSettings('ai')}
              onOpen={openItem} onReport={openReport} onOpenWatch={openWatch} onCount={(n) => setCounts((c) => ({ ...c, flashes: n }))} />
          : <Watches aiReady={aiReady} revision={revision} query={watchQuery} divider={listDivider} onSetup={() => openSettings('ai')} onOpen={openItem} onReport={openReport}
              onCount={(n, fresh) => setCounts((c) => ({ ...c, watches: n, fresh }))} request={watchRequest} onRequestDone={() => setWatchRequest(null)} />}
        </ErrorBoundary></div>
      </main>
      {assistantOpen && <>
        <SplitDivider width={panelWidth} onChange={setPanelWidth} min={PANEL.min} max={PANEL.max} fallback={PANEL.fallback}
          storageKey={PANEL.key} edge="after" label={t('assistant.resize')} />
        <ErrorBoundary><Assistant ai={ai} onOpenItem={openItem} onSetup={() => openSettings('ai')} onClose={() => toggleAssistant(false)} /></ErrorBoundary>
      </>}
      {showCatalogue && <Catalogue onClose={(changed) => {
        setShowCatalogue(false); void loadSources(); void loadItems();
        // Newly switched-on sources are empty until fetched.
        if (changed) void refresh();
      }} />}
      {askBackground && <BackgroundPrompt onDone={() => setAskBackground(false)} />}
    </div>
  );
}
