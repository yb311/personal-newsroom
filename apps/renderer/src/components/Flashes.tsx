import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FlashRow, ItemRef } from '../types.ts';
import { Cites } from './Cites.tsx';
import { useTranslation } from 'react-i18next';
import { ago, dateTime } from '../i18n.ts';

export function Flashes({ aiReady, onSetup, onRead, onOpen, running }:
  { aiReady: boolean; onSetup: () => void; onRead: () => void; onOpen: (id: string) => void; running: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FlashRow[]>([]);
  const [onlyImportant, setOnlyImportant] = useState(false);

  useEffect(() => { void window.pnr.flashes(24).then(setRows); }, [running]);
  const refs = useMemo(() => new Map<string, ItemRef>(rows.flatMap((f) => f.sources).map((r) => [r.id, r])), [rows]);

  if (!aiReady && rows.length === 0) {
    return (
      <section className="pane center">
        <div className="setup-card"><div className="feature-icon"><Sparkles size={27} /></div>
          <h2>{t('flashes.needAiTitle')}</h2>
          <p>{t('flashes.needAiBody')}</p>
          <div className="setup-actions"><button className="primary" onClick={onSetup}>{t('common.connectAi')}</button><button onClick={onRead}>{t('flashes.readFirst')}</button></div>
        </div>
      </section>
    );
  }

  const shown = onlyImportant ? rows.filter((f) => f.importance >= 8) : rows;

  return (
    <section className="pane scroll">
      <div className="pane-inner flashes-page">
        <div className="flash-head">
          <h2>{t('flashes.last24h')}</h2>
          <span className="grow" />
          <label className="inline-check">
            <input type="checkbox" checked={onlyImportant} onChange={(e) => setOnlyImportant(e.target.checked)} />
            {t('flashes.onlyImportant')}
          </label>
        </div>

        {shown.length === 0 && (
          <p className="muted">
            {t('flashes.empty')}
            {rows.length > 0 && onlyImportant && t('flashes.emptyFiltered')}
          </p>
        )}

        <ul className="flash-list">
          {shown.map((f) => (
            <li key={f.id}>
              <div className="flash-meta">
                <em className={`imp ${f.importance >= 8 ? 'high' : ''}`}>{f.importance >= 8 ? t('flashes.important') : t('flashes.development')}</em>
                {f.watchLabels.map((l) => <span key={l} className="src">{l}</span>)}
                <span className="dot">·</span>
                <time title={t('flashes.writtenAt', { when: dateTime(f.publishedAt) })}>
                  {f.itemPublishedAt ? t('flashes.publishedAgo', { when: ago(f.itemPublishedAt) }) : t('flashes.writtenAt', { when: ago(f.publishedAt) })}
                </time>
                {f.followUpOf && <span className="tag">{t('flashes.followUp')}</span>}
                {/* Honest about provenance: written from the article, or only
                    from the summary the source provided. */}
                {f.basis === 'snippet' && <span className="tag" title={t('flashes.snippetOnlyHint')}>{t('flashes.snippetOnly')}</span>}
                {f.basis === 'search' && <span className="tag" title={t('flashes.searchFilledHint')}>{t('flashes.searchFilled')}</span>}
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {f.importanceReason && <p className="why">{f.importanceReason}</p>}
              <Cites ids={f.itemIds} refs={refs} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
