import { SplitDivider } from './components/SplitDivider.tsx';
import { Sun, Zap, BookOpen, Bookmark, Settings as SettingsIcon, Plus, RefreshCw, PanelLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ItemRow, SourceRow } from './types.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { ItemList } from './components/ItemList.tsx';
import { Reader } from './components/Reader.tsx';
import { Catalogue } from './components/Catalogue.tsx';
import { Today } from './components/Today.tsx';
import { Watches } from './components/Watches.tsx';
import { Settings } from './components/Settings.tsx';
import { Flashes } from './components/Flashes.tsx';
import { BackgroundPrompt } from './components/BackgroundPrompt.tsx';

export type Filter = 'all' | 'unread' | 'starred';

/** How many articles the list loads at a time. */
const PAGE = 200;
type Tab = 'today' | 'flashes' | 'read' | 'watches';

const TABS = [{ id: 'today', label: '今日', icon: Sun }, { id: 'flashes', label: '快讯', icon: Zap }, { id: 'read', label: '阅读', icon: BookOpen }, { id: 'watches', label: '关注', icon: Bookmark }] as const;

export default function App() {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [listWidth, setListWidth] = useState(() => {
    try { return Math.max(250, Math.min(440, Number(localStorage.getItem('pnr.listWidth')) || 310)); } catch { return 310; }
  });
  const [tab, setTab] = useState<Tab>('read');
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showCatalogue, setShowCatalogue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [askBackground, setAskBackground] = useState(false);
  const requestId = useRef(0);
  const operation = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadSources = useCallback(async () => setSources(await window.pnr.listSources()), []);
  const loadItems = useCallback(async () => {
    const request = ++requestId.current;
    const query = { ...(sourceId ? { sourceId } : {}), filter };
    const [rows, count] = await Promise.all([window.pnr.listItems({ ...query, limit: PAGE }), window.pnr.countItems(query)]);
    if (request === requestId.current) { setItems(rows); setTotal(count); }
  }, [sourceId, filter]);
  const loadMore = async (): Promise<void> => {
    const request = requestId.current;
    const more = await window.pnr.listItems({ ...(sourceId ? { sourceId } : {}), filter, limit: PAGE, offset: items.length });
    if (request === requestId.current) setItems((prev) => [...prev, ...more.filter((m) => !prev.some((p) => p.id === m.id))]);
  };
  const loadAi = useCallback(async () => {
    const s = await window.pnr.aiStatus();
    setAiReady(s.available);
    return s.available;
  }, []);

  useEffect(() => { void loadSources(); void loadAi(); }, [loadSources, loadAi]);
  useEffect(() => { void loadItems(); }, [loadItems]);

  // Nothing fetched yet on this machine: fetch once so the app is not empty.
  useEffect(() => {
    void (async () => {
      const s = await window.pnr.stats();
      if (s.items === 0 && s.sources > 0) void refresh();
      if ((await window.pnr.today()).digest) setTab('today');
    })();
  }, []);

  useEffect(() => window.pnr.onProgress((p) => {
    const x = p as { phase?: string; label?: string };
    setNote(x.phase === 'watch' ? `正在处理「${x.label}」…`
      : x.phase === 'writing' ? '正在写摘要…'
      : x.phase === 'extracting' ? '正在抽取正文…' : '');
  }), []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const perform = async (message: string, task: () => Promise<string>): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    clearTimeout(noticeTimer.current);
    setBusy(true); setNote(message);
    try { setNote(await task()); }
    catch { setNote('操作未完成，请重试。'); }
    finally {
      operation.current = false; setBusy(false); setRevision((v) => v + 1);
      noticeTimer.current = setTimeout(() => setNote(''), 6000);
    }
  };
  const refresh = (): Promise<void> => perform('正在更新订阅…', async () => {
    const r = await window.pnr.refresh();
    await Promise.all([loadSources(), loadItems()]);
    // First-run consent: once the reader works, ask once whether it may keep
    // collecting news in the background. Nothing is installed without a yes.
    if (!r.busy && !r.error && await window.pnr.backgroundPrompt()) setAskBackground(true);
    return r.busy ? '订阅正在更新' : r.error ? `更新失败：${r.error.slice(0, 70)}` : `已更新 · 新增 ${r.inserted ?? 0} 篇`;
  });
  const runFlashes = (): Promise<void> => perform('正在检查新进展…', async () => {
    const r = await window.pnr.runFlashes();
    void loadItems(); void loadSources();
    return r.busy ? '正在检查，请稍候' : r.error ? `检查失败：${r.error.slice(0, 70)}`
      : `新抓到 ${r.fetched ?? 0} 篇，新增 ${r.flashes ?? 0} 条快讯${r.failed ? `（${r.failed} 项没有完成）` : ''}`;
  });
  const runWatches = (): Promise<void> => perform('正在整理你的关注…', async () => {
    const r = await window.pnr.runWatches();
    void loadItems(); void loadSources();
    return r.busy ? '正在整理，请稍候' : r.error ? `更新失败：${r.error.slice(0, 70)}`
      : r.mode === 'keywords' ? `已按关键词更新 ${r.watches ?? 0} 个关注`
      : `已更新 ${r.watches ?? 0} 个关注${r.digest ? '，今日摘要已生成' : ''}${r.failed ? `（${r.failed} 项没有完成）` : ''}`;
  });

  useEffect(() => window.pnr.onCommand?.(command => {
    if (document.querySelector('dialog[open]')) return;
    if (command === 'settings') setShowSettings(true);
    else if (command === 'sidebar') setSidebarVisible(v => !v);
    else if (command === 'search') { setTab('read'); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="搜索当前列表"]')?.focus()); }
    else if (command === 'subscribe') setShowCatalogue(true);
    else if (command === 'refresh') void refresh();
    else if (TABS.some(t => t.id === command)) setTab(command as Tab);
  }));

  const onSelect = async (id: string): Promise<void> => {
    setSelected(id);
    await window.pnr.markRead(id, true);
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, readAt: Date.now() } : i)));
    void loadSources();
  };

  const onStar = async (id: string): Promise<void> => {
    const on = await window.pnr.toggleStar(id);
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, starredAt: on ? Date.now() : null } : i)).filter(i => filter !== 'starred' || i.starredAt));
    setRevision(v => v + 1);
  };

  const goSetup = (): void => setShowSettings(true);

  /** Opens one article in the reader, from a citation, a headline or a flash. */
  const openItem = (id: string): void => {
    setTab('read');
    void onSelect(id);
  };

  const visibleItems = items.filter(i => `${i.title} ${i.sourceName} ${i.snippet ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const title = TABS.find(t => t.id === tab)!.label;
  const pickSource = (id: string | undefined): void => { setTab('read'); setFilter('all'); setSourceId(id); setSelected(null); setQuery(''); };
  const pickFilter = (value: Filter): void => { setTab('read'); setSourceId(undefined); setFilter(value); setSelected(null); setQuery(''); };

  const selectedIndex = visibleItems.findIndex(i => i.id === selected);
  const stepArticle = (delta: number): void => {
    const next = visibleItems[selectedIndex < 0 ? 0 : selectedIndex + delta];
    if (next) void onSelect(next.id);
  };

  return (
    <div className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`} style={{ '--list-width': `${listWidth}px` } as CSSProperties}>
      <aside className="app-sidebar" hidden={!sidebarVisible}>
        <div className="sidebar-brand"><button className="sidebar-toggle" title="隐藏侧边栏（⌘⌃S）" aria-label="隐藏侧边栏" onClick={() => setSidebarVisible(false)}><PanelLeft size={18} /></button></div>
        <nav className="main-nav" aria-label="主导航">
          {TABS.map(({ id, label, icon: Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined}
            className={tab === id && id !== 'read' ? 'active' : ''} onClick={() => setTab(id)}><Icon size={19} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-content">
          <Sidebar sources={sources} sourceId={sourceId} filter={filter}
            onPickSource={pickSource} onPickFilter={pickFilter} onManage={() => setShowCatalogue(true)} active={tab === 'read'} />
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setShowCatalogue(true)}><Plus size={18} />添加订阅</button>
          <button onClick={() => setShowSettings(true)}><SettingsIcon size={18} />设置<span className="connection">{aiReady ? 'AI 已连接' : '阅读模式'}</span></button>
        </div>
      </aside>
      <main className="workspace">
        <header className="titlebar">
          <div className="window-heading">{!sidebarVisible && <button aria-label="显示侧边栏" title="显示侧边栏（⌘⌃S）" onClick={() => setSidebarVisible(true)}><PanelLeft size={18} /></button>}<h1>{tab === 'read' ? (sources.find(s => s.id === sourceId)?.name ?? '阅读') : title}</h1>{tab === 'read' && <span className="toolbar-subtitle">{total.toLocaleString()} 篇文章</span>}</div>
          <div className="titlebar-actions">
            {tab === 'read' && <div className="article-navigation"><button aria-label="上一篇文章" title="上一篇文章" disabled={selectedIndex <= 0} onClick={() => stepArticle(-1)}><ChevronLeft size={17} /></button><button aria-label="下一篇文章" title="下一篇文章" disabled={!visibleItems.length || selectedIndex === visibleItems.length - 1} onClick={() => stepArticle(1)}><ChevronRight size={17} /></button></div>}
            {tab === 'flashes' && aiReady && <button onClick={() => void runFlashes()} disabled={busy}>检查新进展</button>}
            {(tab === 'today' || tab === 'watches') && <button onClick={() => void runWatches()} disabled={busy}>更新关注</button>}
            <button onClick={() => void refresh()} disabled={busy} title="更新订阅（⌘R）" aria-label="更新订阅"><RefreshCw size={16} className={busy ? 'spinning' : ''} /></button>
          </div>
        </header>
        {tab === 'read' && <div className={`body ${selected ? 'has-selection' : ''}`}>
          <ItemList items={visibleItems} total={query ? visibleItems.length : total}
            onMore={items.length < total && !query ? () => void loadMore() : undefined}
            selected={selected} onSelect={onSelect} onStar={onStar}
            query={query} onQuery={setQuery} filter={filter} onManage={() => setShowCatalogue(true)} />
          <SplitDivider width={listWidth} onChange={setListWidth} />
          <Reader id={selected} onStar={onStar} aiReady={aiReady} revision={revision} onBack={() => setSelected(null)} />
        </div>}
        {tab === 'today' && <Today aiReady={aiReady} onSetup={goSetup} onRun={() => void runWatches()} onOpen={openItem} running={busy} />}
        {tab === 'flashes' && <Flashes aiReady={aiReady} onSetup={goSetup} onRead={() => setTab('read')} onOpen={openItem} running={busy} />}
        {tab === 'watches' && <Watches aiReady={aiReady} onSetup={goSetup} onOpen={openItem} />}
        <footer className="window-status" role="status"><span className={busy ? 'busy-dot' : 'status-dot'} />{note || (tab === 'read' ? `${sources.length} 个订阅源 · ${filter === 'unread' ? '未读文章' : filter === 'starred' ? '我的收藏' : '全部文章'}` : '所闻')}<span className="grow" /><span>{aiReady ? 'AI 已连接' : '阅读模式'}</span></footer>
      </main>
      {showCatalogue && <Catalogue onClose={() => { setShowCatalogue(false); void loadSources(); void loadItems(); }} />}
      {askBackground && <BackgroundPrompt onDone={() => setAskBackground(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} onChanged={() => { void loadAi(); void loadItems(); }} />}
    </div>
  );
}
