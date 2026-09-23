import { Dialog } from './Dialog.tsx';
import { Trash2, Bookmark, ChevronLeft, RefreshCw, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ItemRef, Milestone, OpenQuestion, OutsidePick, PresetRow, Sensitivity, WatchItem, WatchRow } from '../types.ts';
import { Cited, Cites } from './Cites.tsx';
import { Group, Row, Select, Switch } from './Form.tsx';
import { ListPane, Row as ListRow } from './ListPane.tsx';
import type { OpenReport } from '../App.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime } from '../i18n.ts';
const splitKeywords = (s: string): string[] => s.split(/[,，、;；\n]+/).map((k) => k.trim()).filter(Boolean);
/** A calendar day ('2026-09-22') in the interface language, as 今日 shows it. */
const day = (iso: string): string => dateTime(Date.parse(`${iso}T00:00:00`), { month: 'short', day: 'numeric' });

export type WatchTab = 'timeline' | 'items' | 'settings';
/** Something else in the window asked to add a watch (optionally prefilled) or to show one. */
export type WatchRequest = { draft: OutsidePick['suggestion'] | null } | { open: string; section: WatchTab };

/**
 * 关注 — the file on each story: how far it has got (进展, the default), the
 * coverage behind it (相关报道, where the person corrects the judge), and its
 * settings. Laid out like the other tabs: the watches on the left (searched
 * from the toolbar), the picked one on the right. Presets and written intents
 * are the same object; the only difference is who wrote the sentence.
 */
