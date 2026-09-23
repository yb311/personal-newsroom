import { useEffect, useRef, type ReactNode } from 'react';

/** A sheet: focus containment, Escape to dismiss, focus restored after. Like a
 *  macOS sheet it does not close on a click outside, so typed input is never lost. */
export function Dialog({ title, onClose, children, className = '' }: {
  title: string; onClose: () => void; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  // Escape is handled here as well as through `cancel`: Chromium may close a
  // dialog without firing `cancel`, which would leave it shut while React still shows it.
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title}
    onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose(); } }}
    onCancel={(e) => { e.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
