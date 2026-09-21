import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

interface FlashRow {
  id: string; watchId: string | null; watchLabel: string | null;
  publishedAt: number; title: string; body: string;
  importance: number; importanceReason: string | null;
  category: string | null; basis: 'article' | 'search'; followUpOf: string | null;
}

const when = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小时前` : new Date(ts).toLocaleDateString('zh-CN');
};

export function Flashes({ aiReady, onSetup, onRead, onRun, running }:
  { aiReady: boolean; onSetup: () => void; onRead: () => void; onRun: () => void; running: boolean }) {
  const [rows, setRows] = useState<FlashRow[]>([]);
  const [onlyImportant, setOnlyImportant] = useState(false);

  useEffect(() => { void window.pnr.flashes(24).then((r) => setRows(r as FlashRow[])); }, [running]);

  if (!aiReady && rows.length === 0) {
    return (
      <section className="pane center">
        <div className="setup-card"><div className="feature-icon"><Sparkles size={27} /></div>
          <h2>尚未启用快讯</h2>
          <p>在设置中连接 AI，检查关注的新进展。</p>
          <div className="setup-actions"><button className="primary" onClick={onSetup}>连接 AI</button><button onClick={onRead}>先去阅读</button></div>
          <p className="muted">阅读和收藏无需 AI，随时可用。</p>
        </div>
      </section>
    );
  }

  const shown = onlyImportant ? rows.filter((f) => f.importance >= 8) : rows;

  return (
    <section className="pane scroll">
      <div className="pane-inner flashes-page">
        <div className="flash-head">
          <h2>最近 24 小时</h2>
          <span className="grow" />
          <label className="inline-check">
            <input type="checkbox" checked={onlyImportant} onChange={(e) => setOnlyImportant(e.target.checked)} />
            只看重要的
          </label>

        </div>

        {shown.length === 0 && (
          <p className="muted">
            这段时间没有值得打扰你的新进展。
            {rows.length > 0 && onlyImportant && '（把筛选去掉可以看到全部。）'}
          </p>
        )}

        <ul className="flash-list">
          {shown.map((f) => (
            <li key={f.id}>
              <div className="flash-meta">
                <em className={`imp ${f.importance >= 8 ? 'high' : ''}`}>{f.importance >= 8 ? '重要' : '进展'}</em>
                {f.watchLabel && <span className="src">{f.watchLabel}</span>}
                <span className="dot">·</span>
                <time>{when(f.publishedAt)}</time>
                {f.followUpOf && <span className="tag">后续</span>}
                {/* Honest about provenance: written from the article, or filled
                    in by search because the body could not be fetched. */}
                {f.basis === 'search' && <span className="tag" title="正文抓不到，内容由搜索补全">搜索补全</span>}
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {f.importanceReason && <p className="why">{f.importanceReason}</p>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
