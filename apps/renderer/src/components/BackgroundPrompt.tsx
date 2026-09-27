import { useState } from 'react';
import { Dialog } from './Dialog.tsx';
import { useTranslation } from 'react-i18next';

/**
 * First-run consent for background updates. They run while the window is
 * closed, so they are only registered after an explicit yes; "以后再说" is
 * remembered and the question is not asked again. Settings → 后台更新 turns
 * them on or off at any time.
 *
 * Waking the Mac comes with it, and macOS asks the person to approve that in
 * System Settings; when it is still waiting, this says so and offers the way
 * there.
 */
export function BackgroundPrompt({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [approve, setApprove] = useState(false);

  const answer = async (enable: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (enable) {
        const s = await window.pnr.setSchedule(true, 7);
        const waiting = s.status === 'requires-approval' || s.wake?.status === 'requires-approval';
        if (!s.enabled || s.problem || waiting) {
          setNote(s.problem ? t(`settings.backgroundProblem.${s.problem}`) : s.enabled ? t('background.approve') : t('background.failed'));
          setApprove(waiting);
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
          ? <>
              {approve && <button className="push" onClick={() => void window.pnr.openLoginItems()}>{t('settings.openLoginItems')}</button>}
              <button className="primary" onClick={onDone}>{t('background.ok')}</button>
            </>
          : <>
              <button className="push" disabled={busy} onClick={() => void answer(false)}>{t('background.later')}</button>
              <button className="primary" disabled={busy} onClick={() => void answer(true)}>{t('background.enable')}</button>
            </>}
      </footer>
    </Dialog>
  );
}
