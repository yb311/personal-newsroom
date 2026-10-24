import { ChevronDown, ChevronLeft, ChevronUp, CircleCheck, CircleDot, FileSearch, Languages, ListFilter, MessageSquareText, PanelLeft, Plus, RefreshCw, RotateCcw, Search, Share, Star } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiStatus, ExportFormat, ExportResult, ItemRow, MenuEntry, NavTarget, OutsidePick, ReportAnchor, Screen, SourceRow } from './types.ts';
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
import { SelectionPopover } from './components/SelectionPopover.tsx';
import { isForeign, listTranslated, preferredMode, rememberListTranslated, rememberMode, translateSettings, type TranslateMode } from './translate.ts';
import { ago } from './i18n.ts';
import type { WatchTab } from './components/Watches.tsx';

export type Filter = 'all' | 'unread' | 'starred';
export type Tab = 'today' | 'flashes' | 'watches' | 'read';
export const TABS: Tab[] = ['today', 'flashes', 'watches', 'read'];
/** Opens a deep report; every surface that shows news can start one. */
export type OpenReport = (anchor: ReportAnchor) => void;

/** The long operations the window starts. Each has one home: the control that starts it
 *  sits with what it updates, and only that control spins while it runs. 全部更新
 *  ('all') is the one control for everything; it sits in the sidebar's title bar. */
type Job = 'fetch' | 'flashes' | 'all' | 'digest' | 'translate';

/** How many articles the list loads at a time. */
const PAGE = 200;
/** Whole texts one 批量翻译 takes on (MAX_BATCH.full in @pnr/generate). */
const MAX_FULL = 50;
const LIST = { min: 250, max: 460, fallback: 320, key: 'pnr.listWidth' };
const PANEL = { min: 320, max: 620, fallback: 380, key: 'pnr.assistantWidth' };
/** The sidebar's min leaves room for the traffic lights and its two title-bar buttons. */
const SIDEBAR = { min: 190, max: 360, fallback: 220, key: 'pnr.sidebarWidth' };
/** The narrowest workspace that still splits list and detail side by side —
 *  keep in step with `@container workspace` in app.css. The list takes at most
 *  44%, so the detail keeps at least ~390px. Where its toolbar runs short of room
 *  the search field folds into a button (`@container toolbar-detail` in app.css),
 *  so the article's own buttons never crowd. */
const SPLIT_MIN = 700;
/** The narrowest workspace showing list or detail one at a time. The window's
 *  minimum width (main.ts) leaves this beside a docked assistant at its minimum,
 *  so the assistant never has to float over the page. */
