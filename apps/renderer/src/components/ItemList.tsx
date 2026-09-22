import { useEffect, useRef } from 'react';
import { Inbox, Star } from 'lucide-react';
import type { Filter } from '../App.tsx';
import type { ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { ago, languageName } from '../i18n.ts';

/** Languages readers here can be assumed to read; anything else is labelled. */
const FAMILIAR = new Set(['zh', 'en']);

interface Props {
  items: ItemRow[]; onMore: (() => void) | undefined; remaining: number; selected: string | null;
  query: string; onClearQuery: () => void; filter: Filter; empty: boolean; onAdd: () => void;
  onSelect: (id: string) => void; onMenu: (item: ItemRow) => void;
}

/** The message list: one row per article, arrow keys move the selection. */
export function ItemList({ items, onMore, remaining, selected, onSelect, onMenu, query, onClearQuery, filter, empty, onAdd }: Props) {
  const { t } = useTranslation();
  const list = useRef<HTMLElement>(null);
  useEffect(() => { list.current?.querySelector('.row-item.selected')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const state = query ? 'query' : empty ? 'noSources' : filter;
  return (
    <section ref={list} className="list" aria-label={t('list.label')} tabIndex={0} onKeyDown={(e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const index = items.findIndex((it) => it.id === selected);
      const next = items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onSelect(next.id);
    }}>
      {items.length === 0 && <div className="empty-state">
        <Inbox size={30} strokeWidth={1.4} />
        <h3>{t(`list.empty.${state}`)}</h3>
        <p>{t(`list.hint.${state}`)}</p>
        {query ? <button className="push" onClick={onClearQuery}>{t('list.clearSearch')}</button>
          : state === 'noSources' || state === 'all' ? <button className="push" onClick={onAdd}>{t('app.addSubscription')}</button> : null}
      </div>}
      {items.map((it) => (
        <article key={it.id} className={`row-item ${selected === it.id ? 'selected' : ''} ${it.readAt ? 'read' : 'unread'}`}
                 aria-selected={selected === it.id} onMouseDown={() => list.current?.focus({ preventScroll: true })}
                 onClick={() => onSelect(it.id)} onContextMenu={(e) => { e.preventDefault(); onSelect(it.id); onMenu(it); }}>
          <div className="row-head">
            <span className="src">{it.sourceName}</span>
            {it.starredAt && <Star size={11} className="star" fill="currentColor" aria-label={t('filters.starred')} />}
            {it.lang && !FAMILIAR.has(it.lang) && <span className="lang-tag">{languageName(it.lang)}</span>}
            {/* The upstream gave no date, so this is when we first saw it. */}
            <time title={it.dateEstimated ? t('common.noDateHint') : undefined}>
              {it.dateEstimated ? t('common.seenAt', { when: ago(it.publishedAt) }) : ago(it.publishedAt)}
            </time>
          </div>
          <h3>{it.title}</h3>
          {it.snippet && <p>{it.snippet.slice(0, 200)}</p>}
        </article>
      ))}
      {onMore && <div className="list-more"><button className="push" onClick={onMore}>{t('list.more', { count: remaining })}</button></div>}
    </section>
  );
}
