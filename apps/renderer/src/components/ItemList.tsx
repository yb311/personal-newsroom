import { useEffect, useRef } from 'react';
import { Search, Star, Inbox } from 'lucide-react';
import type { Filter } from '../App.tsx';
import type { ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { ago, languageName } from '../i18n.ts';

/** Languages readers here can be assumed to read; anything else is labelled. */
const FAMILIAR = new Set(['zh', 'en']);

interface Props {
  items: ItemRow[]; total: number; onMore: (() => void) | undefined; selected: string | null;
  query: string; onQuery: (q: string) => void; filter: Filter; onManage: () => void;
  onSelect: (id: string) => void; onStar: (id: string) => void;
}

export function ItemList({ items, total, onMore, selected, onSelect, onStar, query, onQuery, filter, onManage }: Props) {
  const { t } = useTranslation();
  const list = useRef<HTMLElement>(null);
  useEffect(() => { list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  return (
    <section ref={list} className="list" aria-label={t('list.label')} tabIndex={0} onKeyDown={e => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      const index = items.findIndex(it => it.id === selected);
      const next = items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onSelect(next.id);
    }}>
      <div className="list-toolbar">
        <div className="list-heading"><h2>{t(`filters.${filter}`)}</h2><span>{t('list.count', { count: total })}</span></div>
        <label className="search-field"><Search size={16} /><input type="search" aria-label={t('list.search')} placeholder={t('list.search')} value={query} onChange={e => onQuery(e.target.value)} /></label>
      </div>
      {items.length === 0 && <div className="empty-state"><Inbox size={30} /><h3>{t(query ? 'list.emptyQuery' : filter === 'starred' ? 'list.emptyStarred' : filter === 'unread' ? 'list.emptyUnread' : 'list.emptyAll')}</h3>
        <p>{t(query ? 'list.hintQuery' : filter === 'starred' ? 'list.hintStarred' : filter === 'unread' ? 'list.hintUnread' : 'list.hintAll')}</p>
        {query ? <button onClick={() => onQuery('')}>{t('list.clearSearch')}</button> : filter === 'all' ? <button className="primary" onClick={onManage}>{t('app.addSubscription')}</button> : null}
      </div>}
      {items.map((it) => (
        <article
          key={it.id}
          className={[ 'card', selected === it.id ? 'selected' : '', it.readAt ? 'read' : '' ].join(' ').trim()}
          onClick={() => { list.current?.focus({ preventScroll: true }); onSelect(it.id); }}
        >
          <div className="card-meta">
            <span className="src">{it.sourceName}</span>
            <span className="dot">·</span>
            {/* The upstream gave no date, so this is when we first saw it.
                Saying so is cheap; quietly passing it off as a publish time is not. */}
            <span title={it.dateEstimated ? t('common.noDateHint') : undefined}>
              {it.dateEstimated ? t('common.seenAt', { when: ago(it.publishedAt) }) : ago(it.publishedAt)}
            </span>
            {it.lang && !FAMILIAR.has(it.lang) && <span className="lang-tag">{languageName(it.lang)}</span>}
            <button
              className={`star ${it.starredAt ? 'on' : ''}`}
              onClick={(e) => { e.stopPropagation(); onStar(it.id); }}
              title={it.starredAt ? t('list.unstar') : t('list.star')}
              aria-label={it.starredAt ? t('list.unstar') : t('list.star')} aria-pressed={Boolean(it.starredAt)}
            ><Star size={15} fill={it.starredAt ? 'currentColor' : 'none'} /></button>
          </div>
          <h3><button className="article-title" aria-current={selected === it.id ? true : undefined} onClick={(e) => { e.stopPropagation(); onSelect(it.id); }}>{it.title}</button></h3>
          {it.snippet && <p>{it.snippet.slice(0, 180)}</p>}
        </article>
      ))}
      {onMore && <div className="list-more"><button onClick={onMore}>{t('list.more', { count: total - items.length })}</button></div>}
    </section>
  );
}
