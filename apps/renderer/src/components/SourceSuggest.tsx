import { countryLabel, scoreFieldLabel } from '@pnr/core/catalog-labels';
import { Dialog } from './Dialog.tsx';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SourceSuggestions } from '../types.ts';

/**
 * After watches are created: the catalogue sources the model picked for them.
 * The person keeps the ones they want and chooses where they go — subscribed
 * in 阅读, or fetched only for the watch. Nothing is added without a click.
 * When there is nothing to suggest (no AI, a failed call, no fit) the sheet
 * closes on its own.
 */
export function SourceSuggest({ watchIds, onClose }: { watchIds: string[]; onClose: (added: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [groups, setGroups] = useState<SourceSuggestions | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void window.pnr.suggestSources(watchIds, i18n.language).then((g) => {
      if (!live) return;
      // A source picked for several watches is listed once, under the first.
      const seen = new Set<string>();
      const unique = g.map((x) => ({ ...x, sources: x.sources.filter((s) => !seen.has(s.sourceId) && seen.add(s.sourceId)) }))
        .filter((x) => x.sources.length);
      if (!unique.length) { onClose(false); return; }
      setGroups(unique); setKept(seen);
    }).catch(() => { if (live) onClose(false); });
    return () => { live = false; };
  }, []);

  const toggle = (id: string): void => setKept((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const apply = async (placement: 'front' | 'back'): Promise<void> => {
    if (!groups || busy) return;
    setBusy(true);
    try {
      for (const g of groups) {
        const ids = g.sources.map((s) => s.sourceId).filter((id) => kept.has(id));
        if (ids.length) await window.pnr.applyWatchSources(g.watchId, ids, placement);
      }
      onClose(true);
    } finally { setBusy(false); }
  };

  const multi = (groups?.length ?? 0) > 1;
  return (
    <Dialog title={t('sourceSuggest.title')} onClose={() => { if (!busy) onClose(false); }} className="source-suggest-dialog">
      <header><h2>{t('sourceSuggest.title')}</h2></header>
      <div className="dialog-body">
        {!groups ? <p className="section-hint">{t('sourceSuggest.loading')}</p> : <>
          <p className="section-hint">{t('sourceSuggest.intro')}</p>
          {groups.map((g) => (
            <section key={g.watchId} className="suggest-group">
              {multi && <h4>{g.label}</h4>}
              <ul className="suggest-list">
                {g.sources.map((s) => (
                  <li key={s.sourceId}>
                    <label>
                      <input type="checkbox" checked={kept.has(s.sourceId)} onChange={() => toggle(s.sourceId)} />
                      <span className="suggest-text">
                        <span className="suggest-meta">
                          <strong>{s.name}</strong>
                          {s.country && <span className="tag">{countryLabel(s.country, i18n.language)}</span>}
                          {s.field && <span className="tag" title={t('sourceSuggest.scoreTitle')}>
                            {t('sourceSuggest.score', { field: scoreFieldLabel(s.field, i18n.language), score: s.score })}</span>}
                          <span className="domain">{s.domain}</span>
                        </span>
                        {s.reason && <span className="suggest-reason">{s.reason}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="push" disabled={busy} onClick={() => onClose(false)}>{t('sourceSuggest.skip')}</button>
        {groups && <>
          <button type="button" className="push" disabled={busy || kept.size === 0} onClick={() => void apply('back')}>{t('sourceSuggest.watchOnly')}</button>
          {/* Mounted once the list is in, so it takes focus and Return triggers it. */}
          <button type="button" className="primary" autoFocus disabled={busy || kept.size === 0} onClick={() => void apply('front')}>{t('sourceSuggest.subscribe')}</button>
        </>}
      </footer>
    </Dialog>
  );
}
