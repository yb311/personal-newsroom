import { useEffect, useState } from 'react';
import type { Today as TodayData } from '../types.ts';
import { Blocks } from './Blocks.tsx';

/** The 今日 tab: the "since yesterday" panel on top, then the brief itself.
 *  Both are rendered from the same milestone data (see progress.ts). */
export function Today({ aiReady, onSetup, onRun, running }:
  { aiReady: boolean; onSetup: () => void; onRun: () => void; running: boolean }) {
  const [data, setData] = useState<TodayData | null>(null);

  useEffect(() => { void window.pnr.today().then(setData); }, [running]);

  if (!aiReady) {
    return (
      <section className="pane center">
        <div className="setup-card">
          <h2>今日摘要需要 AI</h2>
          <p>这个软件不填 key 也能当 RSS 阅读器用。要生成专属摘要、快讯和进展对比，
             需要填一个你自己的 API key。内容和 key 都只存在你这台电脑上。</p>
          <p className="muted">按目前的设计，一天大约花 10–30 美分。</p>
          <button className="primary" onClick={onSetup}>去设置</button>
        </div>
      </section>
    );
  }

  const changes = data?.changes ?? [];
  const digest = data?.digest ?? null;

  return (
    <section className="pane scroll">
      <div className="pane-inner">
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
