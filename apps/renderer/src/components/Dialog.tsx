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
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title}
    onCancel={(e) => { e.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
