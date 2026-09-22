import { useState } from 'react';
import { Dialog } from './Dialog.tsx';
import { useTranslation } from 'react-i18next';

/**
 * First-run consent for the background worker. It is a login item that runs
 * while the window is closed, so it is only installed after an explicit yes;
 * "以后再说" is remembered and the question is not asked again. Settings →
 * 后台更新 turns it on or off at any time.
 */
export function BackgroundPrompt({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const answer = async (enable: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (enable) {
        const s = await window.pnr.setSchedule(true, 7);
        if (s.status === 'requires-approval') {
          setNote(t('common.loginItemsHint'));
          await window.pnr.dismissBackgroundPrompt();
          setBusy(false);
          return;
        }
      }
      await window.pnr.dismissBackgroundPrompt();
      onDone();
    } catch { setNote(t('background.failed')); setBusy(false); }
  };

  return (
    <Dialog title={t('background.title')} onClose={() => void answer(false)} className="background-prompt">
      <header><h2>{t('background.question')}</h2></header>
      <div className="dialog-body">
        <p>{t('background.body')}</p>
        <p className="section-hint">{t('background.where')}</p>
        {note && <p role="status" className="error-text">{note}</p>}
      </div>
      <footer className="dialog-actions">
        {note
          ? <button className="primary" onClick={onDone}>{t('background.ok')}</button>
          : <>
              <button className="secondary" disabled={busy} onClick={() => void answer(false)}>{t('background.later')}</button>
              <button className="primary" disabled={busy} onClick={() => void answer(true)}>{t('background.enable')}</button>
            </>}
      </footer>
    </Dialog>
  );
}
