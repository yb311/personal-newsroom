import { ArrowUp, FileSearch, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportAnchor, ReportConversation, ReportEvent, ReportSource, ReportUnit } from '../types.ts';
import { dateOnly } from '../i18n.ts';
import { Cited } from './Cites.tsx';

/**
 * 深度报道: a report on one story, written from the full text of the related
 * coverage, shown as a document in the main area. Every factual unit cites the
 * saved material it came from; follow-up questions extend the same report.
 * Reopening the same story restores the saved conversation instead of paying
 * for it again; the toolbar's restart button (`restart`) writes a fresh one.
 */
export function Report({ anchor, lang, restart, onOpen }: { anchor: ReportAnchor; lang: string; restart: number; onOpen: (itemId: string) => void }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<ReportConversation | null>(null);
  const [draft, setDraft] = useState('');
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<{ title?: string; units?: Partial<ReportUnit>[] } | null>(null);
  const [error, setError] = useState('');
  const requestRef = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const byRef = useMemo(() => new Map(report?.sources.map((s) => [s.refId, s]) ?? []), [report]);

  useEffect(() => window.pnr.onReportEvent((event: ReportEvent) => {
    if (event.requestId !== requestRef.current) return;
    if (event.type === 'partial') setPartial(event.value ?? null);
  }), []);

  const describe = (code?: string): string => t(`report.errors.${code ?? 'failed'}`, { defaultValue: t('report.failed') });
  const cancelActive = (): void => {
    const id = requestRef.current; if (!id) return;
    requestRef.current = null; setBusy(false); setPartial(null);
    void window.pnr.reportCancel(id);
  };

  const begin = async (fresh: boolean): Promise<void> => {
    cancelActive();
    const id = crypto.randomUUID(); requestRef.current = id;
    setBusy(true); setError(''); setPartial(null);
    if (fresh) setReport(null);
    try {
      const existing = fresh ? null : await window.pnr.reportGet({ anchorItemId: anchor.anchorItemId, lang });
      if (requestRef.current !== id) return;
      if (existing?.messages.some((m) => m.role === 'assistant' && m.status === 'complete')) { setReport(existing); return; }
      const result = await window.pnr.reportStart({ ...anchor, lang, restart: fresh, requestId: id });
      if (requestRef.current !== id) return;
      if (result.conversation) setReport(result.conversation);
      else setError(result.noProvider ? t('report.needAi') : describe(result.error));
    } catch { if (requestRef.current === id) setError(describe()); }
    finally { if (requestRef.current === id) { requestRef.current = null; setBusy(false); setPartial(null); } }
  };
  useEffect(() => { void begin(false); return cancelActive; }, [anchor.anchorItemId, lang]);
  // Only a press of restart while this report is open; the counter itself outlives reports.
  const restartSeen = useRef(restart);
  useEffect(() => { if (restart !== restartSeen.current) { restartSeen.current = restart; void begin(true); } }, [restart]);

  const ask = async (): Promise<void> => {
    const question = draft.trim(); if (!question || !report || busy) return;
    const id = crypto.randomUUID(); requestRef.current = id;
    setBusy(true); setError(''); setPartial(null); setDraft('');
    try {
      const result = await window.pnr.reportAsk({ conversationId: report.id, question, requestId: id, research });
      if (requestRef.current !== id) return;
      if (result.conversation) setReport(result.conversation); else { setError(describe(result.error)); setDraft(question); }
    } catch { if (requestRef.current === id) setError(describe()); }
    finally { if (requestRef.current === id) { requestRef.current = null; setBusy(false); setPartial(null); input.current?.focus(); } }
  };

  // Keep the newest part in view while it is written.
  useLayoutEffect(() => { if (busy && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [busy, partial, report]);
  useLayoutEffect(() => {
    const el = input.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  const openSource = (s: ReportSource): void => { void window.pnr.openExternal(s.url); };
  const sourceMenu = async (e: MouseEvent, s: ReportSource): Promise<void> => {
    e.preventDefault();
    const choice = await window.pnr.contextMenu([{ id: 'original', label: t('menu.openOriginal') },
      { id: 'read', label: t('menu.openInReader'), enabled: Boolean(s.itemId) }, { separator: true }, { id: 'copy', label: t('menu.copyLink') }]);
    if (choice === 'original') openSource(s);
    else if (choice === 'read' && s.itemId) onOpen(s.itemId);
    else if (choice === 'copy') void window.pnr.copyText(s.url);
  };
  const cite = (ids: string[]): ReactElement | null => {
    const found = ids.map((r) => byRef.get(r)).filter((s): s is ReportSource => Boolean(s));
    return found.length === 0 ? null : <span className="refs">{found.map((s) =>
      <button key={s.refId} className="ref" title={[s.publisher, s.title].filter(Boolean).join(' · ')} onClick={() => openSource(s)} onContextMenu={(e) => void sourceMenu(e, s)}>{s.refId.slice(1)}</button>)}</span>;
  };

  const messages = report?.messages ?? [];
  return (
    <section className="report">
      <div className="report-scroll" ref={scroller}>
        <article className="report-doc" lang={report?.lang ?? lang}>
          {!report && busy && <div className="empty-state"><span className="spinner large" /><p>{t('report.gathering')}</p></div>}
          {messages.map((m) => m.role === 'user'
            ? (m.sequence > 1 && <h3 key={m.id} className="report-question">{m.question}</h3>)
            : m.answer ? <section key={m.id} className="report-answer">
                {m.answer.title && (m.sequence <= 2 ? <h1>{m.answer.title}</h1> : <h2>{m.answer.title}</h2>)}
                {m.sequence <= 2 && <p className="report-meta">{t('report.meta', { count: report!.sources.length, date: dateOnly(report!.createdAt) })}</p>}
                <Units units={m.answer.units} cite={cite} />
              </section>
            : <p key={m.id} className="report-note">{m.status === 'cancelled' ? t('report.stopped') : describe()}</p>)}
          {busy && report && <section className="report-answer streaming">
            {partial?.title && <h2>{partial.title}</h2>}
            <p className="working"><span className="spinner" />{t('report.writing')}</p>
          </section>}
          {busy && !report && partial?.title && <p className="working"><span className="spinner" />{partial.title}</p>}
          {error && <div className="banner warn"><p>{error}</p><button className="push" onClick={() => void (report ? ask() : begin(false))}>{t('common.retry')}</button></div>}
          {report && report.sources.length > 0 && <section className="doc-sources">
            <h2>{t('report.sources', { count: report.sources.length })}</h2>
            <ol>{report.sources.map((s) => <li key={s.refId} onContextMenu={(e) => void sourceMenu(e, s)}>
              <span className="ref static">{s.refId.slice(1)}</span>
              <div><button className="link" onClick={() => openSource(s)}>{s.title}</button>
                <small>{[s.publisher, s.publishedAt ? dateOnly(s.publishedAt) : null, t(`report.basis.${s.basis}`)].filter(Boolean).join(' · ')}</small></div>
            </li>)}</ol>
          </section>}
        </article>
      </div>
      {report && <footer className="composer report-composer">
        <div className="composer-box">
          <textarea ref={input} rows={1} value={draft} placeholder={t('report.askPlaceholder')} aria-label={t('report.askPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(); } }} />
          <div className="composer-actions">
            <button className={`chip-toggle ${research ? 'on' : ''}`} aria-pressed={research} title={t('report.researchHint')} onClick={() => setResearch((v) => !v)}>
              <FileSearch size={13} />{t('report.research')}</button>
            <span className="grow" />
            {busy
              ? <button className="send" title={t('report.cancel')} aria-label={t('report.cancel')} onClick={cancelActive}><Square size={12} fill="currentColor" /></button>
              : <button className="send" title={t('report.ask')} aria-label={t('report.ask')} disabled={!draft.trim()} onClick={() => void ask()}><ArrowUp size={15} /></button>}
          </div>
        </div>
      </footer>}
    </section>
  );
}

/** Paragraphs, lists (consecutive list items), timeline points and table rows. */
function Units({ units, cite }: { units: ReportUnit[]; cite: (ids: string[]) => ReactElement | null }) {
  const blocks: { kind: ReportUnit['kind']; units: ReportUnit[] }[] = [];
  for (const u of units) {
    const prev = blocks.at(-1);
    if (prev && prev.kind === u.kind && u.kind !== 'paragraph') prev.units.push(u); else blocks.push({ kind: u.kind, units: [u] });
  }
  return <>{blocks.map((b, i) => b.kind === 'paragraph'
    ? <p key={i}><Cited text={b.units[0]!.text}>{cite(b.units[0]!.sourceRefIds)}</Cited></p>
    : <ul key={i} className={b.kind}>{b.units.map((u, j) => <li key={j}><Cited text={u.text}>{cite(u.sourceRefIds)}</Cited></li>)}</ul>)}</>;
}