const STACK_MIN = 430;
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
  const [sidebarWidth, setSidebarWidth] = useState(() => storedWidth(SIDEBAR.key, SIDEBAR.min, SIDEBAR.max, SIDEBAR.fallback));
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
  /** The search field folded into its button (a narrow toolbar) was opened, by click or ⌘F. */
  const [searchOpen, setSearchOpen] = useState(false);
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
  /** How the open article is shown: as published, or translated (see translate.ts). */
  const [trMode, setTrMode] = useState<TranslateMode>('original');
  /** Lists show translated headlines where there are some. */
  const [showTranslated, setShowTranslated] = useState(listTranslated);
  /** Text to quote in the assistant's composer (问助手 on a selection). */
  const [quote, setQuote] = useState<{ text: string; n: number } | null>(null);
  /** What 今日, 快讯 or 关注 has open, as they report it for the assistant. */
  const [viewScreen, setViewScreen] = useState<Screen | null>(null);
  const requestId = useRef(0);
  const operation = useRef(false);
  /** An export is saving; it runs beside whatever else is running (see runExport). */
  const exporting = useRef(false);
  /** Set once the person picks a view, so the launch check below never overrides them. */
  const navigated = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aiReady = Boolean(ai?.available);
  const trSettings = translateSettings(ai);

  const loadSources = useCallback(async () => setSources(await window.pnr.listSources()), []);
  // Which articles the list shows is read from `scope` when a load starts, never
  // captured in a closure. A long-running action (a refresh after adding a source)
  // holds on to `loadItems` for seconds; with a captured scope it would, on
  // finishing, put the articles of the source you had open back then into the
  // list of the source you have open now. `loadItems` is therefore stable.
  const scope = useRef({ sourceId, filter });
  scope.current = { sourceId, filter };
  const loadItems = useCallback(async () => {
    const request = ++requestId.current;
    const { sourceId: source, filter: which } = scope.current;
    const query = { ...(source ? { sourceId: source } : {}), filter: which };
    const [rows, count] = await Promise.all([window.pnr.listItems({ ...query, limit: PAGE }), window.pnr.countItems(query)]);
    if (request === requestId.current) { setItems(rows); setTotal(count); }
  }, []);
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
  useEffect(() => { void loadItems(); }, [loadItems, sourceId, filter]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    const resized = (): void => { setWindowWidth(window.innerWidth); setSidebarPinned(false); };
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);

  // `t` is read through a ref rather than a dependency: subscribing to the main
  // process is not a data load, but resubscribing on every language switch
  // could still drop a progress event landing in that instant (see AGENTS.md
  // on effects that depend on `t`).
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => window.pnr.onProgress((p) => {
    const x = p as { phase?: string; label?: string };
    const key = { watch: 'app.progress.watch', writing: 'app.progress.writing', extract: 'app.progress.extract', fetch: 'app.progress.fetch', translate: 'app.progress.translate',
      export: 'export.saving', backup: 'export.backingUp' }[x.phase ?? ''];
    if (key && (operation.current || exporting.current)) { clearTimeout(noticeTimer.current); setNote(tRef.current(key, { label: x.label })); }
  }), []);

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
  /** 导出 waits on a save panel, so it does not hold up the one-at-a-time operations; its outcome goes in the subtitle all the same. */
  const runExport = async (task: () => Promise<ExportResult>, done: (name: string, r: Extract<ExportResult, { ok: true }>) => string): Promise<void> => {
    if (exporting.current) return;
    exporting.current = true;
    let text = '';
    try {
      const r = await task();
      text = r.ok ? done(r.path.split('/').pop() ?? r.path, r) : r.reason === 'cancelled' ? '' : t(`export.error.${r.reason}`);
    } catch { text = t('export.error.failed'); }
    finally { exporting.current = false; }
    clearTimeout(noticeTimer.current);
    setNote(text);
    if (text) noticeTimer.current = setTimeout(() => setNote(''), 6000);
  };
  const exportOpml = (): Promise<void> => runExport(() => window.pnr.exportOpml(),
    (name, r) => t('export.opmlSaved', { count: r.count ?? 0, name }) + (r.skipped ? t('export.opmlSkipped', { count: r.skipped }) : ''));
  const exportBackup = (): Promise<void> => runExport(() => window.pnr.exportBackup(), (name) => t('export.backedUp', { name }));
  const formatMenu = (): Promise<string | null> => window.pnr.contextMenu([
    { id: 'pdf', label: t('export.pdf') }, { id: 'markdown', label: t('export.markdown') }, { id: 'html', label: t('export.html') }]);
  const exportChat = async (chatId: string): Promise<void> => {
    const format = await formatMenu() as ExportFormat | null;
    if (format) void runExport(() => window.pnr.exportChat(chatId, format), (name) => t('export.saved', { name }));
  };
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
      : (r.skipped?.includes('flashes') ? t('app.flashNothingNew') : t('app.flashDone', { count: r.flashes ?? 0 }))
        + (r.failed ? t('app.partial', { count: r.failed }) : '');
  });
  /**
   * 全部更新: fetch, match every watch and write whatever has something new —
   * timelines, flashes, the brief, 关注之外. What has nothing new is not written
   * again, so pressing it twice costs a fetch, not a second round of AI writing.
   * `force` (⌥, or the menu) writes everything again.
   */
  const runAll = (force = false): Promise<void> => perform('all', t(force ? 'app.regeneratingAll' : 'app.updatingAll'), async () => {
    const r = await window.pnr.runAll(force);
    void loadItems(); void loadSources();
    if (r.busy) return t('app.busy');
    if (r.error) return t('app.runFailed', { error: failure(r.error) });
    const partial = r.failed ? t('app.partial', { count: r.failed }) : '';
    if (r.mode === 'keywords') return t('app.watchesKeywords', { count: r.watches ?? 0 }) + partial;
    const wrote = [
      r.milestones ? t('app.done.milestones', { count: r.milestones }) : '',
      r.flashes ? t('app.done.flashes', { count: r.flashes }) : '',
      r.digest ? t('app.done.digest') : ''
    ].filter(Boolean);
    const parts = [t('app.done.fetched', { count: r.fetched ?? 0 }), ...(wrote.length ? wrote : [t('app.done.nothingNew')])];
    return parts.join(t('app.done.separator')) + partial;
  });
  /** 「重新生成」 on today's brief: that document only, from what is already judged. */
  const rewriteDigest = (): Promise<void> => perform('digest', t('app.briefWriting'), async () => {
    const r = await window.pnr.rewriteDigest();
    return r.busy ? t('app.busy') : r.error ? t('app.runFailed', { error: failure(r.error) })
      : r.digest ? t('app.briefDone') : t('app.briefNone');
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

  // As a macOS split view does, a narrowing window takes space in a fixed order:
  //   1. the sidebar narrows to its minimum;
  //   2. the assistant narrows to its minimum;
  //   3. the sidebar collapses (and returns when the window widens again);
  //   4. list and detail stop sitting side by side and show one at a time.
  // Panes shrink before anything disappears. The assistant always stays docked,
  // so it can always be resized. A divider moves only within the room the
  // current arrangement leaves: dragging never hides the sidebar or squeezes
  // list and detail into one column (hide the sidebar to give the assistant
  // more). Dragging one pane wider pushes the other toward its minimum, and the
  // pushed width is remembered, so the two dividers never lock each other. A sidebar shown on request although it does not fit (pinned) keeps
  // its place, and the workspace makes do with one column.
  const panelMin = assistantOpen ? PANEL.min + 1 : 0;
  const sidebarFits = windowWidth - panelMin - (SIDEBAR.min + 1) >= SPLIT_MIN;
  const sidebarShown = sidebarVisible && (sidebarFits || sidebarPinned);
  const sidebarMin = sidebarShown ? SIDEBAR.min + 1 : 0;
  const floor = windowWidth - panelMin - sidebarMin >= SPLIT_MIN ? SPLIT_MIN : STACK_MIN;
  const panelMax = Math.max(PANEL.min, Math.min(PANEL.max, windowWidth - 1 - floor - sidebarMin));
  const panelShown = Math.min(panelWidth, panelMax);
  const panelPart = assistantOpen ? panelShown + 1 : 0;
  const sidebarMax = Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, windowWidth - 1 - panelMin - floor));
  const sidebarShownWidth = Math.min(sidebarWidth, sidebarMax, Math.max(SIDEBAR.min, windowWidth - 1 - panelPart - floor));
  const resizeSidebar = (width: number): void => {
    setSidebarWidth(width);
    const room = windowWidth - (width + 1) - floor - 1;
    if (assistantOpen && panelShown > room) {
      const next = Math.max(PANEL.min, room);
      setPanelWidth(next);
      try { localStorage.setItem(PANEL.key, String(next)); } catch { /* Storage may be unavailable. */ }
    }
  };
  const resizePanel = (width: number): void => {
    setPanelWidth(width);
    const room = windowWidth - (width + 1) - floor - 1;
    if (sidebarShown && sidebarShownWidth > room) {
      const next = Math.max(SIDEBAR.min, room);
      setSidebarWidth(next);
      try { localStorage.setItem(SIDEBAR.key, String(next)); } catch { /* Storage may be unavailable. */ }
    }
  };
  // The list takes at most 44% of the workspace (as the CSS clamp does); the
  // divider works with that shown width so dragging has no dead zone.
  const workspaceWidth = windowWidth - (sidebarShown ? sidebarShownWidth + 1 : 0) - panelPart;
  const listMax = Math.max(LIST.min, Math.min(LIST.max, Math.floor(workspaceWidth * 0.44)));
  const listShown = Math.min(listWidth, listMax);
  const showSidebar = (show: boolean): void => { setSidebarVisible(show); setSidebarPinned(show && !sidebarFits); };
  const go = (next: Tab): void => { navigated.current = true; setReport(null); if (next !== tab) setViewScreen(null); setTab(next); };

  // Menu and cross-window commands. A ref keeps the handler current without re-subscribing.
  const command = useRef<(c: string) => void>(() => {});
  command.current = (c: string) => {
    // dataChanged: the assistant changed something (a watch, a subscription) that is on screen.
    if (c === 'settingsChanged' || c === 'dataChanged') { void loadAi(); void loadItems(); void loadSources(); setRevision((v) => v + 1); return; }
    if (document.querySelector('dialog[open]')) return;
    if (c === 'sidebar') showSidebar(!sidebarShown);
    else if (c === 'assistant') toggleAssistant();
    // ⌘F searches what is shown when it can be searched (阅读, 关注), else the articles.
    else if (c === 'search') {
      if (report || (tab !== 'read' && tab !== 'watches')) go('read');
      setSearchOpen(true);
      // A narrow window reading one article has no room for the field: go back to the list it searches.
      const field = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('.toolbar .search-field input');
      requestAnimationFrame(() => {
        if (field()?.offsetParent) { field()!.focus(); return; }
        setSelected(null);
        requestAnimationFrame(() => field()?.focus());
      });
    }
    else if (c === 'subscribe') setShowCatalogue(true);
    else if (c === 'refresh') void refresh();
    else if (c === 'updateAll') void runAll(false);
    else if (c === 'regenerateAll') void runAll(true);
    else if (c === 'translate') { if (tab === 'read' && !report && article && aiReady) toggleTranslate(); }
    else if (c.startsWith('export:')) exportScreen(c.slice('export:'.length) as ExportFormat);
    else if (c === 'exportOpml') void exportOpml();
    else if (c === 'backup') void exportBackup();
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
  // Each article opens as published; 自动翻译外文文章 (below) translates foreign ones once they load.
  const onSelect = (id: string): void => { if (id !== selected) setTrMode('original'); setSelected(id); void setRead(id, true); };
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
  /** Pages the assistant opens; the same functions the sidebar and citations use. */
  const navigateTo = useRef<(target: NavTarget) => void>(() => {});
  navigateTo.current = (target) => {
    if (target.kind === 'tab') go(target.tab);
    else if (target.kind === 'item') { openItem(target.itemId); if (target.translate) { rememberMode(target.translate); setTrMode(target.translate); } }
    else if (target.kind === 'watch') openWatch(target.watchId, target.section);
    else if (target.kind === 'source') pickSource(target.sourceId);
    else if (target.kind === 'settings') openSettings(target.section);
    else if (target.kind === 'report') void window.pnr.getItem(target.itemId).then((it) => {
      if (it) openReport({ anchorItemId: it.id, itemIds: [it.id], topic: it.title });
    });
  };
  useEffect(() => window.pnr.onAssistantNavigate((target) => navigateTo.current(target)), []);
  const pickFilter = (value: Filter): void => { go('read'); setSourceId(undefined); setFilter(value); setSelected(null); setQuery(''); };

  /** The native context menu for one article, wherever it is shown. */
  const articleMenu = async (it: ItemRow): Promise<void> => {
    const entries: MenuEntry[] = [
      { id: 'open', label: t('menu.openOriginal') },
      { id: 'report', label: t('report.open'), enabled: aiReady },
      { id: 'translate', label: t('translate.whole'), enabled: aiReady },
      { separator: true },
      { id: 'read', label: it.readAt ? t('reader.markUnread') : t('reader.markRead') },
      { id: 'star', label: it.starredAt ? t('list.unstar') : t('list.star') },
      { separator: true },
      { id: 'copy', label: t('menu.copyLink') }
    ];
    const choice = await window.pnr.contextMenu(entries);
    if (choice === 'open') void window.pnr.openExternal(it.url);
    else if (choice === 'report') openReport({ anchorItemId: it.id, itemIds: [it.id], topic: it.title });
    else if (choice === 'translate') { openItem(it.id); setTrMode(preferredMode()); }
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
  const visibleItems = needle ? items.filter((i) => `${i.title} ${i.titleTr ?? ''} ${i.sourceName ?? ''} ${i.snippet ?? ''}`.toLocaleLowerCase().includes(needle)) : items;
  const selectedIndex = visibleItems.findIndex((i) => i.id === selected);
  const stepArticle = (delta: number): void => {
    const next = visibleItems[selectedIndex < 0 ? 0 : selectedIndex + delta];
    if (next) onSelect(next.id);
  };
  const article = selected && current?.id === selected ? current : null;

  // ── 翻译 ──────────────────────────────────────────────────────────────────
  // 自动翻译外文文章: once an article has loaded, a foreign one opens translated.
  const autoFor = useRef<string | null>(null);
  useEffect(() => {
    if (!article || autoFor.current === article.id) return;
    autoFor.current = article.id;
    if (trSettings.auto && aiReady && trMode === 'original' && isForeign(article.lang, trSettings.target)) setTrMode(preferredMode());
  }, [article?.id]);
  /** The toolbar's 翻译: translated in the way last chosen, or back to the original. */
  const toggleTranslate = (): void => setTrMode((m) => (m === 'original' ? preferredMode() : 'original'));
  /** Right-click on 翻译: how to show it, and the preferences. */
  const translateMenu = async (): Promise<void> => {
    const choice = await window.pnr.contextMenu([
      { id: 'original', label: t('translate.original'), checked: trMode === 'original' },
      { id: 'bilingual', label: t('translate.bilingual'), checked: trMode === 'bilingual', enabled: aiReady },
      { id: 'translation', label: t('translate.translation'), checked: trMode === 'translation', enabled: aiReady },
      { separator: true },
      { id: 'auto', label: t('settings.translateAuto'), checked: trSettings.auto, enabled: aiReady },
      { id: 'settings', label: t('translate.settingsMenu') }
    ]);
    if (choice === 'bilingual' || choice === 'translation') { rememberMode(choice); setTrMode(choice); }
    else if (choice === 'original') setTrMode('original');
    else if (choice === 'auto') { await window.pnr.setAiOption('translateAuto', trSettings.auto ? '0' : '1'); void loadAi(); }
    else if (choice === 'settings') openSettings('ai');
  };
  /** A translated headline shows in the list at once. */
  const onTitleTranslated = (id: string, title: string): void => {
    setItems((prev) => prev.map((i) => (i.id === id && i.titleTr !== title ? { ...i, titleTr: title } : i)));
  };
  /** 问助手 on selected text: the assistant opens with it quoted in the input. */
  const askAbout = (text: string): void => { setQuote({ text, n: Date.now() }); if (!assistantOpen) toggleAssistant(true); };
  /**
   * 批量翻译 — the list's 翻译 button. Headlines and snippets of the foreign
   * articles the list shows (cheap, many per call), or their whole texts. While
   * it runs, the same button stops it.
   */
  const translateList = async (): Promise<void> => {
    if (job === 'translate') {
      if (await window.pnr.contextMenu([{ id: 'stop', label: t('translate.list.stop') }]) === 'stop') void window.pnr.translateCancel();
      return;
    }
    const foreign = visibleItems.filter((i) => isForeign(i.lang, trSettings.target));
    const titles = foreign.filter((i) => !i.titleTr).map((i) => i.id);
    const full = foreign.filter((i) => !i.translatedFull).slice(0, MAX_FULL).map((i) => i.id);
    const choice = await window.pnr.contextMenu([
      { id: 'titles', label: t('translate.list.titles', { count: titles.length }), enabled: aiReady && titles.length > 0 && !busy },
      { id: 'full', label: t('translate.list.full', { count: full.length }), enabled: aiReady && full.length > 0 && !busy },
      { separator: true },
      { id: 'show', label: t('translate.list.showTranslated'), checked: showTranslated },
      { id: 'settings', label: t('translate.settingsMenu') }
    ]);
    if (choice === 'show') { rememberListTranslated(!showTranslated); setShowTranslated(!showTranslated); return; }
    if (choice === 'settings') { openSettings('ai'); return; }
    if (choice !== 'titles' && choice !== 'full') return;
    const ids = choice === 'full' ? full : titles;
    if (choice === 'full' && !await window.pnr.confirm({ message: t('translate.list.confirm.message', { count: ids.length }),
      detail: t('translate.list.confirm.detail'), confirm: t('translate.list.confirm.confirm'), cancel: t('common.cancel') })) return;
    if (!showTranslated) { rememberListTranslated(true); setShowTranslated(true); }
    await perform('translate', t('translate.list.starting'), async () => {
      const r = await window.pnr.translateBatch(ids, choice === 'full');
      await loadItems();
      if (r.busy) return t('app.busy');
      if (r.error) return t(`translate.error.${r.error}`, { defaultValue: t('translate.error.failed') });
      return t(r.cancelled ? 'translate.list.stopped' : 'translate.list.done', { count: r.translated ?? 0 }) + (r.failed ? t('app.partial', { count: r.failed }) : '');
    });
  };
  const source = sources.find((s) => s.id === sourceId);
  /** What the assistant is told is open on the left. 阅读 and a deep report are known
   *  here; the other views report their own selection through `onScreen`. */
  const screen: Screen | null = report
    ? { focus: { kind: 'report', anchorItemId: report.anchorItemId, lang: ai?.outputLang ?? 'zh-CN' }, label: report.topic.split('\n')[0]!.slice(0, 120) }
    : tab !== 'read' ? viewScreen
    : selected ? { focus: { kind: 'article', itemId: selected }, label: article?.title ?? items.find((i) => i.id === selected)?.title ?? '' }
    : visibleItems.length ? { focus: { kind: 'articles', title: source?.name ?? t(`filters.${filter}`), itemIds: visibleItems.slice(0, 30).map((i) => i.id) },
        label: source?.name ?? t(`filters.${filter}`) }
    : null;

  /** Exports what the assistant would be told is open; an article goes out the way the reader shows it, translation included. */
  const exportScreen = (format: ExportFormat): void => {
    if (!screen) { clearTimeout(noticeTimer.current); setNote(t('export.nothing')); noticeTimer.current = setTimeout(() => setNote(''), 6000); return; }
    const translation = !report && tab === 'read' && screen.focus.kind === 'article' ? { mode: trMode, target: trSettings.target } : undefined;
    void runExport(() => window.pnr.exportDocument({ screen, format, ...(translation ? { translation } : {}) }), (name) => t('export.saved', { name }));
  };
  const exportMenu = async (): Promise<void> => {
    const format = await formatMenu() as ExportFormat | null;
    if (format) exportScreen(format);
  };
  const shareMenu = async (): Promise<void> => {
    const choice = await window.pnr.contextMenu([
      { id: 'open', label: t('menu.openOriginal'), enabled: Boolean(article) }, { id: 'copy', label: t('menu.copyLink'), enabled: Boolean(article) },
      { separator: true },
      { id: 'pdf', label: t('export.pdf') }, { id: 'markdown', label: t('export.markdown') }, { id: 'html', label: t('export.html') }]);
    if (choice === 'open') { if (article) void window.pnr.openExternal(article.url); }
    else if (choice === 'copy') { if (article) void window.pnr.copyText(article.url); }
    else if (choice) exportScreen(choice as ExportFormat);
  };

  // Title and subtitle, as in Mail: what is shown, and its state.
  const title = report ? t('report.title') : tab === 'read' ? (source?.name ?? t(`filters.${filter}`)) : t(`tabs.${tab}`);
  const today = new Intl.DateTimeFormat(i18n.language, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const subtitle = note || (report ? report.topic.split('\n')[0]
    : tab === 'read' ? [t('app.articleCount', { count: needle ? visibleItems.length : total }), lastRun ? t('app.lastRun', { when: ago(lastRun) }) : t('app.neverRun')].join(' · ')
    : tab === 'today' ? today
    : tab === 'flashes' ? t(importantOnly ? 'flashes.subtitleImportant' : 'flashes.subtitle', { count: counts.flashes ?? 0 })
    : t('watches.count', { count: counts.watches ?? 0 }));
  // Every tab shares one list column, so it keeps its width across them.
  const listDivider = <SplitDivider width={listShown} onChange={setListWidth} min={LIST.min} max={listMax} fallback={LIST.fallback}
    storageKey={LIST.key} edge="before" label={t('app.resizeList')} />;
  const spinner = (kind: Job) => <RefreshCw size={16} className={job === kind ? 'spinning' : ''} />;

  return (
    <div className={`app ${sidebarShown ? '' : 'sidebar-hidden'}`}
         style={{ '--sidebar-width': `${sidebarShownWidth}px`, '--list-width': `${listShown}px`, '--panel-width': `${panelShown}px` } as CSSProperties}>
      {sidebarShown && <>
        <Sidebar tab={report ? null : tab} onTab={go} sources={sources} sourceId={sourceId} filter={filter} fresh={counts.fresh ?? 0}
          onPickSource={pickSource} onPickFilter={pickFilter} onSourceMenu={(s) => void sourceMenu(s)}
          onAdd={() => setShowCatalogue(true)} onSettings={openSettings} onHide={() => showSidebar(false)} aiReady={aiReady}
          updateAll={<UpdateAll running={job === 'all'} disabled={busy} onRun={(force) => void runAll(force)} />} />
        <SplitDivider width={sidebarShownWidth} onChange={resizeSidebar} min={SIDEBAR.min} max={sidebarMax} fallback={SIDEBAR.fallback}
          storageKey={SIDEBAR.key} edge="before" label={t('app.resizeSidebar')} />
      </>}
      <main className="workspace">
        {/* As in Mail: what acts on the list sits above the list, what acts on the
            item sits above the item. A refresh button therefore always sits next
            to the name of the list it refreshes. */}
        <header className={`toolbar ${report ? 'whole' : ''} ${!report && tab === 'read' ? (selected ? 'item-only' : 'list-only') : ''}`}>
          <div className="toolbar-list">
            {/* 全部更新 lives in the sidebar and hides with it, as a sidebar's own controls
                do on the Mac; ⇧⌘R still runs it. An icon-only copy here stood next to the
                list's own ↻ and the two could not be told apart. */}
            {!sidebarShown && <button className="tool" aria-label={t('app.showSidebar')} title={`${t('app.showSidebar')} (⌃⌘S)`} onClick={() => showSidebar(true)}><PanelLeft size={17} /></button>}
            {report && <button className="tool" aria-label={t('common.back')} title={t('common.back')} onClick={() => setReport(null)}><ChevronLeft size={18} /></button>}
            {!report && tab === 'read' && selected && <button className="tool narrow-only" aria-label={t('reader.back')} title={t('reader.back')} onClick={() => setSelected(null)}><ChevronLeft size={18} /></button>}
            <div className="toolbar-title">
              <h1>{title}</h1>
              <p>{busy && <span className="spinner" aria-hidden />}{subtitle}</p>
            </div>
            {!report && tab === 'read' && <button className="tool list-action" onClick={() => void refresh()} disabled={busy}
              title={`${t('app.refresh')} (⌘R)`} aria-label={t('app.refresh')}>{spinner('fetch')}</button>}
            {!report && tab === 'read' && <button className="tool list-action" onClick={() => void translateList()} disabled={(busy && job !== 'translate') || !aiReady}
              aria-pressed={job === 'translate'} title={aiReady ? (job === 'translate' ? t('translate.list.stop') : t('translate.list.button')) : t('translate.needAi')}
              aria-label={t('translate.list.button')} aria-haspopup="menu"><span className={`menu-glyph ${job === 'translate' ? 'pulsing' : ''}`}><Languages size={15} /><ChevronDown size={9} strokeWidth={2.5} /></span></button>}
            {!report && tab === 'flashes' && <>
              {/* ↻ sits next to the list's name, as in 阅读; the filter follows it. */}
              {aiReady && <button className="tool" disabled={busy} title={t('app.checkFlashes')} aria-label={t('app.checkFlashes')}
                onClick={() => void runFlashes()}>{spinner('flashes')}</button>}
              {/* A filter toggle, as Mail's: it narrows the list the title counts. */}
              <button className="tool" aria-pressed={importantOnly} title={importantOnly ? t('flashes.showAll') : t('flashes.importantOnly')} aria-label={t('flashes.importantOnly')}
                onClick={() => setImportantOnly((v) => !v)}><ListFilter size={16} /></button>
            </>}
            {!report && tab === 'watches' && <button className="tool" title={t('watches.add')} aria-label={t('watches.add')} onClick={addWatch}><Plus size={17} /></button>}
          </div>
          <div className={`toolbar-detail ${searchOpen ? 'searching' : ''}`}>
            {/* What acts on the article sits at the right, beside the search field, as in
                Mail: the list's own buttons end at the divider and these start well clear of it. */}
            <span className="grow" />
            {report && <button className="tool" title={t('report.restart')} aria-label={t('report.restart')} onClick={() => setRestartReport((v) => v + 1)}><RotateCcw size={16} /></button>}
            {!report && tab === 'read' && <>
              <div className="tool-group item-action">
                <button className="tool" aria-label={t('app.prevArticle')} title={t('app.prevArticle')} disabled={selectedIndex <= 0} onClick={() => stepArticle(-1)}><ChevronUp size={17} /></button>
                <button className="tool" aria-label={t('app.nextArticle')} title={t('app.nextArticle')} disabled={!visibleItems.length || selectedIndex === visibleItems.length - 1} onClick={() => stepArticle(1)}><ChevronDown size={17} /></button>
              </div>
              <button className="tool item-action" disabled={!article} aria-pressed={Boolean(article?.starredAt)} title={article?.starredAt ? t('list.unstar') : t('list.star')} aria-label={t('list.star')}
                onClick={() => { if (article) void onStar(article.id); }}><Star size={16} fill={article?.starredAt ? 'currentColor' : 'none'} /></button>
              {/* The icon is what the click leaves behind, in the list's own terms: the unread dot, or read. */}
              <button className="tool item-action" disabled={!article} title={article && !article.readAt ? t('reader.markRead') : t('reader.markUnread')} aria-label={article && !article.readAt ? t('reader.markRead') : t('reader.markUnread')}
                onClick={() => { if (article) void setRead(article.id, !article.readAt); }}>{article && !article.readAt ? <CircleCheck size={16} /> : <CircleDot size={16} />}</button>
              {/* As Safari's share button: the original page, its link, and 导出 — one place, so the toolbar keeps its width. */}
              <button className="tool item-action" disabled={!screen} title={t('export.share')} aria-label={t('export.share')} aria-haspopup="menu"
                onClick={() => void shareMenu()}><Share size={16} /></button>
              <button className="tool item-action" disabled={!article || !aiReady} aria-pressed={trMode !== 'original'} aria-label={t('translate.button')}
                title={aiReady ? `${trMode === 'original' ? t('translate.button') : t('translate.showOriginal')} (⇧⌘T)` : t('translate.needAi')}
                onClick={toggleTranslate} onContextMenu={(e) => { e.preventDefault(); if (article && aiReady) void translateMenu(); }}><Languages size={16} /></button>
              <button className="tool item-action" disabled={!article || !aiReady} title={aiReady ? t('report.open') : t('report.needAi')} aria-label={t('report.open')}
                onClick={() => { if (article) openReport({ anchorItemId: article.id, itemIds: [article.id], topic: article.title }); }}><FileSearch size={16} /></button>
            </>}
            {!report && (tab === 'read' || tab === 'watches') && <>
              {/* Where the toolbar is short of room the field folds into this button, as Mail's
                  does; opened, it takes the article buttons' place until it is left empty. */}
              <button className="tool search-toggle" title={t(tab === 'read' ? 'list.search' : 'watches.search')} aria-label={t(tab === 'read' ? 'list.search' : 'watches.search')}
                onClick={() => { setSearchOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.toolbar .search-field input')?.focus()); }}><Search size={16} /></button>
              {tab === 'read' ? <label className="search-field"><Search size={13} />
                <input type="search" aria-label={t('list.search')} placeholder={t('list.search')} value={query} onBlur={(e) => { if (!e.target.value) setSearchOpen(false); }}
                  onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} /></label>
              : <label className="search-field"><Search size={13} />
                <input type="search" aria-label={t('watches.search')} placeholder={t('watches.search')} value={watchQuery} onBlur={(e) => { if (!e.target.value) setSearchOpen(false); }}
                  onChange={(e) => setWatchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setWatchQuery(''); e.currentTarget.blur(); } }} /></label>}
            </>}
            {(report || tab !== 'read') && <button className="tool" disabled={!screen} title={t('export.button')} aria-label={t('export.button')} aria-haspopup="menu"
              onClick={() => void exportMenu()}><Share size={16} /></button>}
            <button className="tool" aria-pressed={assistantOpen} onClick={() => toggleAssistant()}
                    title={`${t('assistant.toggle')} (⌘J)`} aria-label={t('assistant.toggle')}><MessageSquareText size={17} /></button>
          </div>
        </header>
        <div className="workspace-body">
          {report && <ErrorBoundary key="report"><Report anchor={report} lang={ai?.outputLang ?? 'zh-CN'} restart={restartReport} onOpen={openItem} /></ErrorBoundary>}
          {/* A report covers the tab rather than replacing it, so going back finds the
              article, flash or watch it was opened from still selected. */}
          <div className="workspace-tab" hidden={Boolean(report)}><ErrorBoundary key={tab}>
          {tab === 'read' ? <div className={`split-view ${selected ? 'has-selection' : ''}`}>
            <ItemList items={visibleItems} translated={showTranslated} onMore={items.length < total && !needle ? () => void loadMore() : undefined}
              remaining={total - items.length} selected={selected} onSelect={onSelect} onMenu={(it) => void articleMenu(it)}
              query={query} onClearQuery={() => setQuery('')} filter={filter} empty={sources.length === 0} onAdd={() => setShowCatalogue(true)} />
            {listDivider}
            <Reader id={selected} onLoaded={setCurrent} translate={{ mode: trMode, onMode: setTrMode, target: trSettings.target, aiReady, onTitle: onTitleTranslated, onAsk: askAbout }} />
          </div>
          : tab === 'today' ? <Today aiReady={aiReady} translate={{ target: trSettings.target, aiReady, auto: trSettings.auto, onTitle: () => {}, onAsk: askAbout }} revision={revision} job={job === 'all' || job === 'digest' ? job : null} busy={busy} divider={listDivider} onSetup={() => openSettings('ai')}
              onWrite={() => void runAll(false)} onRewrite={() => void rewriteDigest()} onOpen={openItem} onRead={(id) => void setRead(id, true)} onReport={openReport} onFollow={followOutside}
              onAddWatch={addWatch} onOpenWatch={openWatch} onScreen={setViewScreen} />
          : tab === 'flashes' ? <Flashes aiReady={aiReady} revision={revision} important={importantOnly} divider={listDivider} onSetup={() => openSettings('ai')}
              onOpen={openItem} onReport={openReport} onOpenWatch={openWatch} onCount={(n) => setCounts((c) => ({ ...c, flashes: n }))} onScreen={setViewScreen} />
          : <Watches aiReady={aiReady} revision={revision} query={watchQuery} divider={listDivider} onSetup={() => openSettings('ai')} onOpen={openItem} onReport={openReport}
              onCount={(n, fresh) => setCounts((c) => ({ ...c, watches: n, fresh }))} request={watchRequest} onRequestDone={() => setWatchRequest(null)} onScreen={setViewScreen}
              onSourcesChanged={() => { void loadSources(); void refresh(); }} />}
          </ErrorBoundary></div>
        </div>
      </main>
      {assistantOpen && <>
        <SplitDivider width={panelShown} onChange={resizePanel} min={PANEL.min} max={panelMax} fallback={PANEL.fallback}
          storageKey={PANEL.key} edge="after" label={t('assistant.resize')} />
        <ErrorBoundary><Assistant ai={ai} screen={screen} quote={quote} onExport={(id) => void exportChat(id)} onOpenItem={openItem} onNavigate={(target) => navigateTo.current(target)} onSetup={() => openSettings('ai')} onClose={() => toggleAssistant(false)} /></ErrorBoundary>
      </>}
      {showCatalogue && <Catalogue onClose={(changed) => {
        setShowCatalogue(false); void loadSources(); void loadItems();
        // Newly switched-on sources are empty until fetched.
        if (changed) void refresh();
      }} />}
      {askBackground && <BackgroundPrompt onDone={() => setAskBackground(false)} />}
      <SelectionPopover offer={trSettings.selection} aiReady={aiReady} onAsk={askAbout} />
    </div>
  );
}

/** Tracks the Option key, so a control can show its alternate action as a Mac menu does. */
function useOptionKey(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => setDown(e.altKey);
    const off = (): void => setDown(false);
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', off);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', off); };
  }, []);
  return down;
}

