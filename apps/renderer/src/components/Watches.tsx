import { Dialog } from './Dialog.tsx';
import { Plus, Trash2, Search, Bookmark, ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Milestone, PresetRow, WatchRow } from '../types.ts';

/** The 关注 tab. Presets and written intents are the same object; the only
 *  difference is who wrote the sentence. Both expose their recall aids. */
export function Watches({ aiReady, onSetup }: { aiReady: boolean; onSetup: () => void }) {
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({ label: '', intent: '' });

  const load = useCallback(async () => {
    const [w, p] = await Promise.all([window.pnr.watches(), window.pnr.presets()]);
    setWatches(w); setPresets(p);
    setOpen(id => w.some(x => x.id === id) ? id : w[0]?.id ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async (): Promise<void> => {
    const intent = draft.intent.trim();
    if (!intent || adding) return;
    setAdding(true); setError('');
    try {
      const watch = await window.pnr.addWatch({ label: draft.label.trim() || intent.slice(0, 12), intent });
      setDraft({ label: '', intent: '' }); await load(); setOpen(watch.id); setShowAdd(false); setDirty(false);
    } catch { setError('未能添加关注，请重试。'); }
    finally { setAdding(false); }
  };

  const selected = watches.find(w => w.id === open);
  const pick = (id: string): void => {
    if (id !== open && dirty && !window.confirm('放弃尚未保存的修改？')) return;
    setDirty(false); setOpen(id);
  };
  return (
    <section className={`watch-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="watch-browser" aria-label="关注列表">
        <div className="section-toolbar"><strong>我的关注</strong><span className="grow" /><button title="添加关注" aria-label="添加关注" onClick={() => setShowAdd(true)}><Plus size={17} /></button></div>
        <label className="search-field"><Search size={14} /><input type="search" aria-label="搜索关注" placeholder="搜索" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="watch-rows">{watches.filter(w => `${w.label} ${w.intent}`.includes(query)).map(w => <button key={w.id} className={`watch-row ${open === w.id ? 'selected' : ''}`} aria-current={open === w.id ? true : undefined} onClick={() => pick(w.id)}>
          <Bookmark size={16} /><span><strong>{w.label}</strong><small>{w.intent}</small></span>{w.newCount > 0 && <em className="badge">{w.newCount}</em>}
        </button>)}{watches.length === 0 && <p className="empty-block">尚无关注<br /><button onClick={() => setShowAdd(true)}>添加关注</button></p>}</div>
        <footer className="list-status">{watches.length} 个关注</footer>
      </aside>
      <div className="watch-detail">
        {selected ? <><button className="watch-back" onClick={() => { if (!dirty || window.confirm('放弃尚未保存的修改？')) { setDirty(false); setOpen(null); } }}><ArrowLeft size={15} />关注列表</button>
          <WatchCard key={selected.id} watch={selected} onChanged={load} onDirty={setDirty} />
        </> : <div className="empty-state"><Bookmark size={28} /><h2>选择一个关注</h2><p>查看进展或编辑关注内容。</p></div>}
        {!aiReady && <div className="inline-notice">自动整理需要 AI。<button className="link" onClick={onSetup}>打开设置</button></div>}
      </div>
      {showAdd && <Dialog title="添加关注" onClose={() => { if (!adding) setShowAdd(false); }} className="add-watch-dialog">
        <header><h2>添加关注</h2></header>
        <form className="watch-composer" onSubmit={e => { e.preventDefault(); void add(); }}>
          <label className="field"><span>名称（选填）</span><input autoFocus value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
          <label className="field"><span>想关注的事</span><textarea required rows={3} placeholder="例如：人工智能在医疗领域的最新进展" value={draft.intent} onChange={e => setDraft({ ...draft, intent: e.target.value })} /></label>
          <details className="preset-disclosure"><summary>从常用主题选择</summary><ul className="presets">{presets.map(p => <li key={p.id}><button type="button" onClick={() => setDraft({label:p.label,intent:p.intent})}>{p.label}</button></li>)}</ul></details>
          {error && <p role="alert" className="muted warn">{error}</p>}
          <div className="dialog-actions"><button type="button" disabled={adding} onClick={() => setShowAdd(false)}>取消</button><button className="primary" disabled={adding || !draft.intent.trim()}>{adding ? '添加中…' : '添加'}</button></div>
        </form>
      </Dialog>}
    </section>
  );
}

function WatchCard({ watch, onChanged, onDirty }:
  { watch: WatchRow; onChanged: () => void; onDirty: (dirty: boolean) => void }) {
  const [tl, setTl] = useState<Milestone[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [intent, setIntent] = useState(watch.intent);

  useEffect(() => {
    let live = true;
    void window.pnr.watchTimeline(watch.id).then(r => { if (live) setTl(r.milestones); }).catch(() => { if (live) setMessage('进展暂时无法载入'); });
    return () => { live = false; };
  }, [watch.id]);

  const save = async (): Promise<void> => {
    if (intent.trim() && intent !== watch.intent) {
      setSaving(true); setMessage('');
      try { await window.pnr.editWatch(watch.id, { intent: intent.trim() }); onDirty(false); onChanged(); setMessage('已保存'); }
      catch { setMessage('保存失败，请重试。'); }
      finally { setSaving(false); }
    }
  };

  return (
    <section className="watch-inspector">
      <div className="detail-heading"><h2>{watch.label}</h2><span className="muted">{watch.passed} 篇相关报道</span></div>
        <div className="watch-body">
          <label className="field">
            <span>你的原话</span>
            <textarea value={intent} onChange={(e) => { setIntent(e.target.value); onDirty(e.target.value !== watch.intent); }} rows={2} />
          </label>

          <div className="save-row"><button onClick={() => void save()} disabled={saving || !intent.trim() || intent === watch.intent}>{saving ? '保存中…' : '保存修改'}</button><span role="status" className="muted">{message}</span></div>
          {watch.recallAids && (
            <details className="aids"><summary>查看辅助检索词</summary>
              <p className="muted">
                用于发现更多相关报道，不影响按你的原话判断。
              </p>
              <Chips title="别名" items={watch.recallAids.aliases} />
              <Chips title="相关词" items={watch.recallAids.relatedTerms} />
              <Chips title="信源倾向" items={watch.recallAids.sourceHints} />
            </details>
          )}

          {tl.length === 0 && <div className="timeline"><h4>进展</h4><p className="muted">暂无进展。更新关注后会出现在这里。</p></div>}
          {tl.length > 0 && (
            <div className="timeline">
              <h4>时间线</h4>
              <ul>
                {tl.map((m) => (
                  <li key={m.id} className={m.isNew ? 'new' : ''}>
                    <time>{m.occurredOn}</time>
                    <span>{m.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="watch-actions">
            {confirmDelete ? <div className="delete-confirm"><span>删除「{watch.label}」及其关注记录？</span><button onClick={() => setConfirmDelete(false)}>取消</button><button className="danger" onClick={async () => { try { await window.pnr.removeWatch(watch.id); onDirty(false); onChanged(); } catch { setMessage('删除失败，请重试。'); } }}>确认删除</button></div> : <button onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除关注</button>}
          </div>
        </div>
    </section>
  );
}

const Chips = ({ title, items }: { title: string; items: string[] }) =>
  items.length === 0 ? null : (
    <div className="chips">
      <span className="chips-title">{title}</span>
      {items.map((x) => <span key={x} className="chip">{x}</span>)}
    </div>
  );
