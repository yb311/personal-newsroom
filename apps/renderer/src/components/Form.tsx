import { ChevronDown } from 'lucide-react';
import type { ReactNode, SelectHTMLAttributes } from 'react';

/** A grouped box of rows, as in System Settings. */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return <section className="group">
    {title && <h3 className="group-title">{title}</h3>}
    <div className="group-box">{children}</div>
    {footer && <p className="group-footer">{footer}</p>}
  </section>;
}
/** Label and hint on the left, the control on the right; `wide` puts the control underneath.
 *  With `htmlFor` the label text is a real label, so clicking it works the control. */
export function Row({ label, hint, children, wide, htmlFor }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; wide?: boolean; htmlFor?: string }) {
  return <div className={`row ${wide ? 'wide' : ''}`}>
    <div className="row-label">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}{hint && <small>{hint}</small>}</div>
    {children && <div className="row-control">{children}</div>}
  </div>;
}
export const Switch = ({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; id?: string }) =>
  <input type="checkbox" role="switch" className="switch" id={id} aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;

/** A native select with a consistent macOS-style bezel and disclosure arrow. */
export function Select({ className, disabled, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className={`select-control${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}>
    <select {...props} disabled={disabled}>{children}</select>
    <ChevronDown className="select-chevron" size={13} strokeWidth={2.25} aria-hidden="true" />
  </span>;
}
