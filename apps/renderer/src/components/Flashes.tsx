import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FlashRow, ItemRef } from '../types.ts';
import { Cites } from './Cites.tsx';

const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小时前` : new Date(ts).toLocaleDateString('zh-CN');
};

export function Flashes({ aiReady, onSetup, onRead, onOpen, running }:
  { aiReady: boolean; onSetup: () => void; onRead: () => void; onOpen: (id: string) => void; running: boolean }) {
  const [rows, setRows] = useState<FlashRow[]>([]);
  const [onlyImportant, setOnlyImportant] = useState(false);

  useEffect(() => { void window.pnr.flashes(24).then(setRows); }, [running]);
  const refs = useMemo(() => new Map<string, ItemRef>(rows.flatMap((f) => f.sources).map((r) => [r.id, r])), [rows]);

  if (!aiReady && rows.length === 0) {
    return (
      <section className="pane center">
        <div className="setup-card"><div className="feature-icon"><Sparkles size={27} /></div>
          <h2>快讯需要 AI</h2>
          <p>快讯会从你关注的事里挑出最新进展，写成一两句话。连接 AI 后可用。</p>
          <div className="setup-actions"><button className="primary" onClick={onSetup}>连接 AI</button><button onClick={onRead}>先去阅读</button></div>
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
                {f.watchLabels.map((l) => <span key={l} className="src">{l}</span>)}
                <span className="dot">·</span>
                <time title={`整理于 ${new Date(f.publishedAt).toLocaleString('zh-CN')}`}>
                  {f.itemPublishedAt ? `新闻发布于 ${ago(f.itemPublishedAt)}` : `整理于 ${ago(f.publishedAt)}`}
                </time>
                {f.followUpOf && <span className="tag">后续</span>}
                {/* Honest about provenance: written from the article, or only
                    from the summary the source provided. */}
                {f.basis === 'snippet' && <span className="tag" title="没能抓到原文，这条只依据来源提供的摘要">仅依据摘要</span>}
                {f.basis === 'search' && <span className="tag" title="正文抓不到，内容由搜索补全">搜索补全</span>}
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {f.importanceReason && <p className="why">{f.importanceReason}</p>}
              <Cites ids={f.itemIds} refs={refs} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
