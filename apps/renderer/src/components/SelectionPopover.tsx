import { Copy, Languages, MessageSquareText } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { TRANSLATE_SELECTION, targetName } from '../translate.ts';

/** Where selecting text offers 翻译: what is read, never inputs or controls. */
const READABLE = '.reader article, .page, .report-scroll, .watch-detail, .assistant-scroll';
const MAX_CHARS = 4_000;
const GAP = 8;

type State = { text: string; rect: DOMRect; phase: 'menu' | 'loading' | 'result' | 'error'; to?: string; result?: string; error?: string };

/** The selection inside a readable area, or null. */
function readSelection(): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text || text.length > MAX_CHARS) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el?.closest(READABLE) || el.closest('input, textarea, [contenteditable], .selection-popover')) return null;
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? { text, rect } : null;
}

/**
 * 划词翻译, as Books offers it: selecting text in an article, a brief or the
 * assistant shows a small bar beside it — 翻译 and 问助手. 翻译 turns the bar
 * into the translation. The reader's context menu can ask for the same
 * (TRANSLATE_SELECTION), so it also works with the automatic bar switched off.
 */
export function SelectionPopover({ offer, aiReady, onAsk }: { offer: boolean; aiReady: boolean; onAsk: (text: string) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const box = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const live = useRef({ offer, aiReady }); live.current = { offer, aiReady };

  const translate = async (text: string): Promise<void> => {
    const n = ++request.current;
    setState((s) => (s ? { ...s, phase: 'loading' } : s));
    const r = await window.pnr.translateText(text).catch(() => ({ ok: false as const, error: 'failed' }));
    if (n !== request.current) return;
    setState((s) => (!s ? s : r?.ok ? { ...s, phase: 'result', to: r.to, result: r.text } : { ...s, phase: 'error', error: r?.error ?? 'failed' }));
  };

  useEffect(() => {
    const show = (): void => {
      if (!live.current.offer || !live.current.aiReady) return;
      const found = readSelection();
      request.current++;
      setState(found ? { ...found, phase: 'menu' } : null);
    };
    // After the mouse is let go (or Shift+arrows end a keyboard selection), not while dragging.
    const up = (e: MouseEvent): void => { if (!(e.target as Element | null)?.closest?.('.selection-popover')) setTimeout(show, 0); };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { request.current++; setState(null); return; }
      if (e.shiftKey && e.key.startsWith('Arrow')) setTimeout(show, 0);
    };
    const down = (e: MouseEvent): void => { if (!(e.target as Element | null)?.closest?.('.selection-popover')) { request.current++; setState(null); } };
    const away = (e: Event): void => {
      if ((e.target as Element | null)?.closest?.('.selection-popover')) return;
      request.current++; setState(null);
    };
    // From a context menu: translate what is selected now, whatever the setting.
    const asked = (): void => {
      if (!live.current.aiReady) return;
      const found = readSelection(); if (!found) return;
      setState({ ...found, phase: 'loading' });
      void translate(found.text);
    };
    document.addEventListener('mouseup', up);
    document.addEventListener('mousedown', down);
    document.addEventListener('keyup', key);
    document.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    window.addEventListener(TRANSLATE_SELECTION, asked);
    return () => {
      document.removeEventListener('mouseup', up);
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keyup', key);
      document.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
      window.removeEventListener(TRANSLATE_SELECTION, asked);
    };
  }, []);

  // Above the selection, or below it when there is no room; always inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!state || !el) { setPlace({ visibility: 'hidden' }); return; }
    const { width, height } = el.getBoundingClientRect();
    const r = state.rect;
    const above = r.top - GAP - height;
    const top = above >= 44 ? above : Math.min(window.innerHeight - height - GAP, r.bottom + GAP);
    const left = Math.max(GAP, Math.min(window.innerWidth - width - GAP, r.left + r.width / 2 - width / 2));
    setPlace({ top: Math.max(GAP, top), left });
  }, [state]);

  if (!state) return null;
  // Buttons do not take focus, so the selection stays as it is.
  const keep = (e: ReactMouseEvent): void => e.preventDefault();
  return (
    <div ref={box} className={`selection-popover ${state.phase}`} style={place} role="dialog" data-floating aria-label={t('translate.selection.label')}>
      {state.phase === 'menu' && <div className="selection-actions">
        <button className="tool labeled" onMouseDown={keep} onClick={() => void translate(state.text)}><Languages size={13} /><span>{t('translate.selection.translate')}</span></button>
        <span className="selection-sep" aria-hidden />
        <button className="tool labeled" onMouseDown={keep} onClick={() => { onAsk(state.text); setState(null); }}><MessageSquareText size={13} /><span>{t('translate.selection.ask')}</span></button>
      </div>}
      {state.phase === 'loading' && <p className="selection-status"><span className="spinner" aria-hidden />{t('translate.selection.translating')}</p>}
      {state.phase === 'error' && <p className="selection-status">{t(`translate.error.${state.error ?? 'failed'}`, { defaultValue: t('translate.error.failed') })}</p>}
      {state.phase === 'result' && <>
        <p className="selection-result" lang={state.to}>{state.result}</p>
        <div className="selection-foot">
          <span>{targetName(state.to ?? '')}</span>
          <span className="grow" />
          <button className="tool" onMouseDown={keep} title={t('menu.copy')} aria-label={t('menu.copy')} onClick={() => void window.pnr.copyText(state.result ?? '')}><Copy size={13} /></button>
          <button className="tool" onMouseDown={keep} title={t('translate.selection.ask')} aria-label={t('translate.selection.ask')} onClick={() => { onAsk(state.text); setState(null); }}><MessageSquareText size={13} /></button>
        </div>
      </>}
    </div>
  );
}
