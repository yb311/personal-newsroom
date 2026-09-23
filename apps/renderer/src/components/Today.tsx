import { ChevronLeft, ChevronRight, Newspaper } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Edition, ItemRef, ItemRow, OutsidePick, Today as TodayData } from '../types.ts';
import type { OpenReport } from '../App.tsx';
import { Blocks } from './Blocks.tsx';
import { Cited, numberSources, Refs, SourceList } from './Cites.tsx';
import { Detail, ListPane, Row } from './ListPane.tsx';
import { Reader } from './Reader.tsx';
import { useTranslation } from 'react-i18next';
import { ago, clock, dateTime, scriptLang } from '../i18n.ts';

type Entry =
  | { kind: 'today' }
  | { kind: 'edition'; edition: Edition }
  | { kind: 'outside'; pick: OutsidePick }
  | { kind: 'headline'; item: ItemRow };

/** A calendar day ('2026-09-22') in the interface language. */
const day = (iso: string, opts: Intl.DateTimeFormatOptions): string => dateTime(Date.parse(`${iso}T00:00:00`), opts);
const LONG_DAY: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', weekday: 'long' };

/**
 * 今日 — the daily edition: what to know today, written once a day.
 *
 * The list holds today's edition, what lies outside every watch, and earlier
 * editions. What changed since yesterday is not a list of its own: the brief is
 * written around it, and each section leads to its watch's timeline, where the
 * same developments are marked new. 快讯 is the running wire; this is the paper.
 *
 * Without a brief (no AI yet, or not written today) the list carries the last
 * day's headlines instead, so 今日 is still a front page, never a blank.
 */
