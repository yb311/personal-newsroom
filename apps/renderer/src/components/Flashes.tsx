import { ChevronRight, Zap } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FlashRow, ItemRef } from '../types.ts';
import { Cited, numberSources, Refs, SourceList } from './Cites.tsx';
import { Detail, ListPane, Row } from './ListPane.tsx';
import type { OpenReport } from '../App.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime, scriptLang } from '../i18n.ts';

/** Importance at or above this is shown as 重要 and kept by the filter. */
const IMPORTANT = 8;

/**
 * 快讯 — the running wire for the watches: what has just happened, one event
 * per flash, checked every few hours. The headline leads each row; the watches
 * it belongs to are only a note. A follow-up names the flash it continues.
 */
export function Flashes({ aiReady, revision, important, divider, onSetup, onOpen, onReport, onOpenWatch, onCount }: {
  aiReady: boolean; revision: number; important: boolean; divider: ReactNode; onSetup: () => void; onOpen: (id: string) => void;
  onReport: OpenReport; onOpenWatch: (id: string) => void; onCount: (n: number) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FlashRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    let live = true;
    void window.pnr.flashes(24).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [revision]);
  const report = (f: FlashRow): void => { if (f.itemIds[0]) onReport({ anchorItemId: f.itemIds[0], itemIds: f.itemIds, topic: `${f.title}\n${f.body}` }); };
  const menu = async (f: FlashRow): Promise<void> => {
    const choice = await window.pnr.contextMenu([
      { id: 'read', label: t('menu.openInReader'), enabled: Boolean(f.itemIds[0]) },
      { id: 'report', label: t('report.open'), enabled: aiReady && Boolean(f.itemIds[0]) },
      { separator: true }, { id: 'copy', label: t('menu.copyText') }
    ]);
    if (choice === 'read' && f.itemIds[0]) onOpen(f.itemIds[0]);
    else if (choice === 'report') report(f);
    else if (choice === 'copy') void window.pnr.copyText(`${f.title}\n${f.body}`);
  };
  const shown = useMemo(() => (important ? (rows ?? []).filter((f) => f.importance >= IMPORTANT) : rows ?? []), [rows, important]);
  // The toolbar counts what the list shows, filtered or not.
  useEffect(() => { if (rows) onCount(shown.length); }, [rows, shown]);

  if (!rows) return <section className="page" />;
  if (shown.length === 0) {
    const needAi = !aiReady && rows.length === 0;
    const filtered = rows.length > 0 && important;
    return (
      <section className="page center">
        <div className="empty-state">
          <Zap size={30} strokeWidth={1.4} />
          <h3>{needAi ? t('flashes.needAiTitle') : filtered ? t('flashes.emptyFilteredTitle') : t('flashes.emptyTitle')}</h3>
          <p>{needAi ? t('flashes.needAiBody') : filtered ? t('flashes.emptyFiltered') : t('flashes.empty')}</p>
          {needAi && <button className="push" onClick={onSetup}>{t('common.connectAi')}</button>}
        </div>
      </section>
    );
  }

  const current = shown.find((f) => f.id === selected) ?? shown[0]!;
  const pick = (id: string): void => { setSelected(id); setPicked(true); };
  // The flash a follow-up continues: shown in place when it is still listed, else its article.
  const openEarlier = (f: FlashRow): void => {
    if (!f.followUp) return;
    if (shown.some((x) => x.id === f.followUp!.id)) pick(f.followUp.id);
    else if (f.followUp.itemIds[0]) onOpen(f.followUp.itemIds[0]);
  };
  return (
    <div className={`split-view ${picked ? 'has-selection' : ''}`}>
      <ListPane label={t('tabs.flashes')} ids={shown.map((f) => f.id)} selected={current.id} onSelect={pick}>
        {shown.map((f) => (
          <Row key={f.id} selected={f.id === current.id} onSelect={() => pick(f.id)} onMenu={() => void menu(f)}>
            <div className="row-head">
              {f.importance >= IMPORTANT && <span className="flag-label">{t('flashes.important')}</span>}
              {f.followUp && <span className="flag-label quiet">{t('flashes.followUp')}</span>}
              <span className="src">{f.watchLabels.join(' · ')}</span>
              <time>{ago(f.itemPublishedAt ?? f.publishedAt)}</time>
            </div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </Row>
        ))}
      </ListPane>
      {divider}
      <Flash key={current.id} flash={current} aiReady={aiReady} onOpen={onOpen} onReport={() => report(current)} onBack={() => setPicked(false)}
        onOpenWatch={onOpenWatch} onEarlier={() => openEarlier(current)} />
    </div>
  );
}

