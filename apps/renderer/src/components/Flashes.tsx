import { Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FlashRow, ItemRef } from '../types.ts';
import { Cites } from './Cites.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime } from '../i18n.ts';

/** Importance at or above this is shown as 重要 and kept by the filter. */
const IMPORTANT = 8;

export function Flashes({ aiReady, revision, onSetup, onOpen }: {
  aiReady: boolean; revision: number; onSetup: () => void; onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FlashRow[] | null>(null);
  const [onlyImportant, setOnlyImportant] = useState(false);

  useEffect(() => {
    let live = true;
    void window.pnr.flashes(24).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [revision]);
  const refs = useMemo(() => new Map<string, ItemRef>((rows ?? []).flatMap((f) => f.sources).map((r) => [r.id, r])), [rows]);

  if (!rows) return <section className="page" />;
  if (!aiReady && rows.length === 0) {
    return (
      <section className="page center">
        <div className="empty-state">
          <Zap size={26} strokeWidth={1.6} />
          <h3>{t('flashes.needAiTitle')}</h3>
          <p>{t('flashes.needAiBody')}</p>
          <button className="primary" onClick={onSetup}>{t('common.connectAi')}</button>
        </div>
      </section>
    );
  }

  const shown = onlyImportant ? rows.filter((f) => f.importance >= IMPORTANT) : rows;
  return (
    <section className="page">
      <div className="page-toolbar">
        <h2>{t('flashes.last24h')}</h2>
        <span className="subtitle">{t('flashes.count', { count: rows.length })}</span>
        <span className="grow" />
        <label className="check"><input type="checkbox" checked={onlyImportant} onChange={(e) => setOnlyImportant(e.target.checked)} />{t('flashes.onlyImportant')}</label>
      </div>
      <div className="page-inner flashes">
        {shown.length === 0 && <p className="section-hint">{rows.length && onlyImportant ? t('flashes.emptyFiltered') : t('flashes.empty')}</p>}
        <ul className="flash-list">
          {shown.map((f) => (
            <li key={f.id}>
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
              <Cites ids={f.itemIds} refs={refs} onOpen={onOpen} />
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