export function Today({ aiReady, revision, writing, busy, divider, onSetup, onWrite, onOpen, onRead, onReport, onFollow, onAddWatch, onOpenWatch }: {
  aiReady: boolean; revision: number; writing: boolean; busy: boolean; divider: ReactNode; onSetup: () => void; onWrite: () => void;
  onOpen: (id: string) => void; onRead: (id: string) => void; onReport: OpenReport;
  onFollow: (draft: OutsidePick['suggestion']) => void; onAddWatch: () => void; onOpenWatch: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<TodayData | null>(null);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [headlines, setHeadlines] = useState<ItemRow[]>([]);
  const [selected, setSelected] = useState('today');
  /** Narrow windows show one half at a time; the detail only after an explicit pick. */
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [d, e] = await Promise.all([window.pnr.today(), window.pnr.editions()]);
      // Headlines stand in for the brief; with a brief they would only repeat 阅读.
      const h = d.digest ? [] : (await window.pnr.headlines(24, 3)).flatMap((g) => g.items).sort((a, b) => b.publishedAt - a.publishedAt);
      if (live) { setData(d); setEditions(e); setHeadlines(h); }
    })();
    return () => { live = false; };
  }, [revision]);

  const entries = useMemo(() => {
    const list = new Map<string, Entry>([['today', { kind: 'today' }]]);
    for (const pick of data?.outside ?? []) list.set(`o:${pick.id}`, { kind: 'outside', pick });
    for (const item of headlines) list.set(`h:${item.id}`, { kind: 'headline', item });
    for (const edition of editions) list.set(`e:${edition.date}`, { kind: 'edition', edition });
    return list;
  }, [data, headlines, editions]);
  const refs = useMemo(() => new Map<string, ItemRef>((data?.refs ?? []).map((r) => [r.id, r])), [data]);

  if (!data) return <section className="page" />;
  // After an update the picked row may be gone; fall back to today's edition.
  const active = entries.has(selected) ? selected : 'today';
  const current = entries.get(active)!;
  const pick = (id: string): void => {
    setSelected(id); setPicked(true);
    const e = entries.get(id);
    if (e?.kind === 'headline') onRead(e.item.id);
  };
  /** Right-click on a row: read it, open it, or dig into it. */
  const menu = async (itemIds: string[], topic: string, url?: string): Promise<void> => {
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

  const { digest, outside } = data;
  const lead = digest?.blocks.find((b) => b.type === 'paragraph');
  const missing = !aiReady ? 'noAi' : data.watchCount === 0 ? 'noWatches' : 'noDigest';
  const row = (id: string, children: ReactNode, opts: { className?: string; onMenu?: () => void } = {}): ReactNode =>
    <Row key={id} selected={active === id} className={opts.className} onSelect={() => pick(id)} onMenu={opts.onMenu}>{children}</Row>;
  const back = (): void => setPicked(false);

  return (
    <div className={`split-view ${picked ? 'has-selection' : ''}`}>
      <ListPane label={t('tabs.today')} ids={[...entries.keys()]} selected={active} onSelect={pick}>
        {row('today', <>
          <div className="row-head"><span className="src">{t('today.brief')}</span>{digest && <time>{clock(digest.generatedAt)}</time>}</div>
          <h3>{digest ? digest.title : t(`today.${missing}Title`)}</h3>
          {lead?.type === 'paragraph' && <p>{lead.text}</p>}
        </>)}

        {outside.length > 0 && <h2 className="list-section">{t('outside.title')}</h2>}
        {outside.map((p) => row(`o:${p.id}`, <>
          <h3>{p.title}</h3>
          <p>{p.reason}</p>
        </>, { onMenu: () => void menu(p.itemIds, p.title) }))}

        {headlines.length > 0 && <h2 className="list-section">{t('today.headlines')}</h2>}
        {headlines.map((it) => row(`h:${it.id}`, <>
          <div className="row-head"><span className="src">{it.sourceName ?? t('common.newsSearch')}</span><time>{ago(it.publishedAt)}</time></div>
          <h3>{it.title}</h3>
        </>, { className: it.readAt ? 'read' : 'unread', onMenu: () => void menu([it.id], it.title, it.url) }))}

        {editions.length > 0 && <h2 className="list-section">{t('today.editions')}</h2>}
        {editions.map((e) => row(`e:${e.date}`, <>
          <div className="row-head"><span className="src">{day(e.date, { month: 'long', day: 'numeric', weekday: 'short' })}</span></div>
          <h3>{e.title}</h3>
        </>))}
      </ListPane>
      {divider}

      {current.kind === 'headline' ? <Reader key={active} id={current.item.id} onLoaded={() => {}} onBack={back} />
      : current.kind === 'outside' ? <Outside key={active} pick={current.pick} refs={refs} aiReady={aiReady}
          onOpen={onOpen} onReport={onReport} onFollow={onFollow} onBack={back} />
      : current.kind === 'edition' ? <PastEdition key={active} date={current.edition.date} onOpen={onOpen} onOpenWatch={onOpenWatch} onBack={back} />
      : digest ? <Brief key={digest.id} edition={data} refs={refs} onOpen={onOpen} onOpenWatch={onOpenWatch} onBack={back}
          rewrite={aiReady && data.watchCount > 0 ? { busy, writing, onWrite } : undefined} />
      : <section className="reader empty"><div className="empty-state">
          <button className="push narrow-only detail-back" onClick={back}><ChevronLeft size={14} />{t('common.back')}</button>
          <Newspaper size={30} strokeWidth={1.4} />
          <h3>{t(`today.${missing}Title`)}</h3>
          <p>{t(`today.${missing}Body`)}</p>
          {missing === 'noAi' ? <button className="push" onClick={onSetup}>{t('common.connectAi')}</button>
            : missing === 'noWatches' ? <button className="push" onClick={onAddWatch}>{t('watches.add')}</button>
            : <button className="push" onClick={onWrite} disabled={busy}>{writing ? t('today.writing') : t('today.write')}</button>}
        </div></section>}
    </div>
  );
}

/**
 * The brief as one document: clean paragraphs with numbered marks, sources at
 * the end. Each section is headed by the watch it is about, which opens that
 * watch's timeline; today's edition can be written again from its header.
 */