function Flash({ flash: f, aiReady, onOpen, onReport, onBack, onOpenWatch, onEarlier }: {
  flash: FlashRow; aiReady: boolean; onOpen: (id: string) => void; onReport: () => void; onBack: () => void;
  onOpenWatch: (id: string) => void; onEarlier: () => void;
}) {
  const { t } = useTranslation();
  const refs = useMemo(() => new Map<string, ItemRef>(f.sources.map((r) => [r.id, r])), [f]);
  const numbers = useMemo(() => numberSources([f.itemIds], refs), [f, refs]);
  const first = f.itemIds[0];
  return (
    <Detail onBack={onBack} lang={scriptLang(f.title + f.body)}>
      <div className="reader-meta">
        {f.importance >= IMPORTANT && <><span className="src">{t('flashes.important')}</span><span aria-hidden>·</span></>}
        <time title={t('flashes.writtenAt', { when: dateTime(f.publishedAt) })}>
          {f.itemPublishedAt ? dateTime(f.itemPublishedAt, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t('flashes.writtenAt', { when: ago(f.publishedAt) })}
        </time>
        {f.watches.map((w) => <Fragment key={w.id}><span aria-hidden>·</span>
          <button className="meta-link" title={t('flashes.openWatch')} onClick={() => onOpenWatch(w.id)}>{w.label}</button></Fragment>)}
      </div>
      <h1 className="statement">{f.title}</h1>
      {f.followUp && <button className="follow-up" onClick={onEarlier}>
        <span className="follow-up-label">{t('flashes.earlier')}</span>
        <span className="follow-up-title">{f.followUp.title}</span>
        <time>{ago(f.followUp.publishedAt)}</time>
        <ChevronRight size={13} strokeWidth={2.25} aria-hidden />
      </button>}
      <div className="prose">
        <p><Cited text={f.body}><Refs ids={f.itemIds} refs={refs} numbers={numbers} onOpen={onOpen} /></Cited></p>
      </div>
      {f.importanceReason && <p className="doc-note">{f.importanceReason}</p>}
      {/* Honest about provenance: written from the article, or only from the source's summary. */}
      {f.basis === 'snippet' && <p className="doc-note">{t('flashes.snippetOnlyHint')}</p>}
      {f.basis === 'search' && <p className="doc-note">{t('flashes.searchFilledHint')}</p>}
      {first && <div className="doc-actions">
        <button className="push" disabled={!aiReady} onClick={onReport}>{t('report.open')}</button>
        <button className="push" onClick={() => onOpen(first)}>{t('menu.openInReader')}</button>
      </div>}
      <SourceList numbers={numbers} refs={refs} onOpen={onOpen} />
      {f.basis === 'search' && f.searchSources.length > 0 && <details className="disclosure">
        <summary>{t('flashes.verifiedSources', { count: f.searchSources.length })}</summary>
        <ul>{f.searchSources.map((source) => <li key={source.refId}>
          <button className="link" onClick={() => void window.pnr.openExternal(source.url)}>{source.title || source.publisher || source.url}</button>
        </li>)}</ul>
      </details>}
    </Detail>
  );
}
