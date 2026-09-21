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
export function Today({ aiReady, onSetup, onRun, onOpen, onReport, onFollow, reportLang, running }:
  { aiReady: boolean; onSetup: () => void; onRun: () => void; onOpen: (id: string) => void; onReport: (a: {anchorItemId:string;itemIds:string[];topic:string;lang:string}) => void; onFollow:(draft:OutsidePick['suggestion'])=>void; reportLang: string; running: boolean }) {
  const { t } = useTranslation();
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
            <h2>{t('today.changes')}</h2>
            {changes.map((c) => (
              <div key={c.watchId} className="change-group">
                <h3>{c.label}</h3>
                <ul>
                  {c.milestones.map((m) => (
                    <li key={m.id}><time>{m.occurredOn}</time><span>{m.summary}<Cites ids={m.itemIds} refs={refs} onOpen={onOpen} />
                      {aiReady && m.itemIds[0] && <button className="report-open" onClick={() => onReport({anchorItemId:m.itemIds[0]!,itemIds:m.itemIds,topic:m.summary,lang:reportLang})}><Sparkles size={12}/>{t('report.open')}</button>}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {digest ? (
          <article className="digest">
            <div className="digest-meta">{t('today.generatedAt', { date: data?.date, time: clock(digest.generatedAt) })}</div>
            <h1>{digest.title}</h1>
            {aiReady && data?.refs[0] && <button className="report-open" onClick={() => onReport({anchorItemId:data.refs[0]!.id,itemIds:data.refs.map(r=>r.id),topic:digest.title,lang:reportLang})}><Sparkles size={13}/>{t('report.open')}</button>}
            <div className="prose"><Blocks blocks={digest.blocks} refs={refs} onOpen={onOpen} /></div>
          </article>
        ) : aiReady ? (
          <div className="empty-block">
            <p>{t('today.noDigest')}</p>
            <button className="primary" onClick={onRun} disabled={running}>{running ? t('today.generating') : t('today.generate')}</button>
          </div>
        ) : (
          <p className="muted today-note">
            <Sparkles size={14} /> {t('today.aiHint')}
            <button className="link" onClick={onSetup}>{t('common.goSettings')}</button>
          </p>
        )}

        {(data?.outside?.length ?? 0) > 0 && <section className="outside-picks">
          <h2>{t('outside.title')}</h2><p className="muted">{t('outside.hint')}</p>
          <ul>{data!.outside.map((pick) => <li key={pick.id}><h3>{pick.title}</h3><p>{pick.reason}</p>
            <Cites ids={pick.itemIds} refs={refs} onOpen={onOpen} />
            <div><button onClick={() => onFollow(pick.suggestion)}>{t('outside.follow')}</button>
              {pick.itemIds[0] && <button className="report-open" onClick={() => onReport({anchorItemId:pick.itemIds[0]!,itemIds:pick.itemIds,topic:pick.title,lang:reportLang})}><Sparkles size={12}/>{t('report.open')}</button>}</div>
          </li>)}</ul>
        </section>}
        {data && data.outside.length === 0 && <p className="muted outside-empty">{t('outside.empty')}</p>}

        <div className="headlines">
          <h2>{t('today.headlines')}</h2>
          {headlines.length === 0 && <p className="muted">{t('today.noHeadlines')}</p>}
          {headlines.map((g) => (
            <div key={g.sourceId} className="headline-group">
              <h3>{g.sourceName}</h3>
              <ul>
                {g.items.map((it) => (
                  <li key={it.id}>
                    <button className="headline" onClick={() => onOpen(it.id)}>{it.title}</button>
                    {aiReady && <button className="report-open" title={t('report.open')} onClick={() => onReport({anchorItemId:it.id,itemIds:[it.id],topic:it.title,lang:reportLang})}><Sparkles size={12}/></button>}
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
