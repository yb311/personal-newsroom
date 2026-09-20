import { useCallback, useEffect, useState } from 'react';
import type { Milestone, PresetRow, WatchRow } from '../types.ts';

/** The 关注 tab. Presets and written intents are the same object; the only
 *  difference is who wrote the sentence. Both expose their recall aids. */
export function Watches({ aiReady, onSetup }: { aiReady: boolean; onSetup: () => void }) {
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: '', intent: '' });

  const load = useCallback(async () => {
    const [w, p] = await Promise.all([window.pnr.watches(), window.pnr.presets()]);
    setWatches(w); setPresets(p);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async (): Promise<void> => {
    const intent = draft.intent.trim();
    if (!intent) return;
    await window.pnr.addWatch({ label: draft.label.trim() || intent.slice(0, 12), intent });
    setDraft({ label: '', intent: '' });
    void load();
  };

  return (
    <section className="pane scroll">
      <div className="pane-inner">
        <h2>用一句话说你想看什么</h2>
        <p className="muted">
          比如「我想知道习近平最近在干什么」或者「跟进这场谈判的进展」。
          写得越具体越好——这句话会原样交给 AI，不会被改写成关键词。
        </p>
        <div className="new-watch">
          <input placeholder="名字（可留空）" value={draft.label}
                 onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <input placeholder="我想知道……" value={draft.intent}
                 onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
                 onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <button className="primary" onClick={() => void add()}>添加</button>
        </div>
        {!aiReady && (
          <p className="muted warn">
            还没有配置 AI，关注不会自动更新。<button className="link" onClick={onSetup}>去设置</button>
          </p>
        )}

        <h2 className="section-gap">我的关注</h2>
        {watches.length === 0 && <p className="muted">还没有关注。写一句话，或者从下面的常用主题里勾一个。</p>}
        <ul className="watch-list">
          {watches.map((w) => (
            <WatchCard key={w.id} watch={w} open={open === w.id}
                       onToggle={() => setOpen(open === w.id ? null : w.id)}
                       onChanged={load} />
          ))}
        </ul>

        <h2 className="section-gap">常用主题</h2>
        <p className="muted">勾一个就能用。它们本质上就是预先写好的那句话，你随时可以改成自己的。</p>
        <ul className="presets">
          {presets.map((p) => (
            <li key={p.id}>
              <label title={p.intent}>
                <input type="checkbox" checked={p.enabled}
                       onChange={async () => { await window.pnr.togglePreset(p.id, !p.enabled); void load(); }} />
                <span>{p.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function WatchCard({ watch, open, onToggle, onChanged }:
  { watch: WatchRow; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const [tl, setTl] = useState<Milestone[]>([]);
  const [intent, setIntent] = useState(watch.intent);

  useEffect(() => {
    if (open) void window.pnr.watchTimeline(watch.id).then((r) => setTl(r.milestones));
  }, [open, watch.id]);

  const save = async (): Promise<void> => {
    if (intent.trim() && intent !== watch.intent) {
      await window.pnr.editWatch(watch.id, { intent: intent.trim() });
      onChanged();
    }
  };

  return (
    <li className={`watch-card ${open ? 'open' : ''}`}>
      <div className="watch-head" onClick={onToggle}>
        <span className="watch-label">{watch.label}</span>
        {watch.origin !== 'intent' && <span className="tag">{watch.origin === 'preset' ? '预置' : '已改'}</span>}
        <span className="grow" />
        {watch.newCount > 0 && <em className="badge">{watch.newCount} 新</em>}
        <em className="muted">{watch.passed} 条入选</em>
      </div>

      {open && (
        <div className="watch-body">
          <label className="field">
            <span>你的原话</span>
            <textarea value={intent} onChange={(e) => setIntent(e.target.value)} onBlur={() => void save()} rows={2} />
          </label>

          {watch.recallAids && (
            <div className="aids">
              <p className="muted">
                AI 用这些词帮你多找一些候选。它们<strong>只会扩大范围，不会筛掉任何东西</strong>，
                所以写错了也不要紧。改了下次运行生效。
              </p>
              <Chips title="别名" items={watch.recallAids.aliases} />
              <Chips title="相关词" items={watch.recallAids.relatedTerms} />
              <Chips title="信源倾向" items={watch.recallAids.sourceHints} />
            </div>
          )}

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
            <button onClick={async () => { await window.pnr.removeWatch(watch.id); onChanged(); }}>删除这个关注</button>
          </div>
        </div>
      )}
    </li>
  );
}

const Chips = ({ title, items }: { title: string; items: string[] }) =>
  items.length === 0 ? null : (
    <div className="chips">
      <span className="chips-title">{title}</span>
      {items.map((x) => <span key={x} className="chip">{x}</span>)}
    </div>
  );
