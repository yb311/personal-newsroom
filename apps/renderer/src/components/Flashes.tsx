import { FileSearch, Zap } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { FlashRow, ItemRef } from '../types.ts';
import { Cites } from './Cites.tsx';
import type { OpenReport } from '../App.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime } from '../i18n.ts';

/** Importance at or above this is shown as 重要 and kept by the filter. */
const IMPORTANT = 8;

export function Flashes({ aiReady, revision, important, onSetup, onOpen, onReport, onCount }: {
  aiReady: boolean; revision: number; important: boolean; onSetup: () => void; onOpen: (id: string) => void;
  onReport: OpenReport; onCount: (n: number) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FlashRow[] | null>(null);

  useEffect(() => {
    let live = true;
    void window.pnr.flashes(24).then((r) => { if (live) { setRows(r); onCount(r.length); } });
    return () => { live = false; };
  }, [revision]);
  const report = (f: FlashRow): void => { if (f.itemIds[0]) onReport({ anchorItemId: f.itemIds[0], itemIds: f.itemIds, topic: `${f.title}\n${f.body}` }); };
  const menu = async (e: MouseEvent, f: FlashRow): Promise<void> => {
    e.preventDefault();
    const choice = await window.pnr.contextMenu([
      { id: 'read', label: t('menu.openInReader'), enabled: Boolean(f.itemIds[0]) },
      { id: 'report', label: t('report.open'), enabled: aiReady && Boolean(f.itemIds[0]) },
      { separator: true }, { id: 'copy', label: t('menu.copyText') }
    ]);
    if (choice === 'read' && f.itemIds[0]) onOpen(f.itemIds[0]);
    else if (choice === 'report') report(f);
    else if (choice === 'copy') void window.pnr.copyText(`${f.title}\n${f.body}`);
  };
  const refs = useMemo(() => new Map<string, ItemRef>((rows ?? []).flatMap((f) => f.sources).map((r) => [r.id, r])), [rows]);

  if (!rows) return <section className="page" />;
  if (!aiReady && rows.length === 0) {
    return (
      <section className="page center">
        <div className="empty-state">
          <Zap size={30} strokeWidth={1.4} />
          <h3>{t('flashes.needAiTitle')}</h3>
          <p>{t('flashes.needAiBody')}</p>
          <button className="push" onClick={onSetup}>{t('common.connectAi')}</button>
        </div>
      </section>
    );
  }

  const shown = important ? rows.filter((f) => f.importance >= IMPORTANT) : rows;
  if (shown.length === 0) {
    return <section className="page center"><div className="empty-state">
      <Zap size={30} strokeWidth={1.4} />
      <h3>{rows.length && important ? t('flashes.emptyFilteredTitle') : t('flashes.emptyTitle')}</h3>
      <p>{rows.length && important ? t('flashes.emptyFiltered') : t('flashes.empty')}</p>
    </div></section>;
  }
  return (
    <section className="page">
      <div className="page-inner flashes">
        <ul className="flash-list">
          {shown.map((f) => (
            <li key={f.id} onContextMenu={(e) => void menu(e, f)}>
              <div className="meta">
                <span className={`tag ${f.importance >= IMPORTANT ? 'accent' : ''}`}>{f.importance >= IMPORTANT ? t('flashes.important') : t('flashes.development')}</span>
                {f.watchLabels.map((l) => <span key={l} className="src">{l}</span>)}
                <span aria-hidden>·</span>
                <time title={t('flashes.writtenAt', { when: dateTime(f.publishedAt) })}>
                  {f.itemPublishedAt ? ago(f.itemPublishedAt) : t('flashes.writtenAt', { when: ago(f.publishedAt) })}
                </time>
                {f.followUpOf && <span className="tag">{t('flashes.followUp')}</span>}
                {/* Honest about provenance: written from the article, or only from the source's summary. */}
                {f.basis === 'snippet' && <span className="tag" title={t('flashes.snippetOnlyHint')}>{t('flashes.snippetOnly')}</span>}
                {f.basis === 'search' && <span className="tag" title={t('flashes.searchFilledHint')}>{t('flashes.searchFilled')}</span>}
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {f.importanceReason && <p className="why">{f.importanceReason}</p>}
              <div className="flash-foot">
                <Cites ids={f.itemIds} refs={refs} onOpen={onOpen} />
                {aiReady && f.itemIds[0] && <button className="text-button" onClick={() => report(f)}><FileSearch size={12} />{t('report.open')}</button>}
              </div>
              {f.basis === 'search' && f.searchSources.length > 0 && <details className="disclosure">
                <summary>{t('flashes.verifiedSources', { count: f.searchSources.length })}</summary>
                <ul>{f.searchSources.map((source) => <li key={source.refId}>
                  <button className="link" onClick={() => void window.pnr.openExternal(source.url)}>{source.title || source.publisher || source.url}</button>
                </li>)}</ul>
              </details>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
