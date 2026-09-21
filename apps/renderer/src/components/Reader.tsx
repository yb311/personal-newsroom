import { BookOpen, ArrowLeft, Star, ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Block, ItemRow } from '../types.ts';
import { Blocks } from './Blocks.tsx';

type Full = ItemRow & { blocks: Block[] | null; bodyError: string | null };

interface Deep {
  blocks: Block[];
  sources: { refId: string; title: string; url: string; domain: string | null }[];
  milestones: { date: string; text: string; refIds: string[] }[];
}

export function Reader({ id, onStar, aiReady, revision, onBack }:
  { id: string | null; onStar: (id: string) => void; aiReady: boolean; revision: number; onBack: () => void }) {
  const [item, setItem] = useState<Full | null>(null);
  const [loading, setLoading] = useState(false);
  const [deep, setDeep] = useState<Deep | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepErr, setDeepErr] = useState('');
  const activeId = useRef(id);
  activeId.current = id;

  useEffect(() => {
    if (!id) { setItem(null); return; }
    let live = true;
    setItem(null); setDeep(null); setDeepErr(''); setDeepBusy(false);
    void (async () => {
      setLoading(true);
      try {
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
      } catch { if (live) { setLoading(false); setDeepErr('文章暂时无法载入，请重新选择或稍后重试。'); } }
    })();
    return () => { live = false; };
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void window.pnr.getItem(id).then(full => {
      if (live && full) setItem(current => current?.id === full.id ? { ...current, starredAt: full.starredAt } : current);
    }).catch(() => {});
    return () => { live = false; };
  }, [id, revision]);

  if (!id) return <section className="reader empty"><div className="empty-state"><BookOpen size={38} strokeWidth={1.4} /><h2>未选择文章</h2><p>从列表中选择文章。</p></div></section>;
  if (loading && !item) return <section className="reader"><button className="reader-back" onClick={onBack}><ArrowLeft size={16} />返回列表</button><p className="empty-state" role="status">载入中…</p></section>;
  if (!item) return <section className="reader"><button className="reader-back" onClick={onBack}><ArrowLeft size={16} />返回列表</button><p className="empty-state">{deepErr || '找不到这一篇。请重新选择文章。'}</p></section>;

  const open = (): void => { void window.pnr.openExternal(item.url); };

  const goDeep = async (): Promise<void> => {
    setDeepBusy(true); setDeepErr('');
    const requestedId = item.id;
    try {
      const r = await window.pnr.deepSummary(requestedId);
      if (activeId.current !== requestedId) return;
      if (r.noProvider) setDeepErr('请先连接 AI 服务');
      else if (r.error) setDeepErr(r.error);
      else setDeep(r.summary as Deep);
    } catch { if (activeId.current === requestedId) setDeepErr('暂时无法生成，请重试。'); }
    finally { if (activeId.current === requestedId) setDeepBusy(false); }
  };

  return (
    <section className="reader">
      <button className="reader-back" onClick={onBack}><ArrowLeft size={16} />返回列表</button>
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
          <button aria-pressed={Boolean(item.starredAt)} onClick={() => onStar(item.id)}><Star size={15} fill={item.starredAt ? 'currentColor' : 'none'} />{item.starredAt ? '已收藏' : '收藏'}</button>
          <button onClick={open}><ExternalLink size={15} />查看原文</button>
          {aiReady && !deep && (
            <button onClick={() => void goDeep()} disabled={deepBusy}>
              <Sparkles size={15} />{deepBusy ? '正在整理…' : '深入了解'}
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
  const why = state === 'blocked' ? '该网站限制了访问，暂时无法获取正文。'
    : state === 'pending' ? '正在抓取正文…'
    : state === 'failed' ? `正文抓取失败${error ? `（${error}）` : ''}。`
    : '暂时没有正文。';
  return (
    <div className="unavailable">
      <p className="why">{why}</p>
      {snippet && <div className="snippet"><span className="eyebrow">来源提供的摘要 · 非完整正文</span><p>{snippet}</p></div>}
      {state !== 'pending' && <button onClick={onOpen}>在浏览器打开原文</button>}
    </div>
  );
}
