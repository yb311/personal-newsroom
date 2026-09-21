import { categoryLabel } from '../categories.ts';
import type { SourceRow } from '../types.ts';
import type { Filter } from '../App.tsx';

interface Props {
  sources: SourceRow[]; sourceId: string | undefined; filter: Filter;
  onPickSource: (id: string | undefined) => void;
  onPickFilter: (f: Filter) => void;
  onManage: () => void;
}

export function Sidebar({ sources, sourceId, filter, onPickSource, onPickFilter, onManage }: Props) {
  const totalUnread = sources.reduce((a, s) => a + (s.unread ?? 0), 0);
  const filters: [Filter, string, number | null][] = [
    ['all', '全部', null], ['unread', '未读', totalUnread], ['starred', '收藏', null]
  ];
  const byCategory = new Map<string, SourceRow[]>();
  for (const s of sources) {
    const k = s.category ?? '其他';
    (byCategory.get(k) ?? byCategory.set(k, []).get(k)!).push(s);
  }

  return (
    <nav className="sidebar" aria-label="阅读筛选">
      <ul className="filters">
        {filters.map(([f, label, count]) => (
          <li key={f}>
            <button aria-pressed={filter === f} className={filter === f ? 'active' : ''} onClick={() => onPickFilter(f)}>
              <span>{label}</span>
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
        <li>
          <button aria-pressed={!sourceId} className={!sourceId ? 'active' : ''} onClick={() => onPickSource(undefined)}>
            <span>所有源</span><em>{sources.length}</em>
          </button>
        </li>
        {[...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cat, list]) => (
          <li key={cat} className="group">
            <div className="group-label">{categoryLabel(cat)}</div>
            <ul>
              {list.map((s) => (
                <li key={s.id}>
                  <button
                    aria-pressed={sourceId === s.id} className={sourceId === s.id ? 'active' : ''}
                    onClick={() => onPickSource(s.id)}
                    title={s.lastError ? `上次抓取失败：${s.lastError}` : s.domain ?? s.name}
                  >
                    <span>{s.name}{s.lastError ? ' ⚠' : ''}</span>
                    {s.unread ? <em>{s.unread}</em> : null}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
