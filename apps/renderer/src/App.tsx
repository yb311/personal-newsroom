import { useCallback, useEffect, useState } from 'react';
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

const TABS: [Tab, string][] = [['today', '今日'], ['flashes', '快讯'], ['read', '阅读'], ['watches', '关注']];

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

  const loadSources = useCallback(async () => setSources(await window.pnr.listSources()), []);
  const loadItems = useCallback(async () => {
    setItems(await window.pnr.listItems({ ...(sourceId ? { sourceId } : {}), filter, limit: 200 }));
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

  const refresh = async (): Promise<void> => {
    setBusy(true); setNote('正在抓取…');
    const r = await window.pnr.refresh();
    setNote(r.busy ? '已有一次抓取在进行' : r.error ? `抓取出错：${r.error.slice(0, 70)}` : `新增 ${r.inserted ?? 0} 条`);
    setBusy(false);
    await Promise.all([loadSources(), loadItems()]);
    setTimeout(() => setNote(''), 4000);
  };

  const runFlashes = async (): Promise<void> => {
    setBusy(true); setNote('正在检查新进展…');
    const r = await window.pnr.runFlashes();
    setNote(r.noProvider ? '还没配置 AI' : r.busy ? '已有一次在进行'
      : r.error ? `出错：${r.error.slice(0, 70)}` : `新增 ${r.published ?? 0} 条快讯`);
    setBusy(false);
    setTimeout(() => setNote(''), 5000);
  };

  const runWatches = async (): Promise<void> => {
    setBusy(true); setNote('正在为你的关注生成…');
    const r = await window.pnr.runWatches();
    setNote(r.noProvider ? '还没配置 AI' : r.busy ? '已有一次在进行'
      : r.error ? `出错：${r.error.slice(0, 70)}` : `已更新 ${r.watches ?? 0} 个关注`);
    setBusy(false);
    setTimeout(() => setNote(''), 5000);
  };

  const onSelect = async (id: string): Promise<void> => {
    setSelected(id);
    await window.pnr.markRead(id, true);
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, readAt: Date.now() } : i)));
    void loadSources();
  };

  const onStar = async (id: string): Promise<void> => {
    const on = await window.pnr.toggleStar(id);
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, starredAt: on ? Date.now() : null } : i)));
  };

  const goSetup = (): void => setShowSettings(true);

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">personal&#8202;-&#8202;newsroom</span>
        <nav className="tabs">
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>
          ))}
        </nav>
        <div className="titlebar-actions">
          {note && <span className="note">{note}</span>}
          {tab === 'read' && <button onClick={() => setShowCatalogue(true)}>源目录</button>}
          {tab === 'flashes' && aiReady && (
            <button onClick={() => void runFlashes()} disabled={busy}>{busy ? '检查中…' : '检查新进展'}</button>
          )}
          {(tab === 'today' || tab === 'watches') && aiReady && (
            <button onClick={() => void runWatches()} disabled={busy}>{busy ? '生成中…' : '更新关注'}</button>
          )}
          <button onClick={() => void refresh()} disabled={busy}>{busy ? '抓取中…' : '刷新'}</button>
          <button onClick={() => setShowSettings(true)} title="设置">⚙</button>
        </div>
      </header>

      {tab === 'read' && (
        <div className="body">
          <Sidebar sources={sources} sourceId={sourceId} filter={filter}
                   onPickSource={setSourceId} onPickFilter={setFilter}
                   onManage={() => setShowCatalogue(true)} />
          <ItemList items={items} selected={selected} onSelect={onSelect} onStar={onStar} />
          <Reader id={selected} onStar={onStar} aiReady={aiReady} />
        </div>
      )}
      {tab === 'today' && (
        <Today aiReady={aiReady} onSetup={goSetup} onRun={() => void runWatches()} running={busy} />
      )}
      {tab === 'flashes' && (
        <Flashes aiReady={aiReady} onSetup={goSetup} onRun={() => void runFlashes()} running={busy} />
      )}
      {tab === 'watches' && <Watches aiReady={aiReady} onSetup={goSetup} />}

      {showCatalogue && (
        <Catalogue onClose={() => { setShowCatalogue(false); void loadSources(); void loadItems(); }} />
      )}
      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} onChanged={() => void loadAi()} />
      )}
    </div>
  );
}