/**
 * 全部更新 — brings every view up to date in one run and writes only what has
 * something new. Holding ⌥ turns it into 全部重新生成, which writes everything
 * again (after changing the output language, say).
 *
 * It sits in the sidebar's title bar, right of the traffic lights, in whatever
 * room the sidebar's width leaves. The words are shown only while they fit (the
 * button then shrinks to its icon, whose name is still its tooltip and
 * accessible label), so the button can never run under the traffic lights or
 * out of the sidebar, in any language and at any width. ⌥'s longer label shows
 * only if it too fits; otherwise the usual one stays.
 */
function UpdateAll({ running, disabled, onRun }: { running: boolean; disabled: boolean; onRun: (force: boolean) => void }) {
  const { t } = useTranslation();
  const option = useOptionKey();
  const slot = useRef<HTMLDivElement>(null);
  const usual = t('app.updateAll');
  const alternate = t('app.regenerateAll');
  const [room, setRoom] = useState({ width: Infinity, usual: 0, alternate: 0 });
  // Each label's real width is measured on an invisible copy of the button, so
  // padding, icon, font and language are all accounted for.
  useLayoutEffect(() => {
    const el = slot.current!;
    const measure = (): void => {
      const next = { width: el.clientWidth, usual: el.querySelector<HTMLElement>('.measure-usual')!.offsetWidth, alternate: el.querySelector<HTMLElement>('.measure-alternate')!.offsetWidth };
      setRoom((r) => (r.width === next.width && r.usual === next.usual && r.alternate === next.alternate ? r : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [usual, alternate]);
  const label = option ? alternate : usual;
  const words = option && room.width >= room.alternate ? alternate : room.width >= room.usual ? usual : null;
  const copy = (text: string, measure: string) => (
    <button className={`tool labeled ${measure}`} aria-hidden tabIndex={-1}><RefreshCw size={14} /><span>{text}</span></button>
  );
  return <div ref={slot} className="update-all-slot">
    {copy(usual, 'measure-usual')}{copy(alternate, 'measure-alternate')}
    <button className={`tool ${words ? 'labeled' : ''}`} disabled={disabled} onClick={(e) => onRun(e.altKey)}
      title={`${label} (${option ? '⌥⇧⌘R' : '⇧⌘R'})\n${t(option ? 'app.regenerateAllHint' : 'app.updateAllHint')}`} aria-label={label}>
      <RefreshCw size={words ? 14 : 16} className={running ? 'spinning' : ''} />{words && <span>{words}</span>}
    </button>
  </div>;
}
