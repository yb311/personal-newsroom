import { Dialog } from './Dialog.tsx';
import { Plus, Trash2, Search, Bookmark, ArrowLeft, RefreshCw, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ItemRef, Milestone, OpenQuestion, PresetRow, Sensitivity, WatchItem, WatchRow } from '../types.ts';
import { Cites } from './Cites.tsx';

const ago = (ts: number | null): string => {
  if (!ts) return '还没有更新过';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小时前` : new Date(ts).toLocaleDateString('zh-CN');
};
const splitKeywords = (s: string): string[] => s.split(/[,，、;；\n]+/).map((k) => k.trim()).filter(Boolean);

/** The 关注 tab. Presets and written intents are the same object; the only
 *  difference is who wrote the sentence. */
export function Watches({ aiReady, onSetup, onOpen }: { aiReady: boolean; onSetup: () => void; onOpen: (id: string) => void }) {
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const w = await window.pnr.watches();
    setWatches(w);
    setOpen((id) => (w.some((x) => x.id === id) ? id : w[0]?.id ?? null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = watches.find((w) => w.id === open);
  const pick = (id: string | null): void => {
    if (id !== open && dirty && !window.confirm('放弃尚未保存的修改？')) return;
    setDirty(false); setOpen(id);
  };
  const q = query.trim().toLowerCase();

  return (
    <section className={`watch-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="watch-browser" aria-label="关注列表">
        <div className="section-toolbar"><strong>我的关注</strong><span className="grow" />
          <button title="添加关注" aria-label="添加关注" onClick={() => setShowAdd(true)}><Plus size={17} /></button></div>
        <label className="search-field"><Search size={14} /><input type="search" aria-label="搜索关注" placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="watch-rows">
          {watches.filter((w) => `${w.label} ${w.intent} ${w.keywords.join(' ')}`.toLowerCase().includes(q)).map((w) => (
            <button key={w.id} className={`watch-row ${open === w.id ? 'selected' : ''} ${w.active ? '' : 'paused'}`}
                    aria-current={open === w.id ? true : undefined} onClick={() => pick(w.id)}>
              <Bookmark size={16} /><span><strong>{w.label}</strong><small>{w.active ? w.intent : '已暂停'}</small></span>
              {w.newCount > 0 && <em className="badge">{w.newCount}</em>}
            </button>
          ))}
          {watches.length === 0 && <p className="empty-block">还没有关注。<br />写一句你想跟进的事，或从主题库里选。<br /><button onClick={() => setShowAdd(true)}>添加关注</button></p>}
        </div>
        <footer className="list-status">{watches.length} 个关注</footer>
      </aside>
      <div className="watch-detail">
        {!aiReady && watches.length > 0 && (
          <div className="inline-notice">
            还没有连接 AI：现在按每个关注的关键词匹配文章，不会判断是否真的相关，也不会生成进展。
            <button className="link" onClick={onSetup}>连接 AI</button>
          </div>
        )}
        {selected ? <>
          <button className="watch-back" onClick={() => pick(null)}><ArrowLeft size={15} />关注列表</button>
          <WatchDetail key={selected.id} watch={selected} aiReady={aiReady} onChanged={load} onDirty={setDirty} onOpen={onOpen} />
        </> : <div className="empty-state"><Bookmark size={28} /><h2>选择一个关注</h2><p>查看相关报道、进展，或修改设置。</p></div>}
      </div>
      {showAdd && <AddWatch onClose={() => setShowAdd(false)} onAdded={async (id) => { await load(); if (id) setOpen(id); setShowAdd(false); }} />}
    </section>
  );
}

// ── adding ──────────────────────────────────────────────────────────────────

