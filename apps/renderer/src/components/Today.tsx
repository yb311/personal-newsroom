import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Today as TodayData } from '../types.ts';
import { Blocks } from './Blocks.tsx';

/** The 今日 tab: the "since yesterday" panel on top, then the brief itself.
 *  Both are rendered from the same milestone data (see progress.ts). */
export function Today({ aiReady, onSetup, onRead, onRun, running }:
  { aiReady: boolean; onSetup: () => void; onRead: () => void; onRun: () => void; running: boolean }) {
  const [data, setData] = useState<TodayData | null>(null);

  useEffect(() => { void window.pnr.today().then(setData); }, [running]);

  if (!aiReady && !data?.digest && !data?.changes.length) {
    return (
      <section className="pane center">
        <div className="setup-card"><div className="feature-icon"><Sparkles size={27} /></div>
          <h2>尚未启用今日摘要</h2>
          <p>在设置中连接 AI，生成关注摘要和进展。</p>
          <div className="setup-actions"><button className="primary" onClick={onSetup}>连接 AI</button><button onClick={onRead}>先去阅读</button></div>
          <p className="muted">阅读和收藏无需 AI，随时可用。</p>
        </div>
      </section>
    );
  }

  const changes = data?.changes ?? [];
  const digest = data?.digest ?? null;

  return (
    <section className="pane scroll">
      <div className="pane-inner today-page">
        {changes.length > 0 && (
          <div className="changes">
            <h2>昨天到今天</h2>
            {changes.map((c) => (
              <div key={c.watchId} className="change-group">
                <h3>{c.label}</h3>
                <ul>
                  {c.milestones.map((m) => (
                    <li key={m.id}><time>{m.occurredOn}</time><span>{m.summary}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {digest ? (
          <article className="digest">
            <div className="digest-meta">
              {data?.date} · 生成于 {new Date(digest.generatedAt).toLocaleTimeString('zh-CN')}
            </div>
            <h1>{digest.title}</h1>
            <div className="prose"><Blocks blocks={digest.blocks} /></div>
          </article>
        ) : (
          <div className="empty-block">
            <p>今天还没有生成摘要。</p>
            <button className="primary" onClick={onRun} disabled={running}>
              {running ? '正在生成…' : '现在生成'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
