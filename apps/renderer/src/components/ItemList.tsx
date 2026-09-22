import { useEffect, useRef } from 'react';
import { Inbox, Search, Star } from 'lucide-react';
import type { Filter } from '../App.tsx';
import type { ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { ago, languageName } from '../i18n.ts';

/** Languages readers here can be assumed to read; anything else is labelled. */
const FAMILIAR = new Set(['zh', 'en']);

interface Props {
  items: ItemRow[]; onMore: (() => void) | undefined; remaining: number; selected: string | null;
  query: string; onQuery: (q: string) => void; filter: Filter; empty: boolean; onManage: () => void;
  onSelect: (id: string) => void; onStar: (id: string) => void;
}

export function ItemList({ items, onMore, remaining, selected, onSelect, onStar, query, onQuery, filter, empty, onManage }: Props) {
  const { t } = useTranslation();
  const list = useRef<HTMLElement>(null);
  useEffect(() => { list.current?.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const state = query ? 'query' : empty ? 'noSources' : filter;
  return (
    <section ref={list} className="list" aria-label={t('list.label')} tabIndex={-1} onKeyDown={(e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const index = items.findIndex((it) => it.id === selected);
      const next = items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onSelect(next.id);
    }}>
      <div className="list-toolbar">
        <label className="search-field"><Search size={14} />
          <input type="search" aria-label={t('list.search')} placeholder={t('list.search')} value={query}
                 onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onQuery(''); }} /></label>
      </div>
      {items.length === 0 && <div className="empty-state">
        <Inbox size={26} strokeWidth={1.6} />
        <h3>{t(`list.empty.${state}`)}</h3>
        <p>{t(`list.hint.${state}`)}</p>
        {query ? <button className="secondary" onClick={() => onQuery('')}>{t('list.clearSearch')}</button>
          : state === 'noSources' || state === 'all' ? <button className="primary" onClick={onManage}>{t('app.addSubscription')}</button> : null}
      </div>}
      {items.map((it) => (
        <article key={it.id} className={`card ${selected === it.id ? 'selected' : ''} ${it.readAt ? 'read' : 'unread'}`}
                 onClick={() => { list.current?.focus({ preventScroll: true }); onSelect(it.id); }}>
          <div className="card-meta">
            <span className="src">{it.sourceName}</span>
            <span aria-hidden>·</span>
            {/* The upstream gave no date, so this is when we first saw it. */}
            <span title={it.dateEstimated ? t('common.noDateHint') : undefined}>
              {it.dateEstimated ? t('common.seenAt', { when: ago(it.publishedAt) }) : ago(it.publishedAt)}
            </span>
            {it.lang && !FAMILIAR.has(it.lang) && <span className="lang-tag">{languageName(it.lang)}</span>}
            <button className={`star ${it.starredAt ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onStar(it.id); }}
              title={it.starredAt ? t('list.unstar') : t('list.star')} aria-label={it.starredAt ? t('list.unstar') : t('list.star')}
              aria-pressed={Boolean(it.starredAt)}><Star size={13} fill={it.starredAt ? 'currentColor' : 'none'} /></button>
          </div>
          <h3><button className="card-title" aria-current={selected === it.id ? true : undefined}
            onClick={(e) => { e.stopPropagation(); onSelect(it.id); }}>{it.title}</button></h3>
          {it.snippet && <p>{it.snippet.slice(0, 180)}</p>}
        </article>
      ))}
      {onMore && <div className="list-more"><button className="secondary" onClick={onMore}>{t('list.more', { count: remaining })}</button></div>}
    </section>
  );
}
