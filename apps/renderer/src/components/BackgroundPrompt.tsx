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
        let s = await window.pnr.setSchedule(true, 7);
        // Updating while the Mac sleeps comes with it: macOS asks once for the
        // administrator password to install the wake component.
        if (s.enabled && s.wake && !s.wake.installed && s.wake.choice !== 'off')
          s = await window.pnr.setWake(s.wake.choice, t('settings.wake.prompt'));
        // Not switched on after all, or waiting for approval in System Settings: say so here.
        if (!s.enabled || s.status === 'requires-approval' || s.problem) {
          setNote(s.problem ? t(`settings.backgroundProblem.${s.problem}`) : s.enabled ? t('common.loginItemsHint') : t('background.failed'));
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
              <button className="push" disabled={busy} onClick={() => void answer(false)}>{t('background.later')}</button>
              <button className="primary" disabled={busy} onClick={() => void answer(true)}>{t('background.enable')}</button>
            </>}
      </footer>
    </Dialog>
  );
}

/**
 * Asked once of someone whose background updates were already on before the
 * app could wake the Mac: install the wake component now? "以后再说" records
 * the choice as off, so this is not asked again; Settings → 后台更新 changes it.
 */
export function WakePrompt({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const answer = async (enable: boolean): Promise<void> => {
    setBusy(true);
    try {
      const s = await window.pnr.setWake(enable ? 'all' : 'off', t('settings.wake.prompt'));
      if (s.problem) { setNote(t(`settings.backgroundProblem.${s.problem}`)); setBusy(false); return; }
      onDone();
    } catch { setNote(t('background.failed')); setBusy(false); }
  };
  return (
    <Dialog title={t('background.wakeTitle')} onClose={() => void answer(false)} className="background-prompt">
      <header><h2>{t('background.wakeQuestion')}</h2></header>
      <div className="dialog-body">
        <p>{t('background.wakeBody')}</p>
        <p className="section-hint">{t('settings.wake.hint')}</p>
        {note && <p role="status" className="error-text">{note}</p>}
      </div>
      <footer className="dialog-actions">
        {note
          ? <button className="primary" onClick={onDone}>{t('background.ok')}</button>
          : <>
              <button className="push" disabled={busy} onClick={() => void answer(false)}>{t('background.later')}</button>
              <button className="primary" disabled={busy} onClick={() => void answer(true)}>{t('background.enable')}</button>
            </>}
      </footer>
    </Dialog>
  );
}
