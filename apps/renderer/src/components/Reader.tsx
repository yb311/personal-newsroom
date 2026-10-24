import { BookOpen, ChevronLeft, ExternalLink, Languages } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { ItemBody, ItemRow, ItemTranslation, MenuEntry } from '../types.ts';
import { useTranslation } from 'react-i18next';
import { dateTime, languageName } from '../i18n.ts';
import { isForeign, preferredMode, targetName, rememberMode, translateSelection, type TranslateMode } from '../translate.ts';

type Full = ItemRow & { body: ItemBody | null; bodyError: string | null; translation?: ItemTranslation };

/** Below this a body is complete but brief (a results line, a breaking-news
 *  stub); the reader says so rather than looking truncated. */
const SHORT_WORDS = 120;
/** Source characters per request while translating a whole article, so it fills in as it goes. */
const CHUNK_CHARS = 2_400;
const PARALLEL = 3;

const empty = (target: string): ItemTranslation => ({ target, title: null, blocks: {}, total: 0 });
/** Newer answers add to what is there: requests in flight may come back in any order. */
const merge = (a: ItemTranslation, b: ItemTranslation): ItemTranslation =>
  ({ target: b.target, title: b.title ?? a.title, blocks: { ...a.blocks, ...b.blocks }, total: b.total || a.total });

export interface ReaderTranslate {
  /** Given by 阅读, whose toolbar has the 翻译 button; elsewhere the reader keeps its own. */
  mode?: TranslateMode;
  onMode?: (mode: TranslateMode) => void;
  target: string;
  aiReady: boolean;
  /** 自动翻译外文文章, for a reader that keeps its own mode. */
  auto?: boolean;
  /** The headline was translated: lists can show it. */
  onTitle: (id: string, title: string) => void;
  /** 问助手 about the selected text. */
  onAsk: (text: string) => void;
}

