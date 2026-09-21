import { Search, Square, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportConversation, ReportEvent } from '../types.ts';

export interface ReportAnchor { anchorItemId: string; itemIds: string[]; topic: string; lang: string }

export function ReportDivider({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const { t } = useTranslation(); const start = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number): void => { const next = Math.max(340, Math.min(640, value)); onChange(next); localStorage.setItem('pnr.reportWidth', String(next)); };
  return <div className="report-divider" role="separator" aria-label={t('report.resize')} aria-orientation="vertical"
    aria-valuemin={340} aria-valuemax={640} aria-valuenow={width} tabIndex={0} onDoubleClick={() => resize(420)}
    onKeyDown={(e) => { if (!['ArrowLeft','ArrowRight'].includes(e.key)) return; e.preventDefault(); resize(width + (e.key === 'ArrowLeft' ? 10 : -10)); }}
    onPointerDown={(e) => { if (e.button !== 0) return; start.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { if (start.current) resize(start.current.width + start.current.x - e.clientX); }}
    onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); start.current = null; }} />;
}

export function ReportPanel({ anchor, onClose }: { anchor: ReportAnchor; onClose: () => void }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<ReportConversation | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ title?: string; units?: unknown[] } | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const byRef = useMemo(() => new Map(report?.sources.map((s) => [s.refId, s]) ?? []), [report]);

  useEffect(() => window.pnr.onReportEvent((event: ReportEvent) => {
    if (event.requestId !== requestId) return;
    if (event.type === 'partial') setPartial(event.value ?? null);
    if (event.type === 'error') setError(event.error ?? t('report.failed'));
  }), [requestId, t]);

  const begin = async (restart = false): Promise<void> => {
    const id = crypto.randomUUID(); setRequestId(id); setBusy(true); setError(''); setPartial(null);
    const existing = !restart ? await window.pnr.reportGet({ anchorItemId: anchor.anchorItemId, lang: anchor.lang }) : null;
    if (existing) { setReport(existing); setBusy(false); setRequestId(null); return; }
    const result = await window.pnr.reportStart({ ...anchor, restart, requestId: id });
    if (result.conversation) setReport(result.conversation);
    else setError(result.noProvider ? t('report.needAi') : result.error ?? t('report.failed'));
    setBusy(false); setRequestId(null); setPartial(null);
  };
  useEffect(() => { void begin(false); return () => { if (requestId) void window.pnr.reportCancel(requestId); }; }, [anchor.anchorItemId, anchor.lang]);

  const ask = async (research: boolean): Promise<void> => {
    const question = draft.trim(); if (!question || !report || busy) return;
    const id = crypto.randomUUID(); setRequestId(id); setBusy(true); setError(''); setPartial(null); setDraft('');
    const result = await window.pnr.reportAsk({ conversationId: report.id, question, requestId: id, research });
    if (result.conversation) setReport(result.conversation); else setError(result.error ?? t('report.failed'));
    setBusy(false); setRequestId(null); setPartial(null); inputRef.current?.focus();
  };
  const close = (): void => { if (requestId) void window.pnr.reportCancel(requestId); onClose(); };

  return <aside className="report-panel" aria-label={t('report.title')}>
    <header><strong>{t('report.title')}</strong><span className="grow" />
      <button title={t('report.restart')} onClick={() => void begin(true)} disabled={busy}><RotateCcw size={15} /></button>
      <button title={t('common.close')} onClick={close}><X size={16} /></button>
    </header>
    <div className="report-scroll">
      {!report && busy && <p className="muted">{t('report.gathering')}</p>}
      {report?.messages.map((message) => message.role === 'user'
        ? <div className="report-question" key={message.id}>{message.question}</div>
        : message.answer && <article className="report-answer" key={message.id}>
          {message.answer.title && <h2>{message.answer.title}</h2>}
          {message.answer.units.map((unit, i) => <p className={unit.kind} key={i}>{unit.text}
            {unit.sourceRefIds.map((ref) => { const source = byRef.get(ref); return source ? <button className="cite" key={ref} title={source.title} onClick={() => void window.pnr.openExternal(source.url)}>{ref}</button> : null; })}
          </p>)}
        </article>)}
      {busy && partial && <article className="report-answer streaming"><h2>{partial.title}</h2><p>{t('report.writing')}</p></article>}
      {error && <p className="warn">{error}</p>}
      {report && <details className="report-sources"><summary>{t('report.sources', { count: report.sources.length })}</summary>
        <ol>{report.sources.map((source) => <li key={source.refId}><span>{source.refId}</span><button onClick={() => void window.pnr.openExternal(source.url)}>{source.title}</button><small>{t(`report.basis.${source.basis}`)}</small></li>)}</ol>
      </details>}
    </div>
    <footer><input ref={inputRef} value={draft} disabled={busy || !report} placeholder={t('report.askPlaceholder')} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask(false); }} />
      {busy ? <button onClick={() => requestId && void window.pnr.reportCancel(requestId)} title={t('report.cancel')}><Square size={14} /></button>
        : <><button onClick={() => void ask(false)} disabled={!draft.trim()}>{t('report.ask')}</button><button onClick={() => void ask(true)} disabled={!draft.trim()} title={t('report.research')}><Search size={14} /></button></>}
    </footer>
  </aside>;
}
