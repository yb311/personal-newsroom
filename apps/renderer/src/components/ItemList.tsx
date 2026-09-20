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

interface Props {
  items: ItemRow[]; selected: string | null;
  onSelect: (id: string) => void; onStar: (id: string) => void;
}

export function ItemList({ items, selected, onSelect, onStar }: Props) {
  if (items.length === 0) {
    return <section className="list empty"><p>这里还没有内容。点右上角「刷新」抓一次。</p></section>;
  }
  return (
    <section className="list">
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
            <button
              className={`star ${it.starredAt ? 'on' : ''}`}
              onClick={(e) => { e.stopPropagation(); onStar(it.id); }}
              title={it.starredAt ? '取消收藏' : '收藏'}
            >{it.starredAt ? '★' : '☆'}</button>
          </div>
          <h3>{it.title}</h3>
          {it.snippet && <p>{it.snippet.slice(0, 180)}</p>}
        </article>
      ))}
    </section>
  );
}
