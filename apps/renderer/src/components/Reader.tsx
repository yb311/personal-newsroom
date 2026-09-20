import { useEffect, useState } from 'react';
import type { Block, ItemRow } from '../types.ts';
import { Blocks } from './Blocks.tsx';

type Full = ItemRow & { blocks: Block[] | null; bodyError: string | null };

interface Deep {
  blocks: Block[];
  sources: { refId: string; title: string; url: string; domain: string | null }[];
  milestones: { date: string; text: string; refIds: string[] }[];
}

export function Reader({ id, onStar, aiReady }:
  { id: string | null; onStar: (id: string) => void; aiReady: boolean }) {
  const [item, setItem] = useState<Full | null>(null);
  const [loading, setLoading] = useState(false);
  const [deep, setDeep] = useState<Deep | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepErr, setDeepErr] = useState('');

  useEffect(() => {
    if (!id) { setItem(null); return; }
    let live = true;
    setDeep(null); setDeepErr('');
    void (async () => {
      setLoading(true);
      const full = await window.pnr.getItem(id);
      if (!live) return;
      setItem(full);
      setLoading(false);
      // Body not fetched yet: pull it now so opening an article just works.
      if (full && full.bodyState === 'pending') {
        await window.pnr.enrichOne(id);
        const again = await window.pnr.getItem(id);
        if (live) setItem(again);
      }
    })();
    return () => { live = false; };
  }, [id]);

  if (!id) return <section className="reader empty"><p>选一篇开始读。</p></section>;
  if (loading && !item) return <section className="reader empty"><p>载入中…</p></section>;
  if (!item) return <section className="reader empty"><p>找不到这一篇。</p></section>;

  const open = (): void => { void window.pnr.openExternal(item.url); };

  const goDeep = async (): Promise<void> => {
    setDeepBusy(true); setDeepErr('');
    const r = await window.pnr.deepSummary(item.id);
    if (r.noProvider) setDeepErr('还没配置 AI');
    else if (r.error) setDeepErr(r.error);
    else setDeep(r.summary as Deep);
    setDeepBusy(false);
  };

  return (
    <section className="reader">
      <article>
        <div className="reader-meta">
          <span className="src">{item.sourceName}</span>
          <span className="dot">·</span>
          <time title={item.dateEstimated ? '这个来源没有提供发布时间，显示的是首次发现的时间' : undefined}>
            {item.dateEstimated ? '发现于 ' : ''}{new Date(item.publishedAt).toLocaleString('zh-CN')}
          </time>
          {item.author && <><span className="dot">·</span><span>{item.author}</span></>}
        </div>
        <h1>{item.title}</h1>
        <div className="reader-actions">
          <button onClick={() => onStar(item.id)}>{item.starredAt ? '★ 已收藏' : '☆ 收藏'}</button>
          <button onClick={open}>在浏览器打开</button>
          {aiReady && !deep && (
            <button onClick={() => void goDeep()} disabled={deepBusy}>
              {deepBusy ? '正在梳理…' : '深入'}
            </button>
          )}
          {item.bodyWords ? <span className="words">{item.bodyWords} 词</span> : null}
        </div>

        {deepErr && <p className="muted warn">{deepErr}</p>}
        {deep && <DeepView deep={deep} />}

        {item.blocks?.length
          ? <div className="prose"><Blocks blocks={item.blocks} /></div>
          : <Unavailable state={item.bodyState} error={item.bodyError} snippet={item.snippet} onOpen={open} />}
      </article>
    </section>
  );
}

/** The on-demand summary. Every paragraph carries the reference ids it was
 *  written from, and those map to the source list below, so any sentence can be
 *  traced back to the article it came from. */
function DeepView({ deep }: { deep: Deep }) {
  const byRef = new Map(deep.sources.map((s) => [s.refId, s]));
  return (
    <div className="deep">
      <div className="prose">
        {deep.blocks.map((b, i) => {
          if (b.type === 'heading') return <h2 key={i}>{b.text}</h2>;
          if (b.type !== 'paragraph') return null;
          const refs = (b as { sourceRefIds?: string[] }).sourceRefIds ?? [];
          return (
            <p key={i}>
              {b.text}
              {refs.map((r) => {
                const s = byRef.get(r);
                return s ? (
                  <button key={r} className="cite" title={s.title}
                          onClick={() => void window.pnr.openExternal(s.url)}>{r}</button>
                ) : null;
              })}
            </p>
          );
        })}
      </div>

      {deep.milestones.length > 0 && (
        <div className="timeline">
          <h4>来龙去脉</h4>
          <ul>
            {deep.milestones.map((m, i) => (
              <li key={i}><time>{m.date}</time><span>{m.text}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="deep-sources">
        <h4>依据的材料</h4>
        <ol>
          {deep.sources.map((s) => (
            <li key={s.refId}>
              <span className="ref">{s.refId}</span>
              <button className="link" onClick={() => void window.pnr.openExternal(s.url)}>{s.title}</button>
              {s.domain && <span className="muted"> · {s.domain}</span>}
            </li>
          ))}
        </ol>
      </div>
      <hr className="deep-sep" />
    </div>
  );
}

/** Honesty rule: when the body cannot be fetched, say so and offer the browser.
 *  Never dress a feed snippet up as the article. */
function Unavailable(
  { state, error, snippet, onOpen }:
  { state: string; error: string | null; snippet: string | null; onOpen: () => void }
) {
  const why = state === 'blocked' ? '这家媒体有付费墙，正文抓不到。'
    : state === 'pending' ? '正在抓取正文…'
    : state === 'failed' ? `正文抓取失败${error ? `（${error}）` : ''}。`
    : '暂时没有正文。';
  return (
    <div className="unavailable">
      <p className="why">{why}</p>
      {snippet && <p className="snippet">{snippet}</p>}
      {state !== 'pending' && <button onClick={onOpen}>在浏览器打开原文</button>}
    </div>
  );
}
