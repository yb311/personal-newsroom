import { AlertTriangle, ArrowUpRight, Check, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantAction, NavTarget, ViewField } from '../types.ts';

/** Fields whose values are codes with a translation; the rest (names, addresses, words) are shown as they are. */
const CODED = new Set(['verdict', 'sensitivity', 'active', 'schedule', 'wake', 'force', 'searchFillEnabled', 'outsidePicksEnabled', 'uiLanguage']);

/**
 * One change the assistant made or wants to make. Everything on it comes from
 * the app (the tool computed it from the database); the model's own words are
 * only the note under the cards. A proposal waits for 确认; a done change that
 * can be put back offers 撤销. The words that must be the person's own (a
 * watch's intent) can be edited here before confirming.
 */
export function ActionCard({ action, busy, onConfirm, onReject, onUndo, onOpen }: {
  action: AssistantAction; busy: boolean;
  onConfirm: (edits: Record<string, string>, dontAsk: boolean) => void;
  onReject: () => void; onUndo: () => void; onOpen: (target: NavTarget) => void;
}) {
  const { t } = useTranslation();
  const view = action.view ?? { fields: [] };
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [dontAsk, setDontAsk] = useState(false);
  const pending = action.status === 'proposed' && !action.expired;
  const danger = action.risk === 'danger';
  const status = action.expired ? 'expired' : action.status;
  const value = (f: ViewField): string => (CODED.has(f.key) ? t(`assistant.value.${f.key}.${f.value}`, { defaultValue: f.value }) : f.value);

  return (
    <section className={`action-card ${status}${danger ? ' danger' : ''}`} aria-label={t(`assistant.tool.${action.tool}`, { defaultValue: action.tool })}>
      <header>
        <strong>{t(`assistant.action.${action.tool}`, { defaultValue: action.tool })}</strong>
        {view.subject && <span className="action-subject">{view.subject}</span>}
        <span className={`action-status ${status}`}>{t(`assistant.status.${status}`)}</span>
      </header>
      {view.fields.length > 0 && <dl>{view.fields.map((f) => (
        <div key={f.key} className={f.warn ? 'warn' : ''}>
          <dt>{t(`assistant.field.${f.key}`, { defaultValue: f.key })}</dt>
          <dd>
            {pending && f.editable
              ? <textarea rows={f.key === 'intent' || f.key === 'note' ? 2 : 1} value={edits[f.key] ?? f.value}
                  aria-label={t(`assistant.field.${f.key}`, { defaultValue: f.key })}
                  onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })} />
              : <>{f.before !== undefined && <><s>{f.before ? value({ ...f, value: f.before }) : t('assistant.empty')}</s> → </>}{f.value ? value(f) : t('assistant.empty')}</>}
            {f.warn && <p className="action-warn"><AlertTriangle size={11} aria-hidden />{t('assistant.warnVerbatim')}</p>}
          </dd>
        </div>
      ))}</dl>}
      {view.reason && <p className="action-reason">{t(`assistant.actionErrors.${view.reason}`, { defaultValue: view.reason })}</p>}
      {action.status === 'failed' && <p className="action-reason">{t(`assistant.actionErrors.${action.error ?? 'failed'}`, { defaultValue: t('assistant.actionErrors.failed') })}</p>}
      {action.status === 'blocked' && <p className="action-reason">{t('assistant.blockedHint')}</p>}
      {pending && <footer>
        <label className="dont-ask"><input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />{t('assistant.dontAsk')}</label>
        <span className="grow" />
        <button className="push" disabled={busy} onClick={onReject}><X size={12} />{t('assistant.reject')}</button>
        <button className={danger ? 'push destructive' : 'primary'} disabled={busy} onClick={() => onConfirm(edits, dontAsk)}><Check size={12} />{t('assistant.confirm')}</button>
      </footer>}
      {!pending && (action.undoable || (view.open && action.status === 'done')) && <footer>
        <span className="grow" />
        {view.open && action.status === 'done' && <button className="link" onClick={() => onOpen(view.open!)}><ArrowUpRight size={12} />{t('assistant.open')}</button>}
        {action.undoable && <button className="link" disabled={busy} onClick={onUndo}><Undo2 size={12} />{t('assistant.undo')}</button>}
      </footer>}
    </section>
  );
}
