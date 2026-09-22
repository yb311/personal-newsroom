import { useRef } from 'react';

/** Reads a remembered pane width, clamped to what the layout allows. */
export function storedWidth(key: string, min: number, max: number, fallback: number): number {
  try { return Math.max(min, Math.min(max, Number(localStorage.getItem(key)) || fallback)); } catch { return fallback; }
}

/**
 * A desktop split view divider: pointer capture keeps dragging reliable across
 * panes; arrow keys give the same adjustment without a mouse, and a double
 * click restores the default. `edge` says which side of the divider the
 * resized pane is on.
 */
export function SplitDivider({ width, onChange, min, max, fallback, storageKey, edge, label }: {
  width: number; onChange: (width: number) => void; min: number; max: number; fallback: number;
  storageKey: string; edge: 'before' | 'after'; label: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const sign = edge === 'before' ? 1 : -1;
  const resize = (value: number): void => {
    const next = Math.round(Math.max(min, Math.min(max, value)));
    onChange(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* Storage may be unavailable. */ }
  };
  return <div className="split-divider" role="separator" aria-label={label}
    aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
    onDoubleClick={() => resize(fallback)}
    onKeyDown={(e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      resize(width + sign * (e.key === 'ArrowRight' ? 10 : -10));
    }}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      start.current = { x: e.clientX, width };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={(e) => { if (start.current) resize(start.current.width + sign * (e.clientX - start.current.x)); }}
    onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); start.current = null; }}
    onLostPointerCapture={() => { start.current = null; }} />;
}
