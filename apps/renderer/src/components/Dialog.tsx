import { useEffect, useRef, type ReactNode } from 'react';

/** Native modal semantics include focus containment, Escape, and focus restoration. */
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
    onCancel={(e) => { e.preventDefault(); onClose(); }}
    onClick={(e) => { if (e.target === e.currentTarget) {
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
    } }}>
    {children}
  </dialog>;
}
