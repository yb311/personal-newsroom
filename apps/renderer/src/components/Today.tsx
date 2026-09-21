import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { HeadlineGroup, ItemRef, Today as TodayData } from '../types.ts';
import { Blocks } from './Blocks.tsx';
import { Cites } from './Cites.tsx';

const clock = (ts: number): string => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

/**
 * The 今日 tab. With AI: 昨天到今天 on top, then the brief, then the day's
 * headlines. Without AI it is still a front page — the headlines of the last
 * day from every subscribed source — rather than a request to set something up.
 * Every AI-written sentence links back to the articles it came from.
 */
export function Today({ aiReady, onSetup, onRun, onOpen, running }:
  { aiReady: boolean; onSetup: () => void; onRun: () => void; onOpen: (id: string) => void; running: boolean }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [headlines, setHeadlines] = useState<HeadlineGroup[]>([]);

  useEffect(() => {
    void window.pnr.today().then(setData);
    void window.pnr.headlines(24, 4).then(setHeadlines);
  }, [running]);

  const refs = useMemo(() => new Map<string, ItemRef>((data?.refs ?? []).map((r) => [r.id, r])), [data]);
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
                    <li key={m.id}><time>{m.occurredOn}</time><span>{m.summary}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} /></span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {digest ? (
          <article className="digest">
            <div className="digest-meta">{data?.date} · 生成于 {clock(digest.generatedAt)}</div>
            <h1>{digest.title}</h1>
            <div className="prose"><Blocks blocks={digest.blocks} refs={refs} onOpen={onOpen} /></div>
          </article>
        ) : aiReady ? (
          <div className="empty-block">
            <p>今天还没有生成摘要。</p>
            <button className="primary" onClick={onRun} disabled={running}>{running ? '正在生成…' : '现在生成'}</button>
          </div>
        ) : (
          <p className="muted today-note">
            <Sparkles size={14} /> 连接 AI 后，这里会先显示按你的关注写的今日摘要。
            <button className="link" onClick={onSetup}>去设置</button>
          </p>
        )}

        <div className="headlines">
          <h2>今日要闻</h2>
          {headlines.length === 0 && <p className="muted">最近 24 小时还没有新文章，刷新订阅试试。</p>}
          {headlines.map((g) => (
            <div key={g.sourceId} className="headline-group">
              <h3>{g.sourceName}</h3>
              <ul>
                {g.items.map((it) => (
                  <li key={it.id}>
                    <button className="headline" onClick={() => onOpen(it.id)}>{it.title}</button>
                    <time>{clock(it.publishedAt)}</time>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
