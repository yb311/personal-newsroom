import { useState } from 'react';
import { Dialog } from './Dialog.tsx';

/**
 * First-run consent for the background worker. It is a login item that runs
 * while the window is closed, so it is only installed after an explicit yes;
 * "以后再说" is remembered and the question is not asked again. Settings →
 * 后台更新 turns it on or off at any time.
 */
export function BackgroundPrompt({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const answer = async (enable: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (enable) {
        const s = await window.pnr.setSchedule(true, 7);
        if (s.status === 'requires-approval') {
          setNote('还差一步：请到「系统设置 → 通用 → 登录项」允许「所闻」在后台运行。');
          await window.pnr.dismissBackgroundPrompt();
          setBusy(false);
          return;
        }
      }
      await window.pnr.dismissBackgroundPrompt();
      onDone();
    } catch { setNote('没能开启，可以稍后在「设置 → 后台更新」里再试。'); setBusy(false); }
  };

  return (
    <Dialog title="后台更新" onClose={() => void answer(false)} className="background-prompt">
      <header><h2>要在后台收新闻吗？</h2></header>
      <p>开启后，所闻会装一个后台任务：关掉窗口它也会每天早上 7:15 整理今日摘要，并每 3 小时检查一次快讯。Mac 休眠时暂停，醒来后补上。</p>
      <p className="muted">它会出现在「系统设置 → 通用 → 登录项」里，随时可以关掉，也可以在「设置 → 后台更新」里关。</p>
      {note && <p role="status" className="muted warn">{note}</p>}
      <div className="dialog-actions">
        {note
          ? <button className="primary" onClick={onDone}>知道了</button>
          : <>
              <button disabled={busy} onClick={() => void answer(false)}>以后再说</button>
              <button className="primary" disabled={busy} onClick={() => void answer(true)}>现在开启</button>
            </>}
      </div>
    </Dialog>
  );
}
