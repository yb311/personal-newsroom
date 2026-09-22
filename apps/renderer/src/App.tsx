import { ChevronLeft, ChevronRight, MessageSquareText, PanelLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiStatus, ItemRow, OutsidePick, SourceRow } from './types.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { ItemList } from './components/ItemList.tsx';
import { Reader } from './components/Reader.tsx';
import { Catalogue } from './components/Catalogue.tsx';
import { Today } from './components/Today.tsx';
import { Watches, type WatchRequest } from './components/Watches.tsx';
import { Settings } from './components/Settings.tsx';
import { Flashes } from './components/Flashes.tsx';
import { BackgroundPrompt } from './components/BackgroundPrompt.tsx';
import { Assistant } from './components/Assistant.tsx';
import { SplitDivider, storedWidth } from './components/SplitDivider.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ago } from './i18n.ts';

export type Filter = 'all' | 'unread' | 'starred';
export type Tab = 'today' | 'flashes' | 'watches' | 'read';
export const TABS: Tab[] = ['today', 'flashes', 'watches', 'read'];

/** How many articles the list loads at a time. */
const PAGE = 200;
const LIST = { min: 250, max: 460, fallback: 320, key: 'pnr.listWidth' };
const PANEL = { min: 320, max: 620, fallback: 380, key: 'pnr.assistantWidth' };
const readFlag = (key: string, fallback: boolean): boolean => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
};
const saveFlag = (key: string, on: boolean): void => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* optional */ } };

