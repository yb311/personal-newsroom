import type { ReactNode } from 'react';

/** A grouped box of rows, as in System Settings. */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return <section className="group">
    {title && <h3 className="group-title">{title}</h3>}
    <div className="group-box">{children}</div>
    {footer && <p className="group-footer">{footer}</p>}
  </section>;
}
/** Label and hint on the left, the control on the right; `wide` puts the control underneath. */
export function Row({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; wide?: boolean }) {
  return <div className={`row ${wide ? 'wide' : ''}`}>
    <div className="row-label"><span>{label}</span>{hint && <small>{hint}</small>}</div>
    {children && <div className="row-control">{children}</div>}
  </div>;
}
export const Switch = ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) =>
  <input type="checkbox" role="switch" className="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;

