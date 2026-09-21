import { useRef } from 'react';

/** A desktop split view divider: pointer capture keeps dragging reliable across
 * panes; arrow keys provide the same adjustment without a mouse. */
export function SplitDivider({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number): void => {
    const next = Math.max(250, Math.min(440, value));
    onChange(next);
    try { localStorage.setItem('pnr.listWidth', String(next)); } catch { /* Storage may be unavailable. */ }
  };
  return <div className="split-divider" role="separator" aria-label="调整文章列表宽度"
    aria-orientation="vertical" aria-valuemin={250} aria-valuemax={440} aria-valuenow={width} tabIndex={0}
    onDoubleClick={() => resize(310)}
    onKeyDown={e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      resize(width + (e.key === 'ArrowRight' ? 10 : -10));
    }}
    onPointerDown={e => {
      if (e.button !== 0) return;
      start.current = { x: e.clientX, width: e.currentTarget.previousElementSibling!.getBoundingClientRect().width };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => { if (start.current) resize(start.current.width + e.clientX - start.current.x); }}
    onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); start.current = null; }}
    onLostPointerCapture={() => { start.current = null; }} />;
}