function Brief({ edition, refs, onOpen, onOpenWatch, onBack, rewrite }: {
  edition: TodayData; refs: Map<string, ItemRef>; onOpen: (id: string) => void; onOpenWatch: (id: string) => void; onBack: () => void;
  rewrite?: { busy: boolean; writing: boolean; onWrite: () => void } | undefined;
}) {
  const { t } = useTranslation();
  const digest = edition.digest!;
  const numbers = useMemo(() => numberSources(digest.blocks.map((b) => (b.type === 'paragraph' ? b.sourceRefIds : undefined)), refs), [digest, refs]);
  const watches = useMemo(() => new Map(edition.watches.map((w) => [w.id, w])), [edition]);
  const lead = digest.blocks.find((b) => b.type === 'paragraph');
  return (
    <Detail onBack={onBack} lang={scriptLang(digest.title + (lead?.type === 'paragraph' ? lead.text : ''))}>
      <div className="doc-head">
        <div className="reader-meta">
          <span className="src">{t('today.brief')}</span><span aria-hidden>·</span>
          <span>{t('today.generatedAt', { date: day(edition.date, LONG_DAY), time: clock(digest.generatedAt) })}</span>
        </div>
        {rewrite && <button className="push small" disabled={rewrite.busy} onClick={rewrite.onWrite}>
          {rewrite.writing ? <><span className="spinner" aria-hidden />{t('today.writing')}</> : t('today.rewrite')}</button>}
      </div>
      <h1>{digest.title}</h1>
      <div className="prose"><Blocks blocks={digest.blocks} refs={refs} numbers={numbers} onOpen={onOpen} kicker={(watchId) => {
        const w = watches.get(watchId);
        // Only today's edition knows what is new; an old edition just names its watch.
        return w && <button className="kicker" title={t('today.openWatch')} onClick={() => onOpenWatch(w.id)}>
          {w.label}{rewrite && w.newCount > 0 ? <span>{t('today.newDevelopments', { count: w.newCount })}</span> : null}<ChevronRight size={12} strokeWidth={2.25} aria-hidden />
        </button>;
      }} /></div>
      <SourceList numbers={numbers} refs={refs} onOpen={onOpen} />
    </Detail>
  );
}

/** An earlier edition, loaded when picked. */
function PastEdition({ date, onOpen, onOpenWatch, onBack }: { date: string; onOpen: (id: string) => void; onOpenWatch: (id: string) => void; onBack: () => void }) {
  const [edition, setEdition] = useState<TodayData | null>(null);
  useEffect(() => {
    let live = true;
    void window.pnr.today(date).then((d) => { if (live) setEdition(d); });
    return () => { live = false; };
  }, [date]);
  const refs = useMemo(() => new Map<string, ItemRef>((edition?.refs ?? []).map((r) => [r.id, r])), [edition]);
  if (!edition?.digest) return <section className="reader empty"><div className="empty-state"><span className="spinner large" aria-hidden /></div></section>;
  return <Brief edition={edition} refs={refs} onOpen={onOpen} onOpenWatch={onOpenWatch} onBack={onBack} />;
}

/** Something outside every watch that may deserve one. */
function Outside({ pick, refs, aiReady, onOpen, onReport, onFollow, onBack }: {
  pick: OutsidePick; refs: Map<string, ItemRef>; aiReady: boolean; onOpen: (id: string) => void;
  onReport: OpenReport; onFollow: (draft: OutsidePick['suggestion']) => void; onBack: () => void;
}) {
  const { t } = useTranslation();
  const numbers = useMemo(() => numberSources([pick.itemIds], refs), [pick, refs]);
  const first = pick.itemIds[0];
  return (
    <Detail onBack={onBack} lang={pick.lang}>
      <div className="reader-meta"><span className="src">{t('outside.title')}</span></div>
      <h1 className="statement">{pick.title}</h1>
      <div className="prose"><p><Cited text={pick.reason}><Refs ids={pick.itemIds} refs={refs} numbers={numbers} onOpen={onOpen} /></Cited></p></div>
      <div className="doc-actions">
        <button className="push" onClick={() => onFollow(pick.suggestion)}>{t('outside.follow')}</button>
        {first && <button className="push" disabled={!aiReady} onClick={() => onReport({ anchorItemId: first, itemIds: pick.itemIds, topic: pick.title })}>{t('report.open')}</button>}
      </div>
      <SourceList numbers={numbers} refs={refs} onOpen={onOpen} />
    </Detail>
  );
}
