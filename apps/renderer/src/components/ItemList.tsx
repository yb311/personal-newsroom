import { Inbox, Star } from 'lucide-react';
import type { Filter } from '../App.tsx';
import type { ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { ago, languageName } from '../i18n.ts';
import { ListPane, Row } from './ListPane.tsx';

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
  const state = query ? 'query' : empty ? 'noSources' : filter;
  return (
    <ListPane label={t('list.label')} ids={items.map((it) => it.id)} selected={selected} onSelect={onSelect}>
      {items.length === 0 && <div className="empty-state">
        <Inbox size={30} strokeWidth={1.4} />
        <h3>{t(`list.empty.${state}`)}</h3>
        <p>{t(`list.hint.${state}`)}</p>
        {query ? <button className="push" onClick={onClearQuery}>{t('list.clearSearch')}</button>
          : state === 'noSources' || state === 'all' ? <button className="push" onClick={onAdd}>{t('app.addSubscription')}</button> : null}
      </div>}
      {items.map((it) => (
        <Row key={it.id} selected={selected === it.id} className={it.readAt ? 'read' : 'unread'} onSelect={() => onSelect(it.id)} onMenu={() => onMenu(it)}>
          <div className="row-head">
            <span className="src">{it.sourceName ?? t('common.newsSearch')}</span>
            {it.starredAt && <Star size={11} className="star" fill="currentColor" aria-label={t('filters.starred')} />}
            {it.lang && !FAMILIAR.has(it.lang) && <span className="lang-tag">{languageName(it.lang)}</span>}
            {/* The upstream gave no date, so this is when we first saw it. */}
            <time title={it.dateEstimated ? t('common.noDateHint') : undefined}>
              {it.dateEstimated ? t('common.seenAt', { when: ago(it.publishedAt) }) : ago(it.publishedAt)}
            </time>
          </div>
          <h3>{it.title}</h3>
          {it.snippet && <p>{it.snippet.slice(0, 200)}</p>}
        </Row>
      ))}
      {onMore && <div className="list-more"><button className="push" onClick={onMore}>{t('list.more', { count: remaining })}</button></div>}
    </ListPane>
  );
}
