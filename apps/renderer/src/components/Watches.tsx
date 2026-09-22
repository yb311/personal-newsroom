import { Dialog } from './Dialog.tsx';
import { Plus, Trash2, Search, Bookmark, ArrowLeft, RefreshCw, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ItemRef, Milestone, OpenQuestion, OutsidePick, PresetRow, Sensitivity, WatchItem, WatchRow } from '../types.ts';
import { Cites } from './Cites.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime } from '../i18n.ts';
const splitKeywords = (s: string): string[] => s.split(/[,，、;；\n]+/).map((k) => k.trim()).filter(Boolean);

/** Something else in the window asked to add a watch, optionally prefilled. */
export interface WatchRequest { draft: OutsidePick['suggestion'] | null }

/** The 关注 tab. Presets and written intents are the same object; the only
 *  difference is who wrote the sentence. */
export function Watches({ aiReady, revision, onSetup, onOpen, request, onRequestDone }: {
  aiReady: boolean; revision: number; onSetup: () => void; onOpen: (id: string) => void;
  request: WatchRequest | null; onRequestDone: () => void;
}) {
  const { t } = useTranslation();
  const [watches, setWatches] = useState<WatchRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<WatchRequest | null>(null);
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const w = await window.pnr.watches();
    setWatches(w);
    setOpen((id) => (w.some((x) => x.id === id) ? id : w[0]?.id ?? null));
  }, []);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => { if (request) { setAdding(request); onRequestDone(); } }, [request, onRequestDone]);

  const list = watches ?? [];
  const selected = list.find((w) => w.id === open);
  const confirmLeave = (): boolean => !dirty || window.confirm(t('watches.discard'));
  const pick = (id: string | null): void => {
    if (id === open || !confirmLeave()) return;
    setDirty(false); setOpen(id);
  };
  const q = query.trim().toLowerCase();
  const shown = list.filter((w) => `${w.label} ${w.intent} ${w.keywords.join(' ')}`.toLowerCase().includes(q));

  return (
    <section className={`watch-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="watch-browser" aria-label={t('watches.list')}>
        <div className="list-toolbar">
          <label className="search-field"><Search size={14} /><input type="search" aria-label={t('watches.search')} placeholder={t('watches.search')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <button className="icon" title={t('watches.add')} aria-label={t('watches.add')} onClick={() => setAdding({ draft: null })}><Plus size={16} /></button>
        </div>
        <div className="watch-rows">
          {shown.map((w) => (
            <button key={w.id} className={`watch-row ${open === w.id ? 'selected' : ''} ${w.active ? '' : 'paused'}`}
                    aria-current={open === w.id ? true : undefined} onClick={() => pick(w.id)}>
              <span><strong>{w.label}</strong><small>{w.active ? w.intent : t('watches.paused')}</small></span>
              {w.newCount > 0 && <em className="badge" title={t('watches.newTitle', { count: w.newCount })}>{w.newCount}</em>}
            </button>
          ))}
          {watches && list.length === 0 && <div className="empty-state compact">
            <p>{t('watches.empty')}</p>
            <button className="primary" onClick={() => setAdding({ draft: null })}>{t('watches.add')}</button>
          </div>}
          {list.length > 0 && shown.length === 0 && <p className="section-hint pad">{t('watches.noMatch')}</p>}
        </div>
      </aside>
      <div className="watch-detail">
        {!aiReady && list.length > 0 && (
          <div className="notice">{t('watches.noAi')}<button className="link" onClick={onSetup}>{t('common.connectAi')}</button></div>
        )}
        {selected ? <>
          <button className="watch-back secondary" onClick={() => pick(null)}><ArrowLeft size={15} />{t('watches.list')}</button>
          <WatchDetail key={selected.id} watch={selected} aiReady={aiReady} revision={revision} onChanged={load}
            dirty={dirty} onDirty={setDirty} confirmLeave={confirmLeave} onOpen={onOpen} />
        </> : watches && list.length > 0 && <div className="empty-state"><Bookmark size={26} strokeWidth={1.6} /><h3>{t('watches.pickTitle')}</h3><p>{t('watches.pickHint')}</p></div>}
      </div>
      {adding && <AddWatch prefill={adding.draft} onClose={() => setAdding(null)}
        onAdded={async (id) => { setAdding(null); await load(); if (id) { setDirty(false); setOpen(id); } }} />}
    </section>
  );
}

// ── adding ──────────────────────────────────────────────────────────────────

function AddWatch({ onClose, onAdded, prefill }: { onClose: () => void; onAdded: (id: string | null) => void; prefill: OutsidePick['suggestion'] | null }) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'library' | 'custom'>(prefill ? 'custom' : 'library');
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState({ label: prefill?.label ?? '', intent: prefill?.intent ?? '', keywords: prefill?.keywords.join(', ') ?? '' });
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
  const ready = mode === 'library' ? picked.size > 0 : Boolean(draft.intent.trim());

  const submit = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true); setError('');
    try {
      if (mode === 'library') {
        const ids = await window.pnr.addPresets([...picked], i18n.language);
        onAdded(ids[0] ?? null);
      } else {
        const intent = draft.intent.trim();
        const w = await window.pnr.addWatch({ label: draft.label.trim() || intent.slice(0, 16), intent, keywords: splitKeywords(draft.keywords) });
        onAdded(w.id);
      }
    } catch { setError(t('watches.addFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Dialog title={t('watches.add')} onClose={() => { if (!busy) onClose(); }} className="add-watch-dialog">
      <header><h2>{t('watches.add')}</h2>
        <nav className="segmented" aria-label={t('watches.addMode')}>
          <button className={mode === 'library' ? 'active' : ''} aria-pressed={mode === 'library'} onClick={() => setMode('library')}>{t('watches.library')}</button>
          <button className={mode === 'custom' ? 'active' : ''} aria-pressed={mode === 'custom'} onClick={() => setMode('custom')}>{t('watches.custom')}</button>
        </nav>
      </header>
      <div className="dialog-body">
        {mode === 'library' ? (
          <>
            <p className="section-hint">{t('watches.libraryHint')}</p>
            {groups.map(([group, list]) => (
              <div key={group} className="preset-group">
                <h4>{t(`watches.groups.${group}`, { defaultValue: group })}</h4>
                <div className="chips">
                  {list.map((p) => (
                    <button key={p.id} type="button" title={p.intent} disabled={p.enabled} aria-pressed={picked.has(p.id)}
                            className={`chip ${picked.has(p.id) ? 'active' : ''}`} onClick={() => toggle(p.id)}>
                      {p.label}{p.enabled ? t('watches.alreadyAdded') : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <label className="field"><span>{t('watches.intent')}</span>
              <textarea autoFocus required rows={3} value={draft.intent} onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
                        placeholder={t('watches.intentPlaceholder')} />
              <small>{t('watches.intentHint')}</small></label>
            <label className="field"><span>{t('watches.name')}<i>{t('common.optional')}</i></span>
              <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
            <label className="field"><span>{t('watches.keywords')}<i>{t('common.optional')}</i></span>
              <input value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} placeholder={t('watches.keywordsPlaceholder')} />
              <small>{t('watches.keywordsHint')}</small></label>
          </form>
        )}
        {error && <p role="alert" className="error-text">{error}</p>}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? t('common.adding') : mode === 'library' && picked.size ? t('watches.addN', { count: picked.size }) : t('common.add')}
        </button>
      </footer>
    </Dialog>
  );
}

// ── one watch ───────────────────────────────────────────────────────────────

type Tab = 'items' | 'timeline' | 'settings';

function WatchDetail({ watch, aiReady, revision: outer, onChanged, dirty, onDirty, confirmLeave, onOpen }: {
  watch: WatchRow; aiReady: boolean; revision: number; onChanged: () => void;
  dirty: boolean; onDirty: (dirty: boolean) => void; confirmLeave: () => boolean; onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('items');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [local, setLocal] = useState(0);
  const revision = outer + local;
  // Leaving the settings form unmounts it; ask first rather than drop edits silently.
  const switchTab = (next: Tab): void => {
    if (next === tab || (tab === 'settings' && dirty && !confirmLeave())) return;
    if (tab === 'settings') onDirty(false);
    setTab(next);
  };

  const runNow = async (): Promise<void> => {
    setRunning(true); setMessage(t('watches.updatingOne'));
    try {
      const r = await window.pnr.runWatch(watch.id);
      setMessage(r.busy ? t('watches.busy') : r.error ? t('watches.updateFailed', { error: r.error.slice(0, 60) })
        : r.mode === 'keywords' ? t('watches.rematched') : t('watches.updated') + (r.milestones ? t('watches.newMilestones', { count: r.milestones }) : ''));
      onChanged(); setLocal((v) => v + 1);
    } catch { setMessage(t('watches.updateError')); }
    finally { setRunning(false); }
  };

  return (
    <section className="watch-inspector">
      <div className="detail-heading">
        <div>
          <h2>{watch.label}</h2>
          <p className="section-hint">
            {t('watches.relevant', { count: watch.passed })}{aiReady && watch.candidates > watch.passed ? t('watches.fromCandidates', { count: watch.candidates }) : ''}
            {' · '}{watch.lastRunAt ? t('watches.lastUpdated', { when: ago(watch.lastRunAt) }) : t('watches.neverUpdated')}
          </p>
        </div>
        <button className="secondary" onClick={() => void runNow()} disabled={running || !watch.active} title={watch.active ? undefined : t('watches.paused')}>
          <RefreshCw size={14} className={running ? 'spinning' : ''} />{t('watches.updateNow')}</button>
      </div>
      {message && <p role="status" className="section-hint">{message}</p>}
      <nav className="segmented tabs" aria-label={t('watches.sections')}>
        {(['items', 'timeline', 'settings'] as const).map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => switchTab(id)}>
            {t(`watches.tabs.${id}`)}{id === 'timeline' && watch.newCount ? <em className="badge">{watch.newCount}</em> : null}
          </button>
        ))}
      </nav>
      {tab === 'items' && <WatchItems watch={watch} revision={revision} onOpen={onOpen} onChanged={onChanged} />}
      {tab === 'timeline' && <WatchTimeline watch={watch} aiReady={aiReady} revision={revision} onOpen={onOpen} />}
      {tab === 'settings' && <WatchSettings watch={watch} onChanged={onChanged} onDirty={onDirty} />}
    </section>
  );
}

function WatchItems({ watch, revision, onOpen, onChanged }: { watch: WatchRow; revision: number; onOpen: (id: string) => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [noting, setNoting] = useState<{ id: string; verdict: 'wanted' | 'not_wanted' } | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    let live = true;
    void window.pnr.watchItems(watch.id, 80).then((r) => { if (live) setItems(r); });
    return () => { live = false; };
  }, [watch.id, revision]);

  const send = async (): Promise<void> => {
    if (!noting) return;
    await window.pnr.correct(watch.id, noting.id, noting.verdict, note);
    setItems((prev) => noting.verdict === 'not_wanted'
      ? prev?.filter((i) => i.id !== noting.id) ?? null
      : prev?.map((i) => (i.id === noting.id ? { ...i, verdict: 'wanted' } : i)) ?? null);
    setNoting(null); setNote(''); onChanged();
  };

  if (!items) return <p className="section-hint">{t('common.loading')}</p>;
  if (items.length === 0) {
    return <p className="section-hint">{t('watches.noItems')}{watch.keywords.length === 0 ? t('watches.noItemsKeywords') : ''}</p>;
  }
  return (
    <>
      <p className="section-hint">{t('watches.verdictHint')}</p>
      <ul className="watch-items">
        {items.map((it) => (
          <li key={it.id}>
            <div className="meta">
              <span className="src">{it.sourceName}</span><span aria-hidden>·</span>
              <time>{dateTime(it.publishedAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              {it.arms === 'keyword' ? <span className="tag" title={t('watches.keywordMatchHint')}>{t('watches.keywordMatch')}</span>
                : it.score !== null ? <span className="tag" title={t('watches.scoreHint')}>{t('watches.score', { score: it.score })}</span> : null}
              {it.verdict === 'wanted' && <span className="tag accent">{t('watches.markedWanted')}</span>}
            </div>
            <button className="headline" onClick={() => onOpen(it.id)}>{it.title}</button>
            {it.reason && <p className="why">{it.reason}</p>}
            {noting?.id === it.id ? (
              <form className="note-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <input autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                       placeholder={noting.verdict === 'wanted' ? t('watches.whyWanted') : t('watches.whyNot')} />
                <button className="primary">{noting.verdict === 'wanted' ? t('watches.markWanted') : t('watches.markNot')}</button>
                <button type="button" className="secondary" onClick={() => { setNoting(null); setNote(''); }}>{t('common.cancel')}</button>
              </form>
            ) : (
              <div className="verdicts">
                <button className="icon" title={t('watches.wantThis')} aria-label={t('watches.wantThis')} onClick={() => setNoting({ id: it.id, verdict: 'wanted' })}><ThumbsUp size={13} /></button>
                <button className="icon" title={t('watches.notWantThis')} aria-label={t('watches.notWantThis')} onClick={() => setNoting({ id: it.id, verdict: 'not_wanted' })}><ThumbsDown size={13} /></button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function WatchTimeline({ watch, aiReady, revision, onOpen }: { watch: WatchRow; aiReady: boolean; revision: number; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{ milestones: Milestone[]; refs: ItemRef[]; questions: OpenQuestion[] } | null>(null);
  useEffect(() => {
    let live = true;
    void window.pnr.watchTimeline(watch.id).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [watch.id, revision]);
  const refs = useMemo(() => new Map((data?.refs ?? []).map((r) => [r.id, r])), [data]);

  if (!data) return <p className="section-hint">{t('common.loading')}</p>;
  if (!aiReady && data.milestones.length === 0) return <p className="section-hint">{t('watches.timelineNeedsAi')}</p>;
  return (
    <>
      {data.questions.length > 0 && (
        <div className="panel">
          <h4>{t('watches.openQuestions')}</h4>
          <p className="section-hint">{t('watches.openQuestionsHint')}</p>
          <ul className="plain">{data.questions.map((q) => <li key={q.id}>{q.question}</li>)}</ul>
        </div>
      )}
      {data.milestones.length === 0
        ? <p className="section-hint">{t('watches.noMilestones')}</p>
        : <ul className="timeline-list rail">
            {data.milestones.map((m) => (
              <li key={m.id} className={m.isNew ? 'new' : ''}>
                <time>{m.occurredOn}</time>
                <p>{m.summary}{m.isNew && <span className="tag accent">{t('watches.new')}</span>}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} /></p>
              </li>
            ))}
          </ul>}
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
        label: form.label.trim() || watch.label, intent: form.intent.trim(), keywords: splitKeywords(form.keywords),
        outputLang: form.outputLang || null, sensitivity: form.sensitivity, active: form.active
      });
      setMessage(form.intent.trim() !== watch.intent ? t('watches.savedIntentChanged') : t('common.saved'));
      onDirty(false); onChanged();
    } catch { setMessage(t('common.saveFailed')); }
    finally { setSaving(false); }
  };

  return (
    <div className="form-stack">
      <label className="field"><span>{t('watches.name')}</span><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
      <label className="field"><span>{t('watches.intent')}</span>
        <textarea rows={3} value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })} />
        <small>{t('watches.intentJudge')}</small></label>
      <label className="field"><span>{t('watches.keywords')}</span>
        <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder={t('watches.keywordsPlaceholder')} />
        <small>{t('watches.keywordsHint')}</small></label>
      <label className="field"><span>{t('watches.outputLang')}</span>
        <select value={form.outputLang} onChange={(e) => setForm({ ...form, outputLang: e.target.value })}>
          <option value="">{t('watches.followGlobal')}</option>
          {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
      <fieldset className="field">
        <legend>{t('watches.strictness')}</legend>
        <div className="segmented" role="radiogroup">
          {SENSITIVITY.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={form.sensitivity === v} className={form.sensitivity === v ? 'active' : ''}
              onClick={() => setForm({ ...form, sensitivity: v })}>{t(`watches.sensitivity.${v}`)}</button>
          ))}
        </div>
        <small>{t(`watches.sensitivity.${form.sensitivity}Hint`)}</small>
      </fieldset>
      <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{t('watches.activeLabel')}</label>
      {watch.recallAids && (
        <details className="disclosure"><summary>{t('watches.aids')}</summary>
          <p className="section-hint">{t('watches.aidsHint')}</p>
          <Chips title={t('watches.aliases')} items={watch.recallAids.aliases} />
          <Chips title={t('watches.related')} items={watch.recallAids.relatedTerms} />
          <Chips title={t('watches.sourceHints')} items={watch.recallAids.sourceHints} />
        </details>
      )}
      <div className="form-actions">
        <button className="primary" onClick={() => void save()} disabled={saving || !dirty || !form.intent.trim()}>{saving ? t('common.saving') : t('common.save')}</button>
        {dirty && <button className="secondary" onClick={() => setForm(initial)}>{t('common.revert')}</button>}
        <span role="status" className="section-hint">{message}</span>
      </div>
      <div className="danger-zone">
        {confirmDelete
          ? <><span>{t('watches.confirmDelete', { label: watch.label })}</span>
              <button className="secondary" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
              <button className="danger" onClick={async () => { await window.pnr.removeWatch(watch.id); onDirty(false); onChanged(); }}>{t('common.delete')}</button></>
          : <button className="text-button danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} />{t('watches.delete')}</button>}
      </div>
    </div>
  );
}

const Chips = ({ title, items }: { title: string; items: string[] }) =>
  items.length === 0 ? null : (
    <div className="chips labelled">
      <span className="chips-title">{title}</span>
      {items.map((x) => <span key={x} className="chip static">{x}</span>)}
    </div>
  );
