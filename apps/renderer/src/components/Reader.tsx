import { BookOpen, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ItemBody, ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { dateTime } from '../i18n.ts';

type Full = ItemRow & { body: ItemBody | null; bodyError: string | null };

/** Below this a body is complete but brief (a results line, a breaking-news
 *  stub); the reader says so rather than looking truncated. */
const SHORT_WORDS = 120;

export function Reader({ id, onLoaded }: { id: string | null; onLoaded: (item: ItemRow | null) => void }) {
  const { t } = useTranslation();
  const [item, setItem] = useState<Full | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    onLoaded(null);
    if (!id) { setItem(null); return; }
    let live = true;
    setItem(null); setError(''); setLoading(true);
    void (async () => {
      try {
        const full = await window.pnr.getItem(id);
        if (!live) return;
        setItem(full); setLoading(false); onLoaded(full);
        // Body not fetched yet: pull it now so opening an article just works.
        if (full && full.bodyState === 'pending') {
          await window.pnr.enrichOne(id);
          const again = await window.pnr.getItem(id);
          if (live && again) setItem(again);
        }
      } catch { if (live) { setLoading(false); setError(t('reader.loadFailed')); } }
    })();
    return () => { live = false; };
  }, [id]);

  if (!id) return <section className="reader empty"><div className="empty-state"><BookOpen size={30} strokeWidth={1.4} /><h3>{t('reader.noneTitle')}</h3><p>{t('reader.noneHint')}</p></div></section>;
  if (loading && !item) return <section className="reader empty"><div className="empty-state"><span className="spinner large" role="status" aria-label={t('common.loading')} /></div></section>;
  if (!item) return <section className="reader empty"><div className="empty-state"><p>{error || t('reader.notFound')}</p></div></section>;

  const open = (): void => { void window.pnr.openExternal(item.url); };
  return (
    <section className="reader" key={id}>
      <article>
        <div className="reader-meta">
          <span className="src">{item.sourceName}</span>
          <span aria-hidden>·</span>
          <time title={item.dateEstimated ? t('common.noDateHint') : undefined}>
            {item.dateEstimated ? t('common.seenAt', { when: dateTime(item.publishedAt) }) : dateTime(item.publishedAt)}
          </time>
          {item.author && <><span aria-hidden>·</span><span>{item.author}</span></>}
          {item.body && <><span aria-hidden>·</span><span>{t('reader.words', { count: item.body.words })}{item.body.words < SHORT_WORDS ? t('reader.short') : ''}</span></>}
        </div>
        <h1>{item.title}</h1>
        {item.body
          // Sanitised by the reader core (Miniflux's allow-list sanitiser): no
          // scripts, styles or event handlers survive, and links open outside.
          ? <div className="prose" dangerouslySetInnerHTML={{ __html: item.body.html }} />
          : <Unavailable state={item.bodyState} error={item.bodyError} snippet={item.snippet} onOpen={open} />}
      </article>
    </section>
  );
}

/** Honesty rule: when the body cannot be fetched, say so and offer the browser.
 *  Never dress a feed snippet up as the article. */
function Unavailable({ state, error, snippet, onOpen }: { state: string; error: string | null; snippet: string | null; onOpen: () => void }) {
  const { t } = useTranslation();
  // Reason codes come from the download layer and the reader core.
  const why = state === 'pending' ? t('reader.fetching')
    : state === 'blocked' || state === 'failed' ? t(`reader.failure.${error ?? 'unknown'}`, { defaultValue: t('reader.unavailable') })
    : t('reader.noBody');
  return (
    <div className="unavailable">
      <p className="why">{why}</p>
      {snippet && <div className="snippet"><span className="eyebrow">{t('reader.snippetLabel')}</span><p>{snippet}</p></div>}
      {state !== 'pending' && <button className="push" onClick={onOpen}><ExternalLink size={14} />{t('reader.openInBrowser')}</button>}
    </div>
  );
}
