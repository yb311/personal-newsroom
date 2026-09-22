import { ArrowLeft, BookOpen, CircleDot, ExternalLink, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ItemBody, ItemRow } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { dateTime } from '../i18n.ts';

type Full = ItemRow & { body: ItemBody | null; bodyError: string | null };

/** Below this a body is complete but brief (a results line, a breaking-news
 *  stub); the reader says so rather than looking truncated. */
const SHORT_WORDS = 120;

export function Reader({ id, revision, onStar, onSetRead, onBack }: {
  id: string | null; revision: number; onStar: (id: string) => void;
  onSetRead: (id: string, read: boolean) => Promise<void>; onBack: () => void;
}) {
  const { t } = useTranslation();
  const [item, setItem] = useState<Full | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) { setItem(null); return; }
    let live = true;
    setItem(null); setError(''); setLoading(true);
    void (async () => {
      try {
        const full = await window.pnr.getItem(id);
        if (!live) return;
        setItem(full); setLoading(false);
        // Body not fetched yet: pull it now so opening an article just works.
        if (full && full.bodyState === 'pending') {
          await window.pnr.enrichOne(id);
          const again = await window.pnr.getItem(id);
          if (live) setItem((current) => (again && current ? { ...again, starredAt: current.starredAt, readAt: current.readAt } : again));
        }
      } catch { if (live) { setLoading(false); setError(t('reader.loadFailed')); } }
    })();
    return () => { live = false; };
  }, [id]);

  // Star and read state change from the list too; follow them without reloading the body.
  useEffect(() => {
    if (!id || revision === 0) return;
    let live = true;
    void window.pnr.getItem(id).then((full) => {
      if (live && full) setItem((current) => (current?.id === full.id ? { ...current, starredAt: full.starredAt, readAt: full.readAt } : current));
    }).catch(() => {});
    return () => { live = false; };
  }, [id, revision]);

  const back = <button className="reader-back secondary" onClick={onBack}><ArrowLeft size={15} />{t('reader.back')}</button>;
  if (!id) return <section className="reader empty"><div className="empty-state"><BookOpen size={28} strokeWidth={1.5} /><h3>{t('reader.noneTitle')}</h3><p>{t('reader.noneHint')}</p></div></section>;
  if (loading && !item) return <section className="reader">{back}<p className="empty-state" role="status">{t('common.loading')}</p></section>;
  if (!item) return <section className="reader">{back}<p className="empty-state">{error || t('reader.notFound')}</p></section>;

  const open = (): void => { void window.pnr.openExternal(item.url); };
  const toggleRead = async (): Promise<void> => {
    const read = !item.readAt;
    await onSetRead(item.id, read);
    setItem({ ...item, readAt: read ? Date.now() : null });
  };

  return (
    <section className="reader" key={id}>
      <div className="reader-bar">
        {back}
        <button aria-pressed={Boolean(item.starredAt)} title={item.starredAt ? t('reader.starred') : t('reader.star')} onClick={() => onStar(item.id)}>
          <Star size={14} fill={item.starredAt ? 'currentColor' : 'none'} />{item.starredAt ? t('reader.starred') : t('reader.star')}</button>
        <button title={item.readAt ? t('reader.markUnread') : t('reader.markRead')} onClick={() => void toggleRead()}><CircleDot size={14} />{item.readAt ? t('reader.markUnread') : t('reader.markRead')}</button>
        <button title={t('reader.original')} onClick={open}><ExternalLink size={14} />{t('reader.original')}</button>
        {item.body && <span className="words">{t('reader.words', { count: item.body.words })}{item.body.words < SHORT_WORDS ? t('reader.short') : ''}</span>}
      </div>
      <article>
        <div className="reader-meta">
          <span className="src">{item.sourceName}</span>
          <span aria-hidden>·</span>
          <time title={item.dateEstimated ? t('common.noDateHint') : undefined}>
            {item.dateEstimated ? t('common.seenAt', { when: dateTime(item.publishedAt) }) : dateTime(item.publishedAt)}
          </time>
          {item.author && <><span aria-hidden>·</span><span>{item.author}</span></>}
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
      {state !== 'pending' && <button className="secondary" onClick={onOpen}><ExternalLink size={14} />{t('reader.openInBrowser')}</button>}
    </div>
  );
}