export function Watches({ aiReady, revision, query, divider, onSetup, onOpen, onReport, onCount, request, onRequestDone }: {
  aiReady: boolean; revision: number; query: string; divider: ReactNode; onSetup: () => void; onOpen: (id: string) => void; onReport: OpenReport;
  /** How many watches, and how many new developments across the active ones. */
  onCount: (n: number, fresh: number) => void; request: WatchRequest | null; onRequestDone: () => void;
}) {
  const { t } = useTranslation();
  const [watches, setWatches] = useState<WatchRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(() => (request && 'open' in request ? request.open : null));
  /** The section a request asked for; otherwise each watch opens on its timeline. */
  const [section, setSection] = useState<WatchTab | null>(() => (request && 'open' in request ? request.section : null));
  /** Narrow windows show one half at a time; the detail only after an explicit pick. */
  const [picked, setPicked] = useState(() => Boolean(request && 'open' in request));
  const [adding, setAdding] = useState<{ draft: OutsidePick['suggestion'] | null } | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const w = await window.pnr.watches();
    setWatches(w); onCount(w.length, w.reduce((n, x) => n + (x.active ? x.newCount : 0), 0));
    setOpen((id) => (w.some((x) => x.id === id) ? id : w[0]?.id ?? null));
  }, []);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    if (!request) return;
    if ('open' in request) { setOpen(request.open); setSection(request.section); setPicked(true); }
    else setAdding(request);
    onRequestDone();
  }, [request, onRequestDone]);

  const list = watches ?? [];
  const selected = list.find((w) => w.id === open);
  const confirmLeave = (): boolean => !dirty || window.confirm(t('watches.discard'));
  const pick = (id: string): void => {
    if (id !== open) {
      if (!confirmLeave()) return;
      setDirty(false); setOpen(id); setSection(null);
    }
    setPicked(true);
  };
  const rowMenu = async (w: WatchRow): Promise<void> => {
    const choice = await window.pnr.contextMenu([
      { id: 'pause', label: w.active ? t('watches.pauseAction') : t('watches.resumeAction') },
      { separator: true }, { id: 'delete', label: t('watches.delete') }
    ]);
    if (choice === 'pause') { await window.pnr.editWatch(w.id, { active: !w.active }); void load(); }
    else if (choice === 'delete' && window.confirm(t('watches.confirmDelete', { label: w.label }))) {
      await window.pnr.removeWatch(w.id); if (open === w.id) setDirty(false); void load();
    }
  };
  const q = query.trim().toLocaleLowerCase();
  const shown = list.filter((w) => `${w.label} ${w.intent} ${w.keywords.join(' ')}`.toLocaleLowerCase().includes(q));
  const addDialog = adding && <AddWatch prefill={adding.draft} onClose={() => setAdding(null)}
    onAdded={async (id) => { setAdding(null); await load(); if (id) { setDirty(false); setOpen(id); setPicked(true); } }} />;

  if (!watches) return <section className="page" />;
  // Nothing to list yet: one invitation instead of an empty list beside an empty detail.
  if (list.length === 0) return (
    <section className="page center">
      <div className="empty-state">
        <Bookmark size={30} strokeWidth={1.4} />
        <h3>{t('watches.emptyTitle')}</h3>
        <p>{t('watches.empty')}</p>
        <button className="push" onClick={() => setAdding({ draft: null })}>{t('watches.add')}</button>
      </div>
      {addDialog}
    </section>
  );

  return (
    <div className={`split-view ${picked ? 'has-selection' : ''}`}>
      <ListPane label={t('watches.list')} ids={shown.map((w) => w.id)} selected={open} onSelect={pick}>
        {shown.map((w) => (
          <ListRow key={w.id} selected={open === w.id} className={w.active ? '' : 'paused'} onSelect={() => pick(w.id)} onMenu={() => void rowMenu(w)}>
            <div className="row-title">
              <h3>{w.label}</h3>
              {w.active && w.newCount > 0 && <em className="badge accent" title={t('watches.newTitle', { count: w.newCount })}>{w.newCount}</em>}
            </div>
            <p>{w.active ? w.intent : t('watches.paused')}</p>
          </ListRow>
        ))}
        {shown.length === 0 && <div className="empty-state compact"><p>{t('watches.noMatch')}</p></div>}
      </ListPane>
      {divider}
      <section className="watch-detail">
        <div className="watch-page">
          <button className="push narrow-only detail-back" onClick={() => setPicked(false)}><ChevronLeft size={14} />{t('watches.list')}</button>
          {!aiReady && (
            <div className="notice">{t('watches.noAi')}<button className="link" onClick={onSetup}>{t('common.connectAi')}</button></div>
          )}
          {selected ? <WatchDetail key={selected.id} watch={selected} aiReady={aiReady} revision={revision} onChanged={load} initialTab={section}
              dirty={dirty} onDirty={setDirty} confirmLeave={confirmLeave} onOpen={onOpen} onReport={onReport} />
            : <div className="empty-state"><Bookmark size={30} strokeWidth={1.4} /><h3>{t('watches.pickTitle')}</h3><p>{t('watches.pickHint')}</p></div>}
        </div>
      </section>
      {addDialog}
    </div>
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
        <button type="button" className="push" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="primary" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? t('common.adding') : mode === 'library' && picked.size ? t('watches.addN', { count: picked.size }) : t('common.add')}
        </button>
      </footer>
    </Dialog>
  );
}

// ── one watch ───────────────────────────────────────────────────────────────

const TABS: WatchTab[] = ['timeline', 'items', 'settings'];