export default function App() {
  const { t } = useTranslation();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [listWidth, setListWidth] = useState(() => storedWidth(LIST.key, LIST.min, LIST.max, LIST.fallback));
  const [panelWidth, setPanelWidth] = useState(() => storedWidth(PANEL.key, PANEL.min, PANEL.max, PANEL.fallback));
  const [assistantOpen, setAssistantOpen] = useState(() => readFlag('pnr.assistantOpen', false));
  const [tab, setTab] = useState<Tab>('read');
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [lastRun, setLastRun] = useState<number | null>(null);
  const [showCatalogue, setShowCatalogue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [askBackground, setAskBackground] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const [watchRequest, setWatchRequest] = useState<WatchRequest | null>(null);
  const requestId = useRef(0);
  const operation = useRef(false);
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

  useEffect(() => { void loadSources(); void loadAi(); }, [loadSources, loadAi]);
  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  useEffect(() => window.pnr.onProgress((p) => {
    const x = p as { phase?: string; label?: string };
    const key = { watch: 'app.progress.watch', writing: 'app.progress.writing', extract: 'app.progress.extract', fetch: 'app.progress.fetch' }[x.phase ?? ''];
    if (key) setNote(t(key, { label: x.label }));
  }), [t]);

  /** One long-running operation at a time; its outcome stays in the status bar for a few seconds. */
  const perform = async (message: string, task: () => Promise<string>): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    clearTimeout(noticeTimer.current);
    setBusy(true); setNote(message);
    try { setNote(await task()); }
    catch { setNote(t('app.failed')); }
    finally {
      operation.current = false; setBusy(false); setRevision((v) => v + 1);
      void loadStats();
      noticeTimer.current = setTimeout(() => setNote(''), 6000);
    }
  };
  const failure = (error: string): string => error.replace(/^Error:\s*/, '').slice(0, 80);
  const refresh = (): Promise<void> => perform(t('app.refreshing'), async () => {
    const r = await window.pnr.refresh();
    await Promise.all([loadSources(), loadItems()]);
    // First-run consent: once reading works, ask once about background updates.
    if (!r.busy && !r.error && await window.pnr.backgroundPrompt()) setAskBackground(true);
    return r.busy ? t('app.busy') : r.error ? t('app.refreshFailed', { error: failure(r.error) }) : t('app.refreshed', { count: r.inserted ?? 0 });
  });
  const runFlashes = (): Promise<void> => perform(t('app.flashChecking'), async () => {
    const r = await window.pnr.runFlashes();
    void loadItems(); void loadSources();
    return r.busy ? t('app.busy') : r.error ? t('app.runFailed', { error: failure(r.error) })
      : t('app.flashDone', { count: r.flashes ?? 0 }) + (r.failed ? t('app.partial', { count: r.failed }) : '');
  });
  const runWatches = (): Promise<void> => perform(t('app.watchesRunning'), async () => {
    const r = await window.pnr.runWatches();
    void loadItems(); void loadSources();
    return r.busy ? t('app.busy') : r.error ? t('app.runFailed', { error: failure(r.error) })
      : r.mode === 'keywords' ? t('app.watchesKeywords', { count: r.watches ?? 0 })
      : t('app.watchesDone', { count: r.watches ?? 0 }) + (r.digest ? t('app.digestReady') : '') + (r.failed ? t('app.partial', { count: r.failed }) : '');
  });

  // First launch: fetch once so the app is not empty; open 今日 when a brief exists.
  useEffect(() => {
    void (async () => {
      const s = await window.pnr.stats();
      setLastRun(s.lastRun);
      if (s.items === 0 && s.sources > 0) void refresh();
      if ((await window.pnr.today()).digest) setTab((current) => (current === 'read' ? 'today' : current));
    })();
  }, []);

  const toggleAssistant = (open = !assistantOpen): void => { setAssistantOpen(open); saveFlag('pnr.assistantOpen', open); };

  // Menu commands. A ref keeps the handler current without re-subscribing.
  const command = useRef<(c: string) => void>(() => {});
  command.current = (c: string) => {
    if (document.querySelector('dialog[open]')) return;
    if (c === 'settings') setShowSettings(true);
    else if (c === 'sidebar') setSidebarVisible((v) => !v);
    else if (c === 'assistant') toggleAssistant();
    else if (c === 'search') { setTab('read'); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.list .search-field input')?.focus()); }
    else if (c === 'subscribe') setShowCatalogue(true);
    else if (c === 'refresh') void refresh();
    else if ((TABS as string[]).includes(c)) setTab(c as Tab);
  };
  useEffect(() => window.pnr.onCommand?.((c) => command.current(c)), []);

  const setRead = async (id: string, read: boolean): Promise<void> => {
    await window.pnr.markRead(id, read);
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, readAt: read ? Date.now() : null } : i)));
    void loadSources();
  };
  const onSelect = (id: string): void => { setSelected(id); void setRead(id, true); };
  const onStar = async (id: string): Promise<void> => {
    const on = await window.pnr.toggleStar(id);
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, starredAt: on ? Date.now() : null } : i)));
    setRevision((v) => v + 1);
  };

  /** Opens one article in the reader, from a citation, a headline or the assistant. */
  const openItem = (id: string): void => { setTab('read'); onSelect(id); };
  const followOutside = (draft: OutsidePick['suggestion']): void => { setWatchRequest({ draft }); setTab('watches'); };
  const addWatch = (): void => { setWatchRequest({ draft: null }); setTab('watches'); };
  const pickSource = (id: string | undefined): void => { setTab('read'); setFilter('all'); setSourceId(id); setSelected(null); setQuery(''); };
  const pickFilter = (value: Filter): void => { setTab('read'); setSourceId(undefined); setFilter(value); setSelected(null); setQuery(''); };

  const needle = query.trim().toLocaleLowerCase();
  const visibleItems = needle ? items.filter((i) => `${i.title} ${i.sourceName} ${i.snippet ?? ''}`.toLocaleLowerCase().includes(needle)) : items;
  const selectedIndex = visibleItems.findIndex((i) => i.id === selected);
  const stepArticle = (delta: number): void => {
    const next = visibleItems[selectedIndex < 0 ? 0 : selectedIndex + delta];
    if (next) onSelect(next.id);
  };

  const source = sources.find((s) => s.id === sourceId);
  const title = tab === 'read' ? (source?.name ?? t(`filters.${filter}`)) : t(`tabs.${tab}`);
  const tabAction = tab === 'today' ? { label: t('app.updateToday'), run: runWatches }
    : tab === 'watches' ? { label: t('app.updateWatches'), run: runWatches }
    : tab === 'flashes' && aiReady ? { label: t('app.checkFlashes'), run: runFlashes }
    : null;

  return (
    <div className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`}
         style={{ '--list-width': `${listWidth}px`, '--panel-width': `${panelWidth}px` } as CSSProperties}>
      {sidebarVisible && (
        <Sidebar tab={tab} onTab={setTab} sources={sources} sourceId={sourceId} filter={filter}
          onPickSource={pickSource} onPickFilter={pickFilter} onManage={() => setShowCatalogue(true)}
          onSettings={() => setShowSettings(true)} onHide={() => setSidebarVisible(false)} aiReady={aiReady} />
      )}
      <main className="workspace">
        <header className="titlebar">
          <div className="titlebar-heading">
            {!sidebarVisible && <button className="icon" aria-label={t('app.showSidebar')} title={`${t('app.showSidebar')} (⌘⌃S)`} onClick={() => setSidebarVisible(true)}><PanelLeft size={17} /></button>}
            <h1>{title}</h1>
            {tab === 'read' && <span className="subtitle">{t('app.articleCount', { count: needle ? visibleItems.length : total })}</span>}
          </div>
          <div className="titlebar-actions">
            {tab === 'read' && <>
              <div className="segmented" role="group" aria-label={t('app.articleNav')}>
                <button className="icon" aria-label={t('app.prevArticle')} title={t('app.prevArticle')} disabled={selectedIndex <= 0} onClick={() => stepArticle(-1)}><ChevronLeft size={16} /></button>
                <button className="icon" aria-label={t('app.nextArticle')} title={t('app.nextArticle')} disabled={!visibleItems.length || selectedIndex === visibleItems.length - 1} onClick={() => stepArticle(1)}><ChevronRight size={16} /></button>
              </div>
              <button className="icon" onClick={() => void refresh()} disabled={busy} title={`${t('app.refresh')} (⌘R)`} aria-label={t('app.refresh')}>
                <RefreshCw size={15} className={busy ? 'spinning' : ''} /></button>
            </>}
            {tabAction && <button className="toolbar-button" title={tabAction.label} onClick={() => void tabAction.run()} disabled={busy}>
              <RefreshCw size={14} className={busy ? 'spinning' : ''} />{tabAction.label}</button>}
            <span className="toolbar-sep" />
            <button className="icon" aria-pressed={assistantOpen} onClick={() => toggleAssistant()}
                    title={`${t('assistant.toggle')} (⌘J)`} aria-label={t('assistant.toggle')}><MessageSquareText size={17} /></button>
          </div>
        </header>
        <div className="workspace-body"><ErrorBoundary key={tab}>
          {tab === 'read' && <div className={`reading ${selected ? 'has-selection' : ''}`}>
            <ItemList items={visibleItems} onMore={items.length < total && !needle ? () => void loadMore() : undefined}
              remaining={total - items.length} selected={selected} onSelect={onSelect} onStar={onStar}
              query={query} onQuery={setQuery} filter={filter} empty={sources.length === 0} onManage={() => setShowCatalogue(true)} />
            <SplitDivider width={listWidth} onChange={setListWidth} min={LIST.min} max={LIST.max} fallback={LIST.fallback}
              storageKey={LIST.key} edge="before" label={t('app.resizeList')} />
            <Reader id={selected} revision={revision} onStar={onStar} onSetRead={setRead} onBack={() => setSelected(null)} />
          </div>}
          {tab === 'today' && <Today aiReady={aiReady} revision={revision} running={busy} onSetup={() => setShowSettings(true)}
            onRun={() => void runWatches()} onOpen={openItem} onFollow={followOutside} onAddWatch={addWatch} />}
          {tab === 'flashes' && <Flashes aiReady={aiReady} revision={revision} onSetup={() => setShowSettings(true)} onOpen={openItem} />}
          {tab === 'watches' && <Watches aiReady={aiReady} revision={revision} onSetup={() => setShowSettings(true)} onOpen={openItem}
            request={watchRequest} onRequestDone={() => setWatchRequest(null)} />}
        </ErrorBoundary></div>
        <footer className="statusbar" role="status">
          <span className={busy ? 'dot busy' : 'dot'} />
          <span className="status-text">{note || (lastRun ? t('app.lastRun', { when: ago(lastRun) }) : t('app.neverRun'))}</span>
          <span className="grow" />
          <button className="status-link" onClick={() => setShowSettings(true)}>{aiReady ? t('app.aiOn') : t('app.aiOff')}</button>
        </footer>
      </main>
      {assistantOpen && <>
        <SplitDivider width={panelWidth} onChange={setPanelWidth} min={PANEL.min} max={PANEL.max} fallback={PANEL.fallback}
          storageKey={PANEL.key} edge="after" label={t('assistant.resize')} />
        <ErrorBoundary><Assistant ai={ai} onOpenItem={openItem} onSetup={() => setShowSettings(true)} onClose={() => toggleAssistant(false)} /></ErrorBoundary>
      </>}
      {showCatalogue && <Catalogue onClose={(changed) => {
        setShowCatalogue(false); void loadSources(); void loadItems();
        // Newly switched-on sources are empty until fetched.
        if (changed) void refresh();
      }} />}
      {askBackground && <BackgroundPrompt onDone={() => setAskBackground(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)}
        onChanged={() => { void loadAi(); void loadItems(); void loadSources(); setRevision((v) => v + 1); }} />}
    </div>
  );
}
