import { ChevronLeft } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The list half of a split view, as in Mail: rows in sections, one selected,
 * arrow keys move the selection. 今日, 快讯 and 阅读 all use it, so every
 * surface reads the same way — pick on the left, read on the right.
 */
export function ListPane({ label, ids, selected, onSelect, children }: {
  label: string; ids: string[]; selected: string | null; onSelect: (id: string) => void; children: ReactNode;
}) {
  const pane = useRef<HTMLElement>(null);
  useEffect(() => { pane.current?.querySelector('.row-item.selected')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  return (
    <section ref={pane} className="list" role="listbox" aria-label={label} tabIndex={0} onKeyDown={(e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const index = selected === null ? -1 : ids.indexOf(selected);
      const next = ids[index < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next !== undefined) onSelect(next);
    }}>
      {children}
    </section>
  );
}

/** One row. Clicking focuses the list, so the selection takes the accent. */
export function Row({ selected, className = '', onSelect, onMenu, children }: {
  selected: boolean; className?: string | undefined; onSelect: () => void; onMenu?: (() => void) | undefined; children: ReactNode;
}) {
  return (
    <article className={`row-item ${selected ? 'selected' : ''} ${className}`} role="option" aria-selected={selected}
      onMouseDown={(e) => e.currentTarget.closest<HTMLElement>('.list')?.focus({ preventScroll: true })}
      onClick={onSelect}
      onContextMenu={onMenu && ((e) => { e.preventDefault(); onSelect(); onMenu(); })}>
      {children}
    </article>
  );
}

/** The reading half. In a narrow window only one half shows, so it carries its own way back. */
export function Detail({ onBack, lang, children }: { onBack: () => void; lang?: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="reader">
      <article lang={lang}>
        <button className="push narrow-only detail-back" onClick={onBack}><ChevronLeft size={14} />{t('common.back')}</button>
        {children}
      </article>
    </section>
  );
}
