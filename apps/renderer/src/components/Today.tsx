import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { HeadlineGroup, ItemRef, OutsidePick, Today as TodayData } from '../types.ts';
import type { OpenReport } from '../App.tsx';
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
export function Today({ aiReady, revision, running, onSetup, onRun, onOpen, onReport, onFollow, onAddWatch }: {
  aiReady: boolean; revision: number; running: boolean; onSetup: () => void; onRun: () => void;
  onOpen: (id: string) => void; onReport: OpenReport; onFollow: (draft: OutsidePick['suggestion']) => void; onAddWatch: () => void;
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
  /** Right-click on a headline or a development: read it, or dig into it. */
  const menu = async (e: MouseEvent, itemIds: string[], topic: string, url?: string): Promise<void> => {
    e.preventDefault();
    if (!itemIds[0]) return;
    const choice = await window.pnr.contextMenu([
      { id: 'read', label: t('menu.openInReader') },
      ...(url ? [{ id: 'original', label: t('menu.openOriginal') }] : []),
      { separator: true }, { id: 'report', label: t('report.open'), enabled: aiReady }
    ]);
    if (choice === 'read') onOpen(itemIds[0]);
    else if (choice === 'original' && url) void window.pnr.openExternal(url);
    else if (choice === 'report') onReport({ anchorItemId: itemIds[0], itemIds, topic });
  };

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
                    <li key={m.id} onContextMenu={(e) => void menu(e, m.itemIds, m.summary)}><time>{m.occurredOn}</time><p>{m.summary}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} /></p></li>
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
          <div className="banner">
            <Sparkles size={15} className="banner-icon" />
            <div>
              <strong>{t(!aiReady ? 'today.noAiTitle' : data.watchCount === 0 ? 'today.noWatchesTitle' : 'today.noDigestTitle')}</strong>
              <p>{t(!aiReady ? 'today.noAiBody' : data.watchCount === 0 ? 'today.noWatchesBody' : 'today.noDigestBody')}</p>
            </div>
            {!aiReady ? <button className="push" onClick={onSetup}>{t('common.connectAi')}</button>
              : data.watchCount === 0 ? <button className="push" onClick={onAddWatch}>{t('watches.add')}</button>
              : <button className="push" onClick={onRun} disabled={running}>{running ? t('today.generating') : t('today.generate')}</button>}
          </div>
        )}

        {outside.length > 0 && <section className="outside" aria-labelledby="outside-title">
          <h2 id="outside-title" className="section-title">{t('outside.title')}</h2>
          <p className="section-hint">{t('outside.hint')}</p>
          <ul>{outside.map((pick) => <li key={pick.id} className="panel">
            <h3>{pick.title}</h3>
            <p>{pick.reason}<Cites ids={pick.itemIds} refs={refs} onOpen={onOpen} /></p>
            <div className="inline">
              <button className="push small" onClick={() => onFollow(pick.suggestion)}>{t('outside.follow')}</button>
              {aiReady && pick.itemIds[0] && <button className="push small" onClick={() => onReport({ anchorItemId: pick.itemIds[0]!, itemIds: pick.itemIds, topic: pick.title })}>{t('report.open')}</button>}
            </div>
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
                    <li key={it.id} onContextMenu={(e) => void menu(e, [it.id], it.title, it.url)}>
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