function AddWatch({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string | null) => void }) {
  const [mode, setMode] = useState<'library' | 'custom'>('library');
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState({ label: '', intent: '', keywords: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { void window.pnr.presets().then(setPresets); }, []);
  const groups = useMemo(() => {
    const m = new Map<string, PresetRow[]>();
    for (const p of presets) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [presets]);

  const toggle = (id: string): void => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (mode === 'library') {
        const ids = await window.pnr.addPresets([...picked]);
        onAdded(ids[0] ?? null);
      } else {
        const intent = draft.intent.trim();
        if (!intent) return;
        const w = await window.pnr.addWatch({ label: draft.label.trim() || intent.slice(0, 12), intent, keywords: splitKeywords(draft.keywords) });
        onAdded(w.id);
      }
    } catch { setError('未能添加，请重试。'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog title="添加关注" onClose={() => { if (!busy) onClose(); }} className="add-watch-dialog">
      <header><h2>添加关注</h2>
        <nav className="tabs small">
          <button className={mode === 'library' ? 'active' : ''} onClick={() => setMode('library')}>主题库</button>
          <button className={mode === 'custom' ? 'active' : ''} onClick={() => setMode('custom')}>自己写</button>
        </nav>
      </header>
      {mode === 'library' ? (
        <div className="preset-library">
          <p className="muted">可以多选，一次加好。加完后每个都能改成你自己的话。</p>
          {groups.map(([group, list]) => (
            <div key={group} className="preset-group">
              <h4>{group}</h4>
              <div className="preset-chips">
                {list.map((p) => (
                  <button key={p.id} type="button" title={p.intent} disabled={p.enabled}
                          className={`chip ${picked.has(p.id) ? 'active' : ''}`} onClick={() => toggle(p.id)}>
                    {p.label}{p.enabled ? ' · 已添加' : ''}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <form className="watch-composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="field"><span>想跟进的事（用你自己的话）</span>
            <textarea autoFocus required rows={3} value={draft.intent} onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
                      placeholder="例如：苹果在中国的供应链调整，包括工厂外迁和相关政策" /></label>
          <p className="muted small">写得越具体越好：谁、什么事、你关心哪一面。AI 会按这句话判断每篇文章是否相关。</p>
          <label className="field"><span>名称（选填）</span><input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
          <label className="field"><span>关键词（选填，用逗号分隔）</span>
            <input value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} placeholder="苹果, Apple, 供应链, supply chain" />
            <small className="muted">没有 AI 时按这些词匹配；有 AI 时它们只用来多找一些候选文章。</small></label>
        </form>
      )}
      {error && <p role="alert" className="muted warn">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || (mode === 'library' ? picked.size === 0 : !draft.intent.trim())} onClick={() => void submit()}>
          {busy ? '添加中…' : mode === 'library' ? `添加 ${picked.size || ''} 个关注` : '添加'}
        </button>
      </div>
    </Dialog>
  );
}

// ── one watch ───────────────────────────────────────────────────────────────

type Tab = 'items' | 'timeline' | 'settings';

function WatchDetail({ watch, aiReady, onChanged, onDirty, onOpen }:
  { watch: WatchRow; aiReady: boolean; onChanged: () => void; onDirty: (dirty: boolean) => void; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('items');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);

  const runNow = async (): Promise<void> => {
    setRunning(true); setMessage('正在更新这个关注…');
    try {
      const r = await window.pnr.runWatch(watch.id);
      setMessage(r.busy ? '另一项更新正在进行，请稍后再试' : r.error ? `更新失败：${r.error.slice(0, 60)}`
        : r.mode === 'keywords' ? '已按关键词重新匹配' : `已更新${r.milestones ? `，新增 ${r.milestones} 个进展节点` : ''}`);
      onChanged(); setRevision((v) => v + 1);
    } catch { setMessage('更新失败，请重试。'); }
    finally { setRunning(false); }
  };

  return (
    <section className="watch-inspector">
      <div className="detail-heading">
        <h2>{watch.label}</h2>
        <span className="muted">
          {watch.passed} 篇相关{aiReady && watch.candidates > watch.passed ? ` · 从 ${watch.candidates} 篇候选中选出` : ''} · 上次更新 {ago(watch.lastRunAt)}
        </span>
        <span className="grow" />
        <button onClick={() => void runNow()} disabled={running || !watch.active}><RefreshCw size={14} className={running ? 'spinning' : ''} />立即更新</button>
      </div>
      {message && <p role="status" className="muted small">{message}</p>}
      <nav className="tabs small watch-tabs">
        <button className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>相关报道</button>
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>时间线{watch.newCount ? ` · ${watch.newCount} 新` : ''}</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>设置</button>
      </nav>
      {tab === 'items' && <WatchItems watch={watch} revision={revision} onOpen={onOpen} onChanged={onChanged} />}
      {tab === 'timeline' && <WatchTimeline watch={watch} aiReady={aiReady} revision={revision} onOpen={onOpen} />}
      {tab === 'settings' && <WatchSettings watch={watch} onChanged={onChanged} onDirty={onDirty} />}
    </section>
  );
}

function WatchItems({ watch, revision, onOpen, onChanged }: { watch: WatchRow; revision: number; onOpen: (id: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [noting, setNoting] = useState<{ id: string; verdict: 'wanted' | 'not_wanted' } | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => { void window.pnr.watchItems(watch.id, 80).then(setItems); }, [watch.id, revision]);

  const send = async (): Promise<void> => {
    if (!noting) return;
    await window.pnr.correct(watch.id, noting.id, noting.verdict, note);
    setItems((prev) => noting.verdict === 'not_wanted'
      ? prev?.filter((i) => i.id !== noting.id) ?? null
      : prev?.map((i) => (i.id === noting.id ? { ...i, verdict: 'wanted' } : i)) ?? null);
    setNoting(null); setNote(''); onChanged();
  };

  if (!items) return <p className="muted">载入中…</p>;
  if (items.length === 0) {
    return <p className="muted watch-empty">还没有相关报道。点「立即更新」，或等后台下次更新。{watch.keywords.length === 0 ? '没有 AI 时，需要先在「设置」里填关键词。' : ''}</p>;
  }
  return (
    <>
      <p className="muted small">觉得某篇不该出现，或特别想要这类报道，就点 👍 / 👎，可以写一句理由。AI 下次判断时会看到你的原话。</p>
      <ul className="watch-items">
        {items.map((it) => (
          <li key={it.id}>
            <div className="meta">
              <span className="src">{it.sourceName}</span><span className="dot">·</span>
              <time>{new Date(it.publishedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              {it.arms === 'keyword' ? <span className="tag">关键词匹配 · 未经 AI 判断</span>
                : it.score !== null ? <span className="tag" title="AI 按你的原话打的相关度">相关度 {it.score}/10</span> : null}
              {it.verdict === 'wanted' && <span className="tag ok">你标了「要」</span>}
            </div>
            <button className="headline" onClick={() => onOpen(it.id)}>{it.title}</button>
            {it.reason && <p className="why">{it.reason}</p>}
            {noting?.id === it.id ? (
              <form className="note-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <input autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                       placeholder={noting.verdict === 'wanted' ? '为什么想要这类？（选填）' : '为什么不要？例如「只是顺带提到」（选填）'} />
                <button className="primary">{noting.verdict === 'wanted' ? '标为要' : '标为不要'}</button>
                <button type="button" onClick={() => { setNoting(null); setNote(''); }}>取消</button>
              </form>
            ) : (
              <div className="verdicts">
                <button title="要" aria-label="这篇要" onClick={() => setNoting({ id: it.id, verdict: 'wanted' })}><ThumbsUp size={13} /></button>
                <button title="不要" aria-label="这篇不要" onClick={() => setNoting({ id: it.id, verdict: 'not_wanted' })}><ThumbsDown size={13} /></button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function WatchTimeline({ watch, aiReady, revision, onOpen }: { watch: WatchRow; aiReady: boolean; revision: number; onOpen: (id: string) => void }) {
  const [data, setData] = useState<{ milestones: Milestone[]; refs: ItemRef[]; questions: OpenQuestion[] } | null>(null);
  useEffect(() => { void window.pnr.watchTimeline(watch.id).then(setData); }, [watch.id, revision]);
  const refs = useMemo(() => new Map((data?.refs ?? []).map((r) => [r.id, r])), [data]);

  if (!data) return <p className="muted">载入中…</p>;
  if (!aiReady && data.milestones.length === 0) return <p className="muted watch-empty">时间线由 AI 梳理，连接 AI 后生成。</p>;
  return (
    <>
      {data.questions.length > 0 && (
        <div className="open-questions">
          <h4>待跟进</h4>
          <p className="muted small">上次还没有下文的事，接下来会优先去找。</p>
          <ul>{data.questions.map((q) => <li key={q.id}>{q.question}</li>)}</ul>
        </div>
      )}
      {data.milestones.length === 0
        ? <p className="muted watch-empty">暂无进展。更新后会出现在这里。</p>
        : (
          <div className="timeline">
            <ul>
              {data.milestones.map((m) => (
                <li key={m.id} className={m.isNew ? 'new' : ''}>
                  <time>{m.occurredOn}</time>
                  <span>{m.summary}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} /></span>
                </li>
              ))}
            </ul>
          </div>
        )}
    </>
  );
}

const LANGS: [string, string][] = [['', '跟随全局设置'], ['zh-CN', '中文'], ['en-US', 'English'], ['ja-JP', '日本語']];
const SENSITIVITY: [Sensitivity, string, string][] = [
  ['more', '宁可多看', '沾边的也留下'],
  ['balanced', '平衡', '默认'],
  ['less', '宁可少看', '只留下很确定相关的']
];

function WatchSettings({ watch, onChanged, onDirty }: { watch: WatchRow; onChanged: () => void; onDirty: (dirty: boolean) => void }) {
  const initial = useMemo(() => ({
    label: watch.label, intent: watch.intent, keywords: watch.keywords.join(', '),
    outputLang: watch.outputLang ?? '', sensitivity: watch.sensitivity, active: watch.active
  }), [watch]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const save = async (): Promise<void> => {
    if (!form.intent.trim()) return;
    setSaving(true); setMessage('');
    try {
      await window.pnr.editWatch(watch.id, {
        label: form.label, intent: form.intent, keywords: splitKeywords(form.keywords),
        outputLang: form.outputLang || null, sensitivity: form.sensitivity, active: form.active
      });
      setMessage(form.intent.trim() !== watch.intent ? '已保存。原话改了，下次更新会按新的话重新判断。' : '已保存');
      onDirty(false); onChanged();
    } catch { setMessage('保存失败，请重试。'); }
    finally { setSaving(false); }
  };

  return (
    <div className="watch-body">
      <label className="field"><span>名称</span><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
      <label className="field"><span>你的原话</span>
        <textarea rows={3} value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })} />
        <small className="muted">AI 按这句话逐字判断相关性。</small></label>
      <label className="field"><span>关键词</span>
        <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="用逗号分隔" />
        <small className="muted">没有 AI 时按这些词匹配；有 AI 时只用来多找一些候选。</small></label>
      <label className="field"><span>摘要和进展用什么语言写</span>
        <select value={form.outputLang} onChange={(e) => setForm({ ...form, outputLang: e.target.value })}>
          {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
      <fieldset className="field sensitivity"><legend>筛选松紧</legend>
        {SENSITIVITY.map(([v, l, hint]) => (
          <label key={v} className="inline-check"><input type="radio" name={`s-${watch.id}`} checked={form.sensitivity === v}
            onChange={() => setForm({ ...form, sensitivity: v })} />{l}<span className="muted small"> {hint}</span></label>
        ))}
      </fieldset>
      <label className="inline-check"><input type="checkbox" checked={!form.active} onChange={(e) => setForm({ ...form, active: !e.target.checked })} />暂停这个关注（不再更新，已有内容保留）</label>
      {watch.recallAids && (
        <details className="aids"><summary>AI 生成的辅助检索词</summary>
          <p className="muted">只用来多找候选文章，不影响按你的原话判断。</p>
          <Chips title="别名" items={watch.recallAids.aliases} />
          <Chips title="相关词" items={watch.recallAids.relatedTerms} />
          <Chips title="信源倾向" items={watch.recallAids.sourceHints} />
        </details>
      )}
      <div className="save-row">
        <button className="primary" onClick={() => void save()} disabled={saving || !dirty || !form.intent.trim()}>{saving ? '保存中…' : '保存修改'}</button>
        <span role="status" className="muted">{message}</span>
      </div>
      <div className="watch-actions">
        {confirmDelete
          ? <div className="delete-confirm"><span>删除「{watch.label}」及其时间线？</span>
              <button onClick={() => setConfirmDelete(false)}>取消</button>
              <button className="danger" onClick={async () => { await window.pnr.removeWatch(watch.id); onDirty(false); onChanged(); }}>确认删除</button></div>
          : <button onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除关注</button>}
      </div>
    </div>
  );
}

const Chips = ({ title, items }: { title: string; items: string[] }) =>
  items.length === 0 ? null : (
    <div className="chips">
      <span className="chips-title">{title}</span>
      {items.map((x) => <span key={x} className="chip">{x}</span>)}
    </div>
  );
