import { Dialog } from './Dialog.tsx';
import { Plus, Trash2, Search, Bookmark, ArrowLeft, RefreshCw, ThumbsUp, ThumbsDown, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ItemRef, Milestone, OpenQuestion, PresetRow, Sensitivity, WatchItem, WatchRow } from '../types.ts';
import { Cites } from './Cites.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime } from '../i18n.ts';
const splitKeywords = (s: string): string[] => s.split(/[,，、;；\n]+/).map((k) => k.trim()).filter(Boolean);

/** The 关注 tab. Presets and written intents are the same object; the only
 *  difference is who wrote the sentence. */
export function Watches({ aiReady, onSetup, onOpen, onReport, reportLang }: { aiReady: boolean; onSetup: () => void; onOpen: (id: string) => void; onReport:(a:{anchorItemId:string;itemIds:string[];topic:string;lang:string})=>void; reportLang:string }) {
  const { t } = useTranslation();
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
    if (id !== open && dirty && !window.confirm(t('watches.discard'))) return;
    setDirty(false); setOpen(id);
  };
  const q = query.trim().toLowerCase();

  return (
    <section className={`watch-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="watch-browser" aria-label={t('watches.list')}>
        <div className="section-toolbar"><strong>{t('watches.mine')}</strong><span className="grow" />
          <button title={t('watches.add')} aria-label={t('watches.add')} onClick={() => setShowAdd(true)}><Plus size={17} /></button></div>
        <label className="search-field"><Search size={14} /><input type="search" aria-label={t('watches.search')} placeholder={t('watches.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="watch-rows">
          {watches.filter((w) => `${w.label} ${w.intent} ${w.keywords.join(' ')}`.toLowerCase().includes(q)).map((w) => (
            <button key={w.id} className={`watch-row ${open === w.id ? 'selected' : ''} ${w.active ? '' : 'paused'}`}
                    aria-current={open === w.id ? true : undefined} onClick={() => pick(w.id)}>
              <Bookmark size={16} /><span><strong>{w.label}</strong><small>{w.active ? w.intent : t('watches.paused')}</small></span>
              {w.newCount > 0 && <em className="badge">{w.newCount}</em>}
            </button>
          ))}
          {watches.length === 0 && <p className="empty-block">{t('watches.emptyLine1')}<br />{t('watches.emptyLine2')}<br /><button onClick={() => setShowAdd(true)}>{t('watches.add')}</button></p>}
        </div>
        <footer className="list-status">{t('watches.count', { count: watches.length })}</footer>
      </aside>
      <div className="watch-detail">
        {!aiReady && watches.length > 0 && (
          <div className="inline-notice">
            {t('watches.noAi')}
            <button className="link" onClick={onSetup}>{t('common.connectAi')}</button>
          </div>
        )}
        {selected ? <>
          <button className="watch-back" onClick={() => pick(null)}><ArrowLeft size={15} />{t('watches.list')}</button>
          <WatchDetail key={selected.id} watch={selected} aiReady={aiReady} onChanged={load} onDirty={setDirty} onOpen={onOpen} onReport={onReport} reportLang={reportLang} />
        </> : <div className="empty-state"><Bookmark size={28} /><h2>{t('watches.pickTitle')}</h2><p>{t('watches.pickHint')}</p></div>}
      </div>
      {showAdd && <AddWatch onClose={() => setShowAdd(false)} onAdded={async (id) => { await load(); if (id) setOpen(id); setShowAdd(false); }} />}
    </section>
  );
}

// ── adding ──────────────────────────────────────────────────────────────────

function AddWatch({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string | null) => void }) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'library' | 'custom'>('library');
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState({ label: '', intent: '', keywords: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { void window.pnr.presets(i18n.language).then(setPresets); }, [i18n.language]);
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
        const ids = await window.pnr.addPresets([...picked], i18n.language);
        onAdded(ids[0] ?? null);
      } else {
        const intent = draft.intent.trim();
        if (!intent) return;
        const w = await window.pnr.addWatch({ label: draft.label.trim() || intent.slice(0, 12), intent, keywords: splitKeywords(draft.keywords) });
        onAdded(w.id);
      }
    } catch { setError(t('watches.addFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Dialog title={t('watches.add')} onClose={() => { if (!busy) onClose(); }} className="add-watch-dialog">
      <header><h2>{t('watches.add')}</h2>
        <nav className="tabs small">
          <button className={mode === 'library' ? 'active' : ''} onClick={() => setMode('library')}>{t('watches.library')}</button>
          <button className={mode === 'custom' ? 'active' : ''} onClick={() => setMode('custom')}>{t('watches.custom')}</button>
        </nav>
      </header>
      {mode === 'library' ? (
        <div className="preset-library">
          <p className="muted">{t('watches.libraryHint')}</p>
          {groups.map(([group, list]) => (
            <div key={group} className="preset-group">
              <h4>{t(`watches.groups.${group}`, { defaultValue: group })}</h4>
              <div className="preset-chips">
                {list.map((p) => (
                  <button key={p.id} type="button" title={p.intent} disabled={p.enabled}
                          className={`chip ${picked.has(p.id) ? 'active' : ''}`} onClick={() => toggle(p.id)}>
                    {p.label}{p.enabled ? t('watches.alreadyAdded') : ''}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <form className="watch-composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="field"><span>{t('watches.intentLabel')}</span>
            <textarea autoFocus required rows={3} value={draft.intent} onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
                      placeholder={t('watches.intentPlaceholder')} /></label>
          <p className="muted small">{t('watches.intentHint')}</p>
          <label className="field"><span>{t('watches.nameOptional')}</span><input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
          <label className="field"><span>{t('watches.keywordsOptional')}</span>
            <input value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} placeholder={t('watches.keywordsPlaceholder')} />
            <small className="muted">{t('watches.keywordsHint')}</small></label>
        </form>
      )}
      {error && <p role="alert" className="muted warn">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={busy || (mode === 'library' ? picked.size === 0 : !draft.intent.trim())} onClick={() => void submit()}>
          {busy ? t('watches.adding') : mode === 'library' && picked.size ? t('watches.addN', { count: picked.size }) : mode === 'library' ? t('watches.add') : t('common.add')}
        </button>
      </div>
    </Dialog>
  );
}

// ── one watch ───────────────────────────────────────────────────────────────

type Tab = 'items' | 'timeline' | 'settings';

function WatchDetail({ watch, aiReady, onChanged, onDirty, onOpen, onReport, reportLang }:
  { watch: WatchRow; aiReady: boolean; onChanged: () => void; onDirty: (dirty: boolean) => void; onOpen: (id: string) => void; onReport:(a:{anchorItemId:string;itemIds:string[];topic:string;lang:string})=>void; reportLang:string }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('items');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);

  const runNow = async (): Promise<void> => {
    setRunning(true); setMessage(t('watches.updatingOne'));
    try {
      const r = await window.pnr.runWatch(watch.id);
      setMessage(r.busy ? t('watches.busy') : r.error ? t('watches.updateFailed', { error: r.error.slice(0, 60) })
        : r.mode === 'keywords' ? t('watches.rematched') : t('watches.updated') + (r.milestones ? t('watches.newMilestones', { count: r.milestones }) : ''));
      onChanged(); setRevision((v) => v + 1);
    } catch { setMessage(t('watches.updateError')); }
    finally { setRunning(false); }
  };

  return (
    <section className="watch-inspector">
      <div className="detail-heading">
        <h2>{watch.label}</h2>
        <span className="muted">
          {t('watches.relevant', { count: watch.passed })}{aiReady && watch.candidates > watch.passed ? t('watches.fromCandidates', { count: watch.candidates }) : ''}{watch.lastRunAt ? t('watches.lastUpdated', { when: ago(watch.lastRunAt) }) : t('watches.neverUpdated')}
        </span>
        <span className="grow" />
        <button onClick={() => void runNow()} disabled={running || !watch.active}><RefreshCw size={14} className={running ? 'spinning' : ''} />{t('watches.updateNow')}</button>
      </div>
      {message && <p role="status" className="muted small">{message}</p>}
      <nav className="tabs small watch-tabs">
        {(['items', 'timeline', 'settings'] as const).map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {t(`watches.tabs.${id}`)}{id === 'timeline' && watch.newCount ? t('watches.newCount', { count: watch.newCount }) : ''}
          </button>
        ))}
      </nav>
      {tab === 'items' && <WatchItems watch={watch} revision={revision} onOpen={onOpen} onChanged={onChanged} onReport={onReport} reportLang={reportLang} />}
      {tab === 'timeline' && <WatchTimeline watch={watch} aiReady={aiReady} revision={revision} onOpen={onOpen} onReport={onReport} reportLang={reportLang} />}
      {tab === 'settings' && <WatchSettings watch={watch} onChanged={onChanged} onDirty={onDirty} />}
    </section>
  );
}

function WatchItems({ watch, revision, onOpen, onChanged, onReport, reportLang }: { watch: WatchRow; revision: number; onOpen: (id: string) => void; onChanged: () => void; onReport:(a:{anchorItemId:string;itemIds:string[];topic:string;lang:string})=>void; reportLang:string }) {
  const { t } = useTranslation();
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

  if (!items) return <p className="muted">{t('common.loading')}</p>;
  if (items.length === 0) {
    return <p className="muted watch-empty">{t('watches.noItems')}{watch.keywords.length === 0 ? t('watches.noItemsKeywords') : ''}</p>;
  }
  return (
    <>
      <p className="muted small">{t('watches.verdictHint')}</p>
      <ul className="watch-items">
        {items.map((it) => (
          <li key={it.id}>
            <div className="meta">
              <span className="src">{it.sourceName}</span><span className="dot">·</span>
              <time>{dateTime(it.publishedAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              {it.arms === 'keyword' ? <span className="tag">{t('watches.keywordMatch')}</span>
                : it.score !== null ? <span className="tag" title={t('watches.scoreHint')}>{t('watches.score', { score: it.score })}</span> : null}
              {it.verdict === 'wanted' && <span className="tag ok">{t('watches.markedWanted')}</span>}
            </div>
            <button className="headline" onClick={() => onOpen(it.id)}>{it.title}</button>
            <button className="report-open" onClick={() => onReport({anchorItemId:it.id,itemIds:[it.id],topic:it.title,lang:watch.outputLang ?? reportLang})}><Sparkles size={12}/>{t('report.open')}</button>
            {it.reason && <p className="why">{it.reason}</p>}
            {noting?.id === it.id ? (
              <form className="note-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <input autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                       placeholder={noting.verdict === 'wanted' ? t('watches.whyWanted') : t('watches.whyNot')} />
                <button className="primary">{noting.verdict === 'wanted' ? t('watches.markWanted') : t('watches.markNot')}</button>
                <button type="button" onClick={() => { setNoting(null); setNote(''); }}>{t('common.cancel')}</button>
              </form>
            ) : (
              <div className="verdicts">
                <button title={t('watches.want')} aria-label={t('watches.wantThis')} onClick={() => setNoting({ id: it.id, verdict: 'wanted' })}><ThumbsUp size={13} /></button>
                <button title={t('watches.notWant')} aria-label={t('watches.notWantThis')} onClick={() => setNoting({ id: it.id, verdict: 'not_wanted' })}><ThumbsDown size={13} /></button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function WatchTimeline({ watch, aiReady, revision, onOpen, onReport, reportLang }: { watch: WatchRow; aiReady: boolean; revision: number; onOpen: (id: string) => void; onReport:(a:{anchorItemId:string;itemIds:string[];topic:string;lang:string})=>void; reportLang:string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{ milestones: Milestone[]; refs: ItemRef[]; questions: OpenQuestion[] } | null>(null);
  useEffect(() => { void window.pnr.watchTimeline(watch.id).then(setData); }, [watch.id, revision]);
  const refs = useMemo(() => new Map((data?.refs ?? []).map((r) => [r.id, r])), [data]);

  if (!data) return <p className="muted">{t('common.loading')}</p>;
  if (!aiReady && data.milestones.length === 0) return <p className="muted watch-empty">{t('watches.timelineNeedsAi')}</p>;
  return (
    <>
      {data.questions.length > 0 && (
        <div className="open-questions">
          <h4>{t('watches.openQuestions')}</h4>
          <p className="muted small">{t('watches.openQuestionsHint')}</p>
          <ul>{data.questions.map((q) => <li key={q.id}>{q.question}</li>)}</ul>
        </div>
      )}
      {data.milestones.length === 0
        ? <p className="muted watch-empty">{t('watches.noMilestones')}</p>
        : (
          <div className="timeline">
            <ul>
              {data.milestones.map((m) => (
                <li key={m.id} className={m.isNew ? 'new' : ''}>
                  <time>{m.occurredOn}</time>
                  <span>{m.summary}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} />{m.itemIds[0] && <button className="report-open" onClick={() => onReport({anchorItemId:m.itemIds[0]!,itemIds:m.itemIds,topic:m.summary,lang:watch.outputLang ?? reportLang})}><Sparkles size={12}/>{t('report.open')}</button>}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
    </>
  );
}

/** Output languages, each named in itself; '' follows the global setting. */
const LANGS: [string, string][] = [['zh-CN', '中文'], ['en-US', 'English'], ['ja-JP', '日本語']];
const SENSITIVITY: Sensitivity[] = ['more', 'balanced', 'less'];

function WatchSettings({ watch, onChanged, onDirty }: { watch: WatchRow; onChanged: () => void; onDirty: (dirty: boolean) => void }) {
  const { t } = useTranslation();
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
      setMessage(form.intent.trim() !== watch.intent ? t('watches.savedIntentChanged') : t('common.saved'));
      onDirty(false); onChanged();
    } catch { setMessage(t('common.saveFailed')); }
    finally { setSaving(false); }
  };

  return (
    <div className="watch-body">
      <label className="field"><span>{t('watches.name')}</span><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
      <label className="field"><span>{t('watches.intent')}</span>
        <textarea rows={3} value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })} />
        <small className="muted">{t('watches.intentJudge')}</small></label>
      <label className="field"><span>{t('watches.keywords')}</span>
        <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder={t('watches.keywordsComma')} />
        <small className="muted">{t('watches.keywordsHintShort')}</small></label>
      <label className="field"><span>{t('watches.outputLang')}</span>
        <select value={form.outputLang} onChange={(e) => setForm({ ...form, outputLang: e.target.value })}>
          <option value="">{t('watches.followGlobal')}</option>
          {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
      <fieldset className="field sensitivity"><legend>{t('watches.strictness')}</legend>
        {SENSITIVITY.map((v) => (
          <label key={v} className="inline-check"><input type="radio" name={`s-${watch.id}`} checked={form.sensitivity === v}
            onChange={() => setForm({ ...form, sensitivity: v })} />{t(`watches.sensitivity.${v}`)}<span className="muted small"> {t(`watches.sensitivity.${v}Hint`)}</span></label>
        ))}
      </fieldset>
      <label className="inline-check"><input type="checkbox" checked={!form.active} onChange={(e) => setForm({ ...form, active: !e.target.checked })} />{t('watches.pause')}</label>
      {watch.recallAids && (
        <details className="aids"><summary>{t('watches.aids')}</summary>
          <p className="muted">{t('watches.aidsHint')}</p>
          <Chips title={t('watches.aliases')} items={watch.recallAids.aliases} />
          <Chips title={t('watches.related')} items={watch.recallAids.relatedTerms} />
          <Chips title={t('watches.sourceHints')} items={watch.recallAids.sourceHints} />
        </details>
      )}
      <div className="save-row">
        <button className="primary" onClick={() => void save()} disabled={saving || !dirty || !form.intent.trim()}>{saving ? t('common.saving') : t('watches.saveChanges')}</button>
        <span role="status" className="muted">{message}</span>
      </div>
      <div className="watch-actions">
        {confirmDelete
          ? <div className="delete-confirm"><span>{t('watches.confirmDelete', { label: watch.label })}</span>
              <button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
              <button className="danger" onClick={async () => { await window.pnr.removeWatch(watch.id); onDirty(false); onChanged(); }}>{t('watches.deleteConfirm')}</button></div>
          : <button onClick={() => setConfirmDelete(true)}><Trash2 size={14} />{t('watches.delete')}</button>}
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
