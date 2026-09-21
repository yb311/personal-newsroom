import { Inbox, Circle, Star, ChevronRight } from 'lucide-react';
import { categoryLabel } from '../categories.ts';
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
  const totalUnread = sources.reduce((a, s) => a + (s.unread ?? 0), 0);
  const filters: [Filter, string, number | null][] = [
    ['all', '全部文章', null], ['unread', '未读文章', totalUnread], ['starred', '我的收藏', null]
  ];
  const byCategory = new Map<string, SourceRow[]>();
  for (const s of sources) {
    const k = s.category ?? '其他';
    (byCategory.get(k) ?? byCategory.set(k, []).get(k)!).push(s);
  }

  return (
    <nav className="sidebar" aria-label="阅读筛选">
      <div className="sidebar-section-label">资料库</div>
      <ul className="filters">
        {filters.map(([f, label, count]) => (
          <li key={f}>
            <button aria-pressed={active && !sourceId && filter === f} className={active && !sourceId && filter === f ? 'active' : ''} onClick={() => onPickFilter(f)}>
              {f === 'all' ? <Inbox size={16} /> : f === 'unread' ? <Circle size={15} /> : <Star size={16} />}<span>{label}</span>
              {count ? <em>{count}</em> : null}
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-head">
        <span>订阅源</span>
        <button className="link" onClick={onManage}>管理</button>
      </div>

      <ul className="sources">
        {[...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cat, list]) => (
          <li key={cat} className="group">
            <details open><summary className="group-label"><ChevronRight size={12} />{categoryLabel(cat)}</summary>
            <ul>
              {list.map((s) => (
                <li key={s.id}>
                  <button
                    aria-pressed={active && sourceId === s.id} className={active && sourceId === s.id ? 'active' : ''}
                    onClick={() => onPickSource(s.id)}
                    title={s.lastError ? '上次更新失败' : isStale(s) ? `已经 ${STALE_DAYS} 天以上没有新文章` : s.domain ?? s.name}
                  >
                    <span>{s.name}{s.lastError ? ' ⚠' : ''}{isStale(s) ? <small className="stale">已停更</small> : null}</span>
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