function WatchDetail({ watch, aiReady, revision: outer, onChanged, initialTab, dirty, onDirty, confirmLeave, onOpen, onReport }: {
  watch: WatchRow; aiReady: boolean; revision: number; onChanged: () => void; initialTab: WatchTab | null;
  dirty: boolean; onDirty: (dirty: boolean) => void; confirmLeave: () => boolean; onOpen: (id: string) => void; onReport: OpenReport;
}) {
  const { t } = useTranslation();
  // The timeline answers "how far has this got"; without AI there is none yet, so the coverage leads.
  const [tab, setTab] = useState<WatchTab>(() => initialTab ?? (aiReady || watch.timelineCount > 0 ? 'timeline' : 'items'));
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [local, setLocal] = useState(0);
  const revision = outer + local;
  // Leaving the settings form unmounts it; ask first rather than drop edits silently.
  const switchTab = (next: WatchTab): void => {
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
        <button className="push" onClick={() => void runNow()} disabled={running || !watch.active} title={watch.active ? t('watches.updateHint') : t('watches.paused')}>
          <RefreshCw size={13} className={running ? 'spinning' : ''} />{running ? t('watches.updatingOne') : t('watches.updateNow')}</button>
      </div>
      {message && !running && <p role="status" className="section-hint">{message}</p>}
      <nav className="segmented tabs" aria-label={t('watches.sections')}>
        {TABS.map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => switchTab(id)}>
            {t(`watches.tabs.${id}`)}{id === 'timeline' && watch.newCount ? <em className="badge">{watch.newCount}</em> : null}
          </button>
        ))}
      </nav>
      {tab === 'items' && <WatchItems watch={watch} aiReady={aiReady} revision={revision} onOpen={onOpen} onReport={onReport} onChanged={onChanged} />}
      {tab === 'timeline' && <WatchTimeline watch={watch} aiReady={aiReady} revision={revision} onOpen={onOpen} onReport={onReport} />}
      {tab === 'settings' && <WatchSettings watch={watch} onChanged={onChanged} onDirty={onDirty} />}
    </section>
  );
}

