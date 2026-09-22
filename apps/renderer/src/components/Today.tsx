import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { HeadlineGroup, ItemRef, OutsidePick, Today as TodayData } from '../types.ts';
import { Blocks } from './Blocks.tsx';
import { Cites } from './Cites.tsx';
import { useTranslation } from 'react-i18next';
import { clock } from '../i18n.ts';

/**
 * The 今日 tab. With AI: 昨天到今天 on top, then the brief, then the day's
 * headlines. Without AI it is still a front page — the headlines of the last
 * day from every subscribed source — rather than a request to set something up.
 * Every AI-written sentence links back to the articles it came from.
 */
export function Today({ aiReady, revision, running, onSetup, onRun, onOpen, onFollow, onAddWatch }: {
  aiReady: boolean; revision: number; running: boolean; onSetup: () => void; onRun: () => void;
  onOpen: (id: string) => void; onFollow: (draft: OutsidePick['suggestion']) => void; onAddWatch: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<TodayData | null>(null);
  const [headlines, setHeadlines] = useState<HeadlineGroup[] | null>(null);

  useEffect(() => {
    let live = true;
    void window.pnr.today().then((d) => { if (live) setData(d); });
    void window.pnr.headlines(24, 4).then((h) => { if (live) setHeadlines(h); });
    return () => { live = false; };
  }, [revision]);

  const refs = useMemo(() => new Map<string, ItemRef>((data?.refs ?? []).map((r) => [r.id, r])), [data]);
  const changes = data?.changes ?? [];
  const digest = data?.digest ?? null;
  const outside = data?.outside ?? [];

  return (
    <section className="page">
      <div className="page-inner today">
        {changes.length > 0 && (
          <section className="panel changes" aria-labelledby="changes-title">
            <h2 id="changes-title" className="section-title">{t('today.changes')}</h2>
            {changes.map((c) => (
              <div key={c.watchId} className="change-group">
                <h3>{c.label}</h3>
                <ul className="timeline-list">
                  {c.milestones.map((m) => (
                    <li key={m.id}><time>{m.occurredOn}</time><p>{m.summary}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} /></p></li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {digest ? (
          <article className="digest">
            <p className="eyebrow">{t('today.generatedAt', { date: data?.date, time: clock(digest.generatedAt) })}</p>
            <h1>{digest.title}</h1>
            <div className="prose"><Blocks blocks={digest.blocks} refs={refs} onOpen={onOpen} /></div>
          </article>
        ) : data && (
          <div className="callout">
            <Sparkles size={16} className="accent" />
            <div>
              <strong>{t(!aiReady ? 'today.noAiTitle' : data.watchCount === 0 ? 'today.noWatchesTitle' : 'today.noDigestTitle')}</strong>
              <p>{t(!aiReady ? 'today.noAiBody' : data.watchCount === 0 ? 'today.noWatchesBody' : 'today.noDigestBody')}</p>
            </div>
            {!aiReady ? <button className="secondary" onClick={onSetup}>{t('common.connectAi')}</button>
              : data.watchCount === 0 ? <button className="primary" onClick={onAddWatch}>{t('watches.add')}</button>
              : <button className="primary" onClick={onRun} disabled={running}>{running ? t('today.generating') : t('today.generate')}</button>}
          </div>
        )}

        {outside.length > 0 && <section className="outside" aria-labelledby="outside-title">
          <h2 id="outside-title" className="section-title">{t('outside.title')}</h2>
          <p className="section-hint">{t('outside.hint')}</p>
          <ul>{outside.map((pick) => <li key={pick.id} className="panel">
            <h3>{pick.title}</h3>
            <p>{pick.reason}<Cites ids={pick.itemIds} refs={refs} onOpen={onOpen} /></p>
            <button className="secondary small" onClick={() => onFollow(pick.suggestion)}>{t('outside.follow')}</button>
          </li>)}</ul>
        </section>}

        <section className="headlines" aria-labelledby="headlines-title">
          <h2 id="headlines-title" className="section-title">{t('today.headlines')}</h2>
          {headlines?.length === 0 && <p className="section-hint">{t('today.noHeadlines')}</p>}
          <div className="headline-grid">
            {headlines?.map((g) => (
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
        </section>
      </div>
    </section>
  );
}
