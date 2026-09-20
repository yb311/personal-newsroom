import { useEffect, useState } from 'react';
import type { AiStatus, ScheduleState } from '../types.ts';

/** Keys live on this machine only. The app is deliberately usable without one. */
export function Settings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [provider, setProvider] = useState('gemini');
  const [lang, setLang] = useState('zh-CN');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [sched, setSched] = useState<ScheduleState | null>(null);
  const [hour, setHour] = useState(7);

  useEffect(() => {
    void window.pnr.aiStatus().then((s) => {
      setStatus(s); setProvider(s.provider); setLang(s.outputLang);
    });
    void window.pnr.scheduleState().then((s) => { setSched(s); setHour(s.dailyHour); });
  }, []);

  const toggleSchedule = async (on: boolean): Promise<void> => {
    setSched(await window.pnr.setSchedule(on, hour) as ScheduleState);
  };

  const save = async (): Promise<void> => {
    setSaving(true); setMsg('正在验证…');
    const patch: Record<string, string> = { provider, outputLang: lang };
    if (key.trim()) patch['geminiApiKey'] = key.trim();
    const ok = await window.pnr.saveAiSettings(patch);
    setMsg(ok ? '已连接 ✅' : provider === 'ollama' ? '连不上本地 Ollama，确认它在运行' : 'key 验证失败');
    setSaving(false);
    setStatus(await window.pnr.aiStatus());
    onChanged();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <header><h2>设置</h2><span className="grow" /><button onClick={onClose}>完成</button></header>
        <div className="settings">
          <p className="muted">
            所有内容都存在你这台电脑上。API key 也只存在本地，不会发给我们——
            我们没有服务器。<strong>不填 key 也能把它当 RSS 阅读器用。</strong>
          </p>

          <label className="field">
            <span>AI 服务商</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="gemini">Google Gemini（云端）</option>
              <option value="ollama">Ollama（本地，完全不出网）</option>
              <option value="none">先不用 AI</option>
            </select>
          </label>

          {provider === 'gemini' && (
            <label className="field">
              <span>Gemini API Key</span>
              <input type="password" value={key} placeholder={status?.available ? '已保存，留空则不改' : 'AIza…'}
                     onChange={(e) => setKey(e.target.value)} />
              <small className="muted">在 Google AI Studio 免费申请。按目前设计一天大约 10–30 美分。</small>
            </label>
          )}

          {provider === 'ollama' && (
            <p className="muted">
              需要本机已经装好并运行 Ollama。本地模型更慢、质量也弱一些，
              而且正文抓不到时没有补全能力——我们会照实说明，不会假装。
            </p>
          )}

          <label className="field">
            <span>输出语言</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
            </select>
            <small className="muted">摘要和进展用这个语言写。每个关注还能单独设置。原文永远保持原样。</small>
          </label>

          <div className="settings-actions">
            <button className="primary" onClick={() => void save()} disabled={saving}>保存</button>
            {msg && <span className="muted">{msg}</span>}
          </div>

          <hr className="deep-sep" />

          <h3 className="sub">后台运行</h3>
          <p className="muted">
            装一个后台任务，这样你不开这个软件，它也会自己收新闻、生成摘要。
            早上打开就能直接看。<strong>Mac 睡着时不会跑</strong>，醒来后会把错过的那次补上。
          </p>

          <label className="inline-check big">
            <input type="checkbox" checked={Boolean(sched?.enabled)}
                   onChange={(e) => void toggleSchedule(e.target.checked)} />
            让它在后台自己跑
          </label>

          {sched?.enabled && (
            <>
              <label className="field">
                <span>每天什么时候生成摘要</span>
                <select value={hour} onChange={async (e) => {
                  const h = Number(e.target.value); setHour(h);
                  setSched(await window.pnr.setSchedule(true, h) as ScheduleState);
                }}>
                  {[5,6,7,8,9,10].map((h) => <option key={h} value={h}>{h}:15</option>)}
                </select>
                <small className="muted">快讯每 {sched.flashIntervalHours} 小时检查一次。</small>
              </label>

              <div className="run-info">
                {sched.lastRun ? (
                  <p className="muted">
                    上次运行：{new Date(sched.lastRun.at).toLocaleString('zh-CN')} ·
                    {sched.lastRun.kind} · {sched.lastRun.outcome === 'ok' ? '正常' :
                      sched.lastRun.outcome === 'partial' ? '部分完成' : '失败'}
                  </p>
                ) : <p className="muted">还没有跑过。</p>}
                <p className="muted small">
                  它会出现在「系统设置 → 通用 → 登录项」里，你随时可以在那里关掉。
                  {sched.mode === 'launchAgent' && sched.plistPath && (
                    <><br />开发模式下的任务文件：<code>{sched.plistPath}</code></>
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
