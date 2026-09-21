import { Search, Star, Inbox } from 'lucide-react';
import type { Filter } from '../App.tsx';
import type { ItemRow } from '../types.ts';

const when = (ts: number): string => {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} 天前` : new Date(ts).toLocaleDateString('zh-CN');
};

/** Languages readers here can be assumed to read; anything else is labelled. */
const FAMILIAR = new Set(['zh', 'en']);
const LANG_NAMES: Record<string, string> = {
  ja: '日文', ko: '韩文', es: '西班牙文', pt: '葡萄牙文', fr: '法文', de: '德文', it: '意大利文',
  ru: '俄文', ar: '阿拉伯文', nl: '荷兰文', uk: '乌克兰文', pl: '波兰文', tr: '土耳其文', vi: '越南文',
  id: '印尼文', th: '泰文', hi: '印地文', fa: '波斯文', he: '希伯来文'
};
export const langName = (lang: string): string => LANG_NAMES[lang] ?? lang.toUpperCase();

interface Props {
  items: ItemRow[]; total: number; onMore: (() => void) | undefined; selected: string | null;
  query: string; onQuery: (q: string) => void; filter: Filter; onManage: () => void;
  onSelect: (id: string) => void; onStar: (id: string) => void;
}

export function ItemList({ items, total, onMore, selected, onSelect, onStar, query, onQuery, filter, onManage }: Props) {
  return (
    <section className="list" aria-label="文章列表">
      <div className="list-toolbar">
        <div className="list-heading"><h2>{filter === 'unread' ? '未读文章' : filter === 'starred' ? '我的收藏' : '全部文章'}</h2><span>{total} 篇</span></div>
        <label className="search-field"><Search size={16} /><input type="search" aria-label="搜索当前列表" placeholder="搜索当前列表" value={query} onChange={e => onQuery(e.target.value)} /></label>
      </div>
      {items.length === 0 && <div className="empty-state"><Inbox size={30} /><h3>{query ? '没有找到文章' : filter === 'starred' ? '还没有收藏' : filter === 'unread' ? '暂时没有未读文章' : '从一份订阅开始'}</h3>
        <p>{query ? '试试其他关键词，或清除搜索。' : filter === 'starred' ? '点击文章旁的收藏按钮，留待稍后阅读。' : filter === 'unread' ? '刷新订阅，看看有没有新内容。' : '添加你喜欢的媒体，新闻会出现在这里。'}</p>
        {query ? <button onClick={() => onQuery('')}>清除搜索</button> : filter === 'all' ? <button className="primary" onClick={onManage}>添加订阅</button> : null}
      </div>}
      {items.map((it) => (
        <article
          key={it.id}
          className={[ 'card', selected === it.id ? 'selected' : '', it.readAt ? 'read' : '' ].join(' ').trim()}
          onClick={() => onSelect(it.id)}
        >
          <div className="card-meta">
            <span className="src">{it.sourceName}</span>
            <span className="dot">·</span>
            {/* The upstream gave no date, so this is when we first saw it.
                Saying so is cheap; quietly passing it off as a publish time is not. */}
            <span title={it.dateEstimated ? '这个来源没有提供发布时间，显示的是首次发现的时间' : undefined}>
              {it.dateEstimated ? '发现于 ' : ''}{when(it.publishedAt)}
            </span>
            {it.lang && !FAMILIAR.has(it.lang) && <span className="lang-tag">{langName(it.lang)}</span>}
            <button
              className={`star ${it.starredAt ? 'on' : ''}`}
              onClick={(e) => { e.stopPropagation(); onStar(it.id); }}
              title={it.starredAt ? '取消收藏' : '收藏'}
              aria-label={it.starredAt ? '取消收藏' : '收藏'} aria-pressed={Boolean(it.starredAt)}
            ><Star size={15} fill={it.starredAt ? 'currentColor' : 'none'} /></button>
          </div>
          <h3><button className="article-title" aria-current={selected === it.id ? true : undefined} onClick={(e) => { e.stopPropagation(); onSelect(it.id); }}>{it.title}</button></h3>
          {it.snippet && <p>{it.snippet.slice(0, 180)}</p>}
        </article>
      ))}
      {onMore && <div className="list-more"><button onClick={onMore}>加载更多（还有 {total - items.length} 篇）</button></div>}
    </section>
  );
}