function WatchItems({ watch, aiReady, revision, onOpen, onReport, onChanged }: { watch: WatchRow; aiReady: boolean; revision: number; onOpen: (id: string) => void; onReport: OpenReport; onChanged: () => void }) {
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
          <li key={it.id} onContextMenu={async (e) => {
            e.preventDefault();
            const choice = await window.pnr.contextMenu([{ id: 'read', label: t('menu.openInReader') }, { id: 'original', label: t('menu.openOriginal') },
              { separator: true }, { id: 'report', label: t('report.open'), enabled: aiReady }]);
            if (choice === 'read') onOpen(it.id);
            else if (choice === 'original') void window.pnr.openExternal(it.url);
            else if (choice === 'report') onReport({ anchorItemId: it.id, itemIds: [it.id], topic: it.title });
          }}>
            <div className="meta">
              <span className="src">{it.sourceName ?? t('common.newsSearch')}</span><span aria-hidden>·</span>
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
                <button type="button" className="push" onClick={() => { setNoting(null); setNote(''); }}>{t('common.cancel')}</button>
              </form>
            ) : (
              <div className="verdicts">
                <button className="tool" title={t('watches.wantThis')} aria-label={t('watches.wantThis')} onClick={() => setNoting({ id: it.id, verdict: 'wanted' })}><ThumbsUp size={13} /></button>
                <button className="tool" title={t('watches.notWantThis')} aria-label={t('watches.notWantThis')} onClick={() => setNoting({ id: it.id, verdict: 'not_wanted' })}><ThumbsDown size={13} /></button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function WatchTimeline({ watch, aiReady, revision, onOpen, onReport }: { watch: WatchRow; aiReady: boolean; revision: number; onOpen: (id: string) => void; onReport: OpenReport }) {
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
  // Newest first: people come here to see what moved; the story reads back from there.
  const newest = [...data.milestones].reverse();
  return (
    <>
      {newest.length === 0
        ? <p className="section-hint">{t('watches.noMilestones')}</p>
        : <ul className="timeline-list rail">
            {newest.map((m) => (
              <li key={m.id} className={m.isNew ? 'new' : ''} onContextMenu={async (e) => {
                e.preventDefault();
                if (!m.itemIds[0]) return;
                const choice = await window.pnr.contextMenu([{ id: 'read', label: t('menu.openInReader') }, { separator: true }, { id: 'report', label: t('report.open'), enabled: aiReady }]);
                if (choice === 'read') onOpen(m.itemIds[0]);
                else if (choice === 'report') onReport({ anchorItemId: m.itemIds[0], itemIds: m.itemIds, topic: m.summary });
              }}>
                <time dateTime={m.occurredOn}>{day(m.occurredOn)}</time>
                <p><Cited text={m.summary}>{m.isNew && <span className="tag accent">{t('watches.new')}</span>}</Cited><Cites ids={m.itemIds} refs={refs} onOpen={onOpen} /></p>
              </li>
            ))}
          </ul>}
      {data.questions.length > 0 && (
        <div className="panel">
          <h4>{t('watches.openQuestions')}</h4>
          <p className="section-hint">{t('watches.openQuestionsHint')}</p>
          <ul className="plain">{data.questions.map((q) => <li key={q.id}>{q.question}</li>)}</ul>
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
      <Group>
        <Row label={t('watches.name')}><input value={form.label} aria-label={t('watches.name')} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Row>
        <Row wide label={t('watches.intent')} hint={t('watches.intentJudge')}>
          <textarea rows={3} value={form.intent} aria-label={t('watches.intent')} onChange={(e) => setForm({ ...form, intent: e.target.value })} /></Row>
        <Row wide label={t('watches.keywords')} hint={t('watches.keywordsHint')}>
          <input value={form.keywords} aria-label={t('watches.keywords')} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder={t('watches.keywordsPlaceholder')} /></Row>
      </Group>
      <Group>
        <Row label={t('watches.strictness')} hint={t(`watches.sensitivity.${form.sensitivity}Hint`)}>
          <div className="segmented" role="radiogroup" aria-label={t('watches.strictness')}>
            {SENSITIVITY.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={form.sensitivity === v} className={form.sensitivity === v ? 'active' : ''}
                onClick={() => setForm({ ...form, sensitivity: v })}>{t(`watches.sensitivity.${v}`)}</button>
            ))}
          </div></Row>
        <Row label={t('watches.outputLang')}>
          <Select value={form.outputLang} aria-label={t('watches.outputLang')} onChange={(e) => setForm({ ...form, outputLang: e.target.value })}>
            <option value="">{t('watches.followGlobal')}</option>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select></Row>
        <Row label={t('watches.active')} hint={t('watches.activeHint')}>
          <Switch label={t('watches.active')} checked={form.active} onChange={(on) => setForm({ ...form, active: on })} /></Row>
      </Group>
      {watch.recallAids && (
        <Group title={t('watches.aids')} footer={t('watches.aidsHint')}>
          <Chips title={t('watches.aliases')} items={watch.recallAids.aliases} />
          <Chips title={t('watches.related')} items={watch.recallAids.relatedTerms} />
          <Chips title={t('watches.sourceHints')} items={watch.recallAids.sourceHints} />
        </Group>
      )}
      <div className="form-actions">
        <button className="text-button danger" onClick={() => setConfirmDelete(true)} hidden={confirmDelete}><Trash2 size={13} />{t('watches.delete')}</button>
        {confirmDelete && <><span className="section-hint">{t('watches.confirmDelete', { label: watch.label })}</span>
          <button className="push" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
          <button className="push destructive" onClick={async () => { await window.pnr.removeWatch(watch.id); onDirty(false); onChanged(); }}>{t('common.delete')}</button></>}
        <span className="grow" />
        <span role="status" className="section-hint">{message}</span>
        {dirty && <button className="push" onClick={() => setForm(initial)}>{t('common.revert')}</button>}
        <button className="primary" onClick={() => void save()} disabled={saving || !dirty || !form.intent.trim()}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </div>
  );
}

/** Terms read left to right under their label, as a tag field would show them. */
const Chips = ({ title, items }: { title: string; items: string[] }) =>
  items.length === 0 ? null : (
    <div className="row wide"><div className="row-label"><span>{title}</span></div>
      <div className="chips">{items.map((x) => <span key={x} className="chip static">{x}</span>)}</div></div>
  );
