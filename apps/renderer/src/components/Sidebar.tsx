import { Bookmark, ChevronRight, CircleDot, Inbox, PanelLeft, Plus, Settings, Star, Sun, Zap } from 'lucide-react';
import { categoryLabel } from '@pnr/core/catalog-labels';
import { useTranslation } from 'react-i18next';
import type { CSSProperties, ReactNode } from 'react';
import type { SourceRow } from '../types.ts';
import type { Filter, Tab } from '../App.tsx';

interface Props {
  /** null while a view outside the tabs (a deep report) is shown. */
  tab: Tab | null; onTab: (tab: Tab) => void;
  sources: SourceRow[]; sourceId: string | undefined; filter: Filter;
  onPickSource: (id: string | undefined) => void;
  onPickFilter: (f: Filter) => void;
  onSourceMenu: (s: SourceRow) => void;
  onAdd: () => void; onSettings: (section?: string) => void; onHide: () => void;
  aiReady: boolean;
  /** New developments across the watches, counted on 关注 as unread articles are on 未读. */
  fresh: number;
  /** 全部更新, which acts on every view and so sits above all of them. */
  updateAll: ReactNode;
}

/**
 * A source's badge: its first letter on a colour picked from its name, so the
 * same source always looks the same and a long list can be scanned by eye.
 * Drawn locally — fetching favicons would tell a third party what is read.
 */
function SourceMark({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  const first = [...name.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '·';
  return <i className="source-mark" aria-hidden style={{ '--mark-hue': h % 360 } as CSSProperties}>{first.toUpperCase()}</i>;
}

/** A source whose newest article is older than this has stopped publishing. */
const STALE_DAYS = 45;
const isStale = (s: SourceRow): boolean =>
  Boolean(s.total && s.newest && Date.now() - s.newest > STALE_DAYS * 864e5);

const NAV = [['today', Sun], ['flashes', Zap], ['watches', Bookmark]] as const;
const FILTERS = [['all', Inbox], ['unread', CircleDot], ['starred', Star]] as const;

/**
 * The window's source list: the three AI views, then reading — the library
 * filters and every subscribed source. Exactly one row is selected at a time.
 */
export function Sidebar({ tab, onTab, sources, sourceId, filter, onPickSource, onPickFilter, onSourceMenu, onAdd, onSettings, onHide, aiReady, fresh, updateAll }: Props) {
  const { t, i18n } = useTranslation();
  const reading = tab === 'read';
  const totalUnread = sources.reduce((a, s) => a + (s.unread ?? 0), 0);
  const byCategory = new Map<string, SourceRow[]>();
  for (const s of sources) {
    const k = s.category ?? '';
    (byCategory.get(k) ?? byCategory.set(k, []).get(k)!).push(s);
  }
  // Two sources with one name ("Android" from a blog and from Reddit) are told apart by their domain.
  const seen = new Map<string, number>();
  for (const s of sources) seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  const groups = [...byCategory.entries()].sort((a, b) =>
    categoryLabel(a[0] || null, i18n.language).localeCompare(categoryLabel(b[0] || null, i18n.language), i18n.language));

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        {updateAll}
        <button className="tool" title={`${t('app.hideSidebar')} (⌃⌘S)`} aria-label={t('app.hideSidebar')} onClick={onHide}><PanelLeft size={17} /></button>
      </div>
      <nav className="sidebar-scroll" aria-label={t('app.mainNav')}>
        <ul className="side-list">
          {NAV.map(([id, Icon]) => (
            <li key={id}><button className={`side-row ${tab === id ? 'selected' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
              <Icon size={16} className="accent" /><span>{t(`tabs.${id}`)}</span>
              {id === 'watches' && fresh > 0 && <em title={t('watches.newTitle', { count: fresh })}>{fresh}</em>}</button></li>
          ))}
        </ul>

        <h2 className="side-heading">{t('sidebar.library')}</h2>
        <ul className="side-list">
          {FILTERS.map(([f, Icon]) => {
            const on = reading && !sourceId && filter === f;
            return <li key={f}><button className={`side-row ${on ? 'selected' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => onPickFilter(f)}>
              <Icon size={15} /><span>{t(`filters.${f}`)}</span>{f === 'unread' && totalUnread > 0 && <em>{totalUnread}</em>}</button></li>;
          })}
        </ul>

        {/* The section's own +, as Mail's mailbox headings have: it says what it adds by where it is. */}
        <div className="side-heading"><h2>{t('sidebar.sources')}</h2>
          <button className="tool mini" title={t('app.addSubscription')} aria-label={t('app.addSubscription')} onClick={onAdd}><Plus size={14} /></button></div>
        {sources.length === 0 && <p className="side-empty">{t('sidebar.noSources')}</p>}
        {groups.map(([cat, list]) => (
          <details key={cat} className="side-group" open>
            <summary><ChevronRight size={11} />{categoryLabel(cat || null, i18n.language)}</summary>
            <ul className="side-list">
              {list.map((s) => {
                const on = reading && sourceId === s.id;
                const stale = isStale(s);
                return <li key={s.id}>
                  <button className={`side-row source ${on ? 'selected' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => onPickSource(s.id)}
                    onContextMenu={(e) => { e.preventDefault(); onSourceMenu(s); }}
                    title={s.lastError ? t('sidebar.lastFailed') : stale ? t('sidebar.staleTitle', { days: STALE_DAYS }) : s.domain ?? s.name}>
                    <SourceMark name={s.name} />
                    <span>{s.name}{(seen.get(s.name) ?? 0) > 1 && s.domain ? <small className="domain">{s.domain.replace(/^www\./, '')}</small> : null}</span>
                    {s.lastError ? <small className="flag warn">{t('sidebar.failed')}</small> : stale ? <small className="flag">{t('sidebar.stale')}</small> : null}
                    {s.unread ? <em>{s.unread}</em> : null}
                  </button>
                </li>;
              })}
            </ul>
          </details>
        ))}
      </nav>
      <footer className="sidebar-footer">
        <span className="grow" />
        {/* The one part of the footer that may give way: its words shorten to an ellipsis, so the
            settings button beside it is never pushed out of a narrow sidebar. */}
        {/* It names the AI's state, so it opens the AI settings, where that state is changed. */}
        <button className="footer-status" onClick={() => onSettings('ai')} title={aiReady ? t('app.aiOn') : t('app.aiOff')}>
          <i className={`status-dot ${aiReady ? 'on' : ''}`} /><span>{aiReady ? t('app.aiOn') : t('app.aiOff')}</span></button>
        <button className="tool" title={`${t('app.settings')} (⌘,)`} aria-label={t('app.settings')} onClick={() => onSettings()}><Settings size={15} /></button>
      </footer>
    </aside>
  );
}
