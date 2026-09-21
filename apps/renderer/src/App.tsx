import { Sun, Zap, BookOpen, Bookmark, Settings as SettingsIcon, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemRow, SourceRow } from './types.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { ItemList } from './components/ItemList.tsx';
import { Reader } from './components/Reader.tsx';
import { Catalogue } from './components/Catalogue.tsx';
import { Today } from './components/Today.tsx';
import { Watches } from './components/Watches.tsx';
import { Settings } from './components/Settings.tsx';
import { Flashes } from './components/Flashes.tsx';

export type Filter = 'all' | 'unread' | 'starred';
type Tab = 'today' | 'flashes' | 'read' | 'watches';

const TABS = [{ id: 'today', label: '今日', icon: Sun }, { id: 'flashes', label: '快讯', icon: Zap }, { id: 'read', label: '阅读', icon: BookOpen }, { id: 'watches', label: '关注', icon: Bookmark }] as const;

export default function App() {
  const [tab, setTab] = useState<Tab>('read');
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
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
  const requestId = useRef(0);
  const operation = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadSources = useCallback(async () => setSources(await window.pnr.listSources()), []);
  const loadItems = useCallback(async () => {
    const request = ++requestId.current;
    const rows = await window.pnr.listItems({ ...(sourceId ? { sourceId } : {}), filter, limit: 200 });
    if (request === requestId.current) setItems(rows);
  }, [sourceId, filter]);
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
    return r.busy ? '订阅正在更新' : r.error ? `更新失败：${r.error.slice(0, 70)}` : `已更新 · 新增 ${r.inserted ?? 0} 篇`;
  });
  const runFlashes = (): Promise<void> => perform('正在检查新进展…', async () => {
    const r = await window.pnr.runFlashes();
    return r.noProvider ? '请先连接 AI 服务' : r.busy ? '正在检查，请稍候' : r.error ? `检查失败：${r.error.slice(0, 70)}` : `新增 ${r.published ?? 0} 条快讯`;
  });
  const runWatches = (): Promise<void> => perform('正在整理你的关注…', async () => {
    const r = await window.pnr.runWatches();
    return r.noProvider ? '请先连接 AI 服务' : r.busy ? '正在整理，请稍候' : r.error ? `更新失败：${r.error.slice(0, 70)}` : `已更新 ${r.watches ?? 0} 个关注`;
  });

  useEffect(() => window.pnr.onCommand?.(command => {
    if (document.querySelector('dialog[open]')) return;
    if (command === 'settings') setShowSettings(true);
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

  const visibleItems = items.filter(i => `${i.title} ${i.sourceName} ${i.snippet ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const title = TABS.find(t => t.id === tab)!.label;
  const pickSource = (id: string | undefined): void => { setSourceId(id); setSelected(null); setQuery(''); };
  const pickFilter = (value: Filter): void => { setFilter(value); setSelected(null); setQuery(''); };

  return (
    <div className="app">
      <aside className="app-sidebar">
        <div className="sidebar-brand" aria-hidden="true" />
        <nav className="main-nav" aria-label="主导航">
          {TABS.map(({ id, label, icon: Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined}
            className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={19} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-content">
          {tab === 'read' ? <Sidebar sources={sources} sourceId={sourceId} filter={filter}
            onPickSource={pickSource} onPickFilter={pickFilter} onManage={() => setShowCatalogue(true)} />
            : null}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setShowCatalogue(true)}><Plus size={18} />添加订阅</button>
          <button onClick={() => setShowSettings(true)}><SettingsIcon size={18} />设置<span className="connection">{aiReady ? 'AI 已连接' : '阅读模式'}</span></button>
        </div>
      </aside>
      <main className="workspace">
        <header className="titlebar">
          <h1>{tab === 'read' ? (sources.find(s => s.id === sourceId)?.name ?? '阅读') : title}</h1>
          <div className="titlebar-actions">
            {tab === 'flashes' && aiReady && <button onClick={() => void runFlashes()} disabled={busy}>检查新进展</button>}
            {(tab === 'today' || tab === 'watches') && aiReady && <button onClick={() => void runWatches()} disabled={busy}>更新关注</button>}
            <button onClick={() => void refresh()} disabled={busy} title="更新订阅"><RefreshCw size={16} className={busy ? 'spinning' : ''} /><span>刷新</span></button>
          </div>
        </header>
        {note && <div className="status-note" role="status">{note}</div>}
        {tab === 'read' && <div className={`body ${selected ? 'has-selection' : ''}`}>
          <ItemList items={visibleItems} selected={selected} onSelect={onSelect} onStar={onStar}
            query={query} onQuery={setQuery} filter={filter} onManage={() => setShowCatalogue(true)} />
          <Reader id={selected} onStar={onStar} aiReady={aiReady} revision={revision} onBack={() => setSelected(null)} />
        </div>}
        {tab === 'today' && <Today aiReady={aiReady} onSetup={goSetup} onRead={() => setTab('read')} onRun={() => void runWatches()} running={busy} />}
        {tab === 'flashes' && <Flashes aiReady={aiReady} onSetup={goSetup} onRead={() => setTab('read')} onRun={() => void runFlashes()} running={busy} />}
        {tab === 'watches' && <Watches aiReady={aiReady} onSetup={goSetup} />}
      </main>
      {showCatalogue && <Catalogue onClose={() => { setShowCatalogue(false); void loadSources(); void loadItems(); }} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} onChanged={() => void loadAi()} />}
    </div>
  );
}
