import { Inbox, Circle, Star, ChevronRight } from 'lucide-react';
import { categoryLabel } from '@pnr/core/catalog-labels';
import { useTranslation } from 'react-i18next';
import type { SourceRow } from '../types.ts';
import type { Filter } from '../App.tsx';

interface Props {
  active: boolean; sources: SourceRow[]; sourceId: string | undefined; filter: Filter;
  onPickSource: (id: string | undefined) => void;
  onPickFilter: (f: Filter) => void;
  onManage: () => void;
}

/** A source whose newest article is older than this has stopped publishing. */
const STALE_DAYS = 45;
const isStale = (s: SourceRow): boolean =>
  Boolean(s.total && s.newest && Date.now() - s.newest > STALE_DAYS * 864e5);

export function Sidebar({ active, sources, sourceId, filter, onPickSource, onPickFilter, onManage }: Props) {
  const { t, i18n } = useTranslation();
  const totalUnread = sources.reduce((a, s) => a + (s.unread ?? 0), 0);
  const filters: [Filter, number | null][] = [['all', null], ['unread', totalUnread], ['starred', null]];
  const byCategory = new Map<string, SourceRow[]>();
  for (const s of sources) {
    const k = s.category ?? '';
    (byCategory.get(k) ?? byCategory.set(k, []).get(k)!).push(s);
  }

  return (
    <nav className="sidebar" aria-label={t('sidebar.label')}>
      <div className="sidebar-section-label">{t('sidebar.library')}</div>
      <ul className="filters">
        {filters.map(([f, count]) => (
          <li key={f}>
            <button aria-pressed={active && !sourceId && filter === f} className={active && !sourceId && filter === f ? 'active' : ''} onClick={() => onPickFilter(f)}>
              {f === 'all' ? <Inbox size={16} /> : f === 'unread' ? <Circle size={15} /> : <Star size={16} />}<span>{t(`filters.${f}`)}</span>
              {count ? <em>{count}</em> : null}
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-head">
        <span>{t('sidebar.sources')}</span>
        <button className="link" onClick={onManage}>{t('sidebar.manage')}</button>
      </div>

      <ul className="sources">
        {[...byCategory.entries()].sort((a, b) => categoryLabel(a[0] || null, i18n.language).localeCompare(categoryLabel(b[0] || null, i18n.language), i18n.language)).map(([cat, list]) => (
          <li key={cat} className="group">
            <details open><summary className="group-label"><ChevronRight size={12} />{categoryLabel(cat || null, i18n.language)}</summary>
            <ul>
              {list.map((s) => (
                <li key={s.id}>
                  <button
                    aria-pressed={active && sourceId === s.id} className={active && sourceId === s.id ? 'active' : ''}
                    onClick={() => onPickSource(s.id)}
                    title={s.lastError ? t('sidebar.lastFailed') : isStale(s) ? t('sidebar.staleTitle', { days: STALE_DAYS }) : s.domain ?? s.name}
                  >
                    <span>{s.name}{s.lastError ? ' ⚠' : ''}{isStale(s) ? <small className="stale">{t('sidebar.stale')}</small> : null}</span>
                    {s.unread ? <em>{s.unread}</em> : null}
                  </button>
                </li>
              ))}
            </ul></details>
          </li>
        ))}
      </ul>
    </nav>
  );
}
