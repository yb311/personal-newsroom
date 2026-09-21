import { BookOpen, ArrowLeft, Star, ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Block, ItemBody, ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { dateTime } from '../i18n.ts';

type Full = ItemRow & { body: ItemBody | null; bodyError: string | null };

/** Below this a body is complete but brief (a results line, a breaking-news
 *  stub); the reader says so rather than looking truncated. */
const SHORT_WORDS = 120;

interface Deep {
  blocks: Block[];
  sources: { refId: string; title: string; url: string; domain: string | null }[];
  milestones: { date: string; text: string; refIds: string[] }[];
}

export function Reader({ id, onStar, aiReady, revision, onBack }:
  { id: string | null; onStar: (id: string) => void; aiReady: boolean; revision: number; onBack: () => void }) {
  const { t } = useTranslation();
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
      } catch { if (live) { setLoading(false); setDeepErr(t('reader.loadFailed')); } }
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

  if (!id) return <section className="reader empty"><div className="empty-state"><BookOpen size={38} strokeWidth={1.4} /><h2>{t('reader.noneTitle')}</h2><p>{t('reader.noneHint')}</p></div></section>;
  if (loading && !item) return <section className="reader"><button className="reader-back" onClick={onBack}><ArrowLeft size={16} />{t('reader.back')}</button><p className="empty-state" role="status">{t('common.loading')}</p></section>;
  if (!item) return <section className="reader"><button className="reader-back" onClick={onBack}><ArrowLeft size={16} />{t('reader.back')}</button><p className="empty-state">{deepErr || t('reader.notFound')}</p></section>;

  const open = (): void => { void window.pnr.openExternal(item.url); };

  const goDeep = async (): Promise<void> => {
    setDeepBusy(true); setDeepErr('');
    const requestedId = item.id;
    try {
      const r = await window.pnr.deepSummary(requestedId);
      if (activeId.current !== requestedId) return;
      if (r.noProvider) setDeepErr(t('reader.needAi'));
      else if (r.error) setDeepErr(r.error);
      else setDeep(r.summary as Deep);
    } catch { if (activeId.current === requestedId) setDeepErr(t('reader.deepFailed')); }
    finally { if (activeId.current === requestedId) setDeepBusy(false); }
  };

  return (
    <section className="reader" key={id}>
      <button className="reader-back" onClick={onBack}><ArrowLeft size={16} />{t('reader.back')}</button>
      <div className="reader-actions">
          <button aria-pressed={Boolean(item.starredAt)} onClick={() => onStar(item.id)}><Star size={15} fill={item.starredAt ? 'currentColor' : 'none'} />{item.starredAt ? t('reader.starred') : t('reader.star')}</button>
          <button onClick={open}><ExternalLink size={15} />{t('reader.original')}</button>
          {aiReady && !deep && (
            <button onClick={() => void goDeep()} disabled={deepBusy}>
              <Sparkles size={15} />{deepBusy ? t('reader.deepBusy') : t('reader.deep')}
            </button>
          )}
          {item.body ? <span className="words">{t('reader.words', { count: item.body.words })}{item.body.words < SHORT_WORDS ? t('reader.short') : ''}</span> : null}
        </div>
      <article>
        <div className="reader-meta">
          <span className="src">{item.sourceName}</span>
          <span className="dot">·</span>
          <time title={item.dateEstimated ? t('common.noDateHint') : undefined}>
            {item.dateEstimated ? t('common.seenAt', { when: dateTime(item.publishedAt) }) : dateTime(item.publishedAt)}
          </time>
          {item.author && <><span className="dot">·</span><span>{item.author}</span></>}
        </div>
        <h1>{item.title}</h1>

        {deepErr && <p className="muted warn">{deepErr}</p>}
        {deep && <DeepView deep={deep} />}

        {item.body
          // Sanitised by the reader core (Miniflux's allow-list sanitiser): no
          // scripts, styles or event handlers survive, and links open outside.
          ? <div className="prose" dangerouslySetInnerHTML={{ __html: item.body.html }} />
          : <Unavailable state={item.bodyState} error={item.bodyError} snippet={item.snippet} onOpen={open} />}
      </article>
    </section>
  );
}

/** The on-demand summary. Every paragraph carries the reference ids it was
 *  written from, and those map to the source list below, so any sentence can be
 *  traced back to the article it came from. */
function DeepView({ deep }: { deep: Deep }) {
  const { t } = useTranslation();
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
          <h4>{t('reader.background')}</h4>
          <ul>
            {deep.milestones.map((m, i) => (
              <li key={i}><time>{m.date}</time><span>{m.text}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="deep-sources">
        <h4>{t('reader.materials')}</h4>
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
  const { t } = useTranslation();
  // Reason codes come from the download layer and the reader core.
  const why = state === 'pending' ? t('reader.fetching')
    : state === 'blocked' || state === 'failed' ? t(`reader.failure.${error ?? 'unknown'}`, { defaultValue: t('reader.unavailable') })
    : t('reader.noBody');
  return (
    <div className="unavailable">
      <p className="why">{why}</p>
      {snippet && <div className="snippet"><span className="eyebrow">{t('reader.snippetLabel')}</span><p>{snippet}</p></div>}
      {state !== 'pending' && <button onClick={onOpen}>{t('reader.openInBrowser')}</button>}
    </div>
  );
}