/** `onBack` is for split views without a toolbar back button: a narrow window shows only this half. */
export function Reader({ id, onLoaded, onBack, translate }: { id: string | null; onLoaded: (item: ItemRow | null) => void; onBack?: () => void; translate: ReaderTranslate }) {
  const { t } = useTranslation();
  const [item, setItem] = useState<Full | null>(null);
  const [loading, setLoading] = useState(false);
  /** The id whose load has finished, found or not. */
  const [settled, setSettled] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [ownMode, setOwnMode] = useState<TranslateMode>('original');
  const mode = translate.mode ?? ownMode;
  const onMode = translate.onMode ?? setOwnMode;
  const { target } = translate;
  const [tr, setTr] = useState<ItemTranslation>(() => empty(target));
  const trRef = useRef(tr); trRef.current = tr;
  /** Paragraphs translated one by one while the article is shown as published. */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [waiting, setWaiting] = useState<Set<number>>(new Set());
  const [work, setWork] = useState<{ running: boolean; done: number; total: number; failed: boolean }>({ running: false, done: 0, total: 0, failed: false });
  const [attempt, setAttempt] = useState(0);
  const prose = useRef<HTMLDivElement>(null);
  /** The article has been shown translated since it was opened. */
  const [touched, setTouched] = useState(false);
  const callbacks = useRef(translate); callbacks.current = translate;

  useEffect(() => {
    onLoaded(null);
    setTr(empty(target)); setPicked(new Set()); setWaiting(new Set()); setWork({ running: false, done: 0, total: 0, failed: false }); setOwnMode('original'); setTouched(false);
    if (!id) { setItem(null); return; }
    let live = true;
    setItem(null); setError(''); setLoading(true);
    void (async () => {
      try {
        const full = await window.pnr.getItem(id);
        if (!live) return;
        setItem(full); setLoading(false); setSettled(id); onLoaded(full);
        if (full?.translation) setTr(full.translation);
        const own = callbacks.current;
        if (full && own.mode === undefined && own.auto && own.aiReady && isForeign(full.lang, own.target)) setOwnMode(preferredMode());
        // Body not fetched yet, or the last try hit a passing refusal (bot
        // protection, timeout…): pull it now so opening an article just works.
        if (full && (full.bodyState === 'pending' || (full.bodyState === 'failed' && RETRYABLE.has(full.bodyError ?? '')))) {
          setItem({ ...full, bodyState: 'pending' });
          await window.pnr.enrichOne(id);
          const again = await window.pnr.getItem(id);
          if (live && again) { setItem(again); if (again.translation) setTr((x) => merge(x, again.translation!)); }
        }
      } catch { if (live) { setLoading(false); setError(t('reader.loadFailed')); } }
    })();
    return () => { live = false; };
  }, [id, target]);

  const html = item?.body?.html ?? null;
  const shown = mode !== 'original';
  useEffect(() => { if (shown) setTouched(true); }, [shown]);

  // 全文翻译: whatever is not translated yet, a few blocks per request, three at a time.
  useEffect(() => {
    if (!id || !item || !shown || !translate.aiReady) return;
    let live = true;
    const blocks = [...(prose.current?.querySelectorAll<HTMLElement>('[data-pnr-b]') ?? [])]
      .map((el) => ({ index: Number(el.dataset['pnrB']), size: el.textContent?.length ?? 0 }));
    const missing = blocks.filter((b) => !trRef.current.blocks[b.index]);
    let needTitle = !trRef.current.title;
    if (!missing.length && !needTitle) return;
    const chunks: number[][] = [];
    let current: number[] = []; let size = 0;
    for (const b of missing) {
      if (current.length && size + b.size > CHUNK_CHARS) { chunks.push(current); current = []; size = 0; }
      current.push(b.index); size += b.size;
    }
    if (current.length || needTitle) chunks.push(current);
    const total = blocks.length;
    let done = total - missing.length; let failed = false;
    setWork({ running: true, done, total, failed: false });
    const worker = async (): Promise<void> => {
      while (live && chunks.length) {
        const chunk = chunks.shift()!;
        const title = needTitle; needTitle = false;
        const r = await window.pnr.translateItem(id, chunk, title).catch(() => ({ ok: false as const, error: 'failed' }));
        if (!live) return;
        if (!r?.ok) { failed = true; if (r?.error === 'no_ai') chunks.length = 0; continue; }
        setTr((x) => merge(x, r.translation));
        if (r.translation.title) callbacks.current.onTitle(id, r.translation.title);
        done += chunk.filter((i) => r.translation.blocks[i]).length;
        failed ||= chunk.some((i) => !r.translation.blocks[i]) || (title && !r.translation.title);
        setWork({ running: true, done, total, failed });
      }
    };
    void Promise.all(Array.from({ length: PARALLEL }, worker)).then(() => { if (live) setWork({ running: false, done, total, failed }); });
    return () => { live = false; };
  }, [id, item?.id, html, shown, translate.aiReady, attempt]);

  // Translations sit inside the blocks they translate (`.pnr-t` after the
  // original's `.pnr-o`), so lists, cells and headings keep their structure.
  // The body is set as HTML and React leaves its children alone while it does
  // not change, so they are placed here, directly.
  useLayoutEffect(() => {
    const root = prose.current; if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-pnr-b]')) {
      const index = Number(el.dataset['pnrB']);
      const text = tr.blocks[index];
      const show = Boolean(text) && (shown || picked.has(index));
      let node = el.querySelector<HTMLElement>(':scope > .pnr-t');
      if (show) {
        if (!node) { node = document.createElement('span'); node.className = 'pnr-t'; el.append(node); }
        node.lang = tr.target;
        if (node.textContent !== text) node.textContent = text!;
      } else node?.remove();
      el.classList.toggle('has-tr', show);
      el.classList.toggle('tr-waiting', waiting.has(index));
    }
  }, [html, tr, shown, picked, waiting]);

  /** 段落翻译: shows (translating if need be) or hides one paragraph's translation. */
  const toggleBlock = async (index: number): Promise<void> => {
    if (!id) return;
    if (picked.has(index)) { setPicked((s) => { const n = new Set(s); n.delete(index); return n; }); return; }
    setPicked((s) => new Set(s).add(index));
    if (trRef.current.blocks[index]) return;
    setWaiting((s) => new Set(s).add(index));
    const r = await window.pnr.translateItem(id, [index], false).catch(() => null);
    setWaiting((s) => { const n = new Set(s); n.delete(index); return n; });
    if (r?.ok) setTr((x) => merge(x, r.translation));
    else setPicked((s) => { const n = new Set(s); n.delete(index); return n; });
  };

  // ⌥-click a paragraph: translate it, or hide its translation again.
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (!e.altKey || shown || !translate.aiReady) return;
    const target = e.target as HTMLElement;
    if (target.closest('a')) return;
    const block = target.closest<HTMLElement>('[data-pnr-b]');
    if (!block) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    void toggleBlock(Number(block.dataset['pnrB']));
  };

  const onContextMenu = async (e: MouseEvent<HTMLElement>): Promise<void> => {
    e.preventDefault();
    const selected = window.getSelection()?.toString().trim() ?? '';
    const block = (e.target as HTMLElement).closest<HTMLElement>('[data-pnr-b]');
    const index = block ? Number(block.dataset['pnrB']) : null;
    const ai = translate.aiReady;
    const entries: MenuEntry[] = [
      ...(selected ? [
        { id: 'selection', label: t('translate.menuSelection', { text: selected.length > 16 ? `${selected.slice(0, 15)}…` : selected }), enabled: ai },
        { id: 'ask', label: t('translate.selection.ask'), enabled: ai },
        { id: 'copy', label: t('menu.copy') },
        { separator: true }
      ] : []),
      ...(index !== null && !shown ? [{ id: 'block', label: picked.has(index) ? t('translate.hideParagraph') : t('translate.paragraph'), enabled: ai }] : []),
      shown ? { id: 'original', label: t('translate.showOriginal') } : { id: 'whole', label: t('translate.whole'), enabled: ai }
    ];
    const choice = await window.pnr.contextMenu(entries);
    if (choice === 'selection') translateSelection();
    else if (choice === 'ask') translate.onAsk(selected);
    else if (choice === 'copy') void window.pnr.copyText(selected);
    else if (choice === 'block' && index !== null) void toggleBlock(index);
    else if (choice === 'whole') onMode(preferredMode());
    else if (choice === 'original') onMode('original');
  };

  if (!id) return <section className="reader empty"><div className="empty-state"><BookOpen size={30} strokeWidth={1.4} /><h3>{t('reader.noneTitle')}</h3><p>{t('reader.noneHint')}</p></div></section>;
  // Until this id's article has come back, it is loading — never 'not found' (the effect that
  // starts the load runs after the first paint, so `loading` is still false for one frame).
  if ((loading || settled !== id) && !error) return <section className="reader empty"><div className="empty-state"><span className="spinner large" role="status" aria-label={t('common.loading')} /></div></section>;
  if (!item) return <section className="reader empty"><div className="empty-state"><p>{error || t('reader.notFound')}</p></div></section>;

  const open = (): void => { void window.pnr.openExternal(item.url); };
  const titleTr = tr.title;
  const setMode = (next: TranslateMode): void => { rememberMode(next); onMode(next); };
  return (
    <section className="reader" key={id}>
      {/* The article's own language ('' when unknown), so type follows the text, not the interface. */}
      <article lang={item.lang ?? ''}>
        {onBack && <button className="push narrow-only detail-back" onClick={onBack}><ChevronLeft size={14} />{t('common.back')}</button>}
        {/* Once translated, the bar stays while the article is open, so 原文 · 双语 · 译文 is one click either way. */}
        {(shown || touched) && <div className="translate-bar" lang="">
          <span className="translate-state" role="status">
            <Languages size={13} aria-hidden />
            {work.running ? <><span className="spinner" aria-hidden />{t('translate.bar.translating', { done: work.done, total: work.total })}</>
              : item.lang ? t('translate.bar.from', { from: languageName(item.lang), lang: targetName(target) }) : t('translate.bar.done', { lang: targetName(target) })}
            {!work.running && work.failed && shown && <span className="translate-failed">
              {t('translate.bar.failed', { count: Math.max(1, work.total - work.done) })}
              <button className="link" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</button></span>}
          </span>
          <div className="segmented" role="group" aria-label={t('translate.display')}>
            {(['original', 'bilingual', 'translation'] as const).map((m) => (
              <button key={m} className={mode === m ? 'active' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`translate.${m}`)}</button>
            ))}
          </div>
        </div>}
        <div className="reader-meta">
          <span className="src">{item.sourceName ?? t('common.newsSearch')}</span>
          <span aria-hidden>·</span>
          <time title={item.dateEstimated ? t('common.noDateHint') : undefined}>
            {item.dateEstimated ? t('common.seenAt', { when: dateTime(item.publishedAt) }) : dateTime(item.publishedAt)}
          </time>
          {/* Feeds list co-authors as "A,B"; set them as a byline. */}
          {item.author && <><span aria-hidden>·</span><span>{item.author.replace(/\s*,\s*/g, ', ')}</span></>}
          {item.body && <><span aria-hidden>·</span><span>{t('reader.words', { count: item.body.words })}{item.body.words < SHORT_WORDS ? t('reader.short') : ''}</span></>}
        </div>
        {shown && mode === 'translation' && titleTr
          ? <h1 lang={tr.target} title={item.title}>{titleTr}</h1>
          : <h1 className={shown && titleTr ? 'has-tr' : ''}>{item.title}{shown && titleTr && <span className="pnr-t" lang={tr.target}>{titleTr}</span>}</h1>}
        {item.body
          // Sanitised by the reader core (Miniflux's allow-list sanitiser): no
          // scripts, styles or event handlers survive, and links open outside.
          ? <div ref={prose} className={`prose ${mode === 'translation' ? 'tr-only' : ''}`} onClick={onClick} onContextMenu={(e) => void onContextMenu(e)}
              dangerouslySetInnerHTML={{ __html: item.body.html }} />
          : <Unavailable state={item.bodyState} error={item.bodyError} snippet={item.snippet} onOpen={open} />}
      </article>
    </section>
  );
}

/** Mirrors TRANSIENT in @pnr/reader: failures worth another try on open. */
const RETRYABLE = new Set(['blocked', 'rate_limited', 'server_error', 'timeout', 'network']);

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
