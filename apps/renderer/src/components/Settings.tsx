import { Dialog } from './Dialog.tsx';
import { langName } from './ItemList.tsx';
import { useEffect, useState } from 'react';
import type { AiConnection, AiStatus, ScheduleState, SocialStatus } from '../types.ts';

const connectionMessage = (c: AiConnection): string => {
  if (c.mode === 'none') return '已切换到阅读模式，不使用 AI';
  if (c.connected) return c.mode === 'ollama' ? '已保存，已连接本机 Ollama' : '已保存，已连接 Gemini';
  switch (c.problem) {
    case 'no_key': return '已保存。还没有填写 API Key，AI 功能暂不可用';
    case 'invalid_key': return '已保存，但这个 API Key 无效，请检查后重试';
    case 'network': return '已保存，但连不上 Google，请检查网络后重试';
    case 'model_missing': return '已连接 Ollama，但缺少所需模型，请先下载模型';
    default: return '已保存，但连不上 Ollama，请确认它已经启动';
  }
};

/** Keys live on this machine only. The app is deliberately usable without one. */
export function Settings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [section, setSection] = useState<'reading' | 'ai' | 'sources' | 'background'>('reading');
  const [langs, setLangs] = useState<{ available: { lang: string | null; count: number }[]; selected: string[] } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [provider, setProvider] = useState('gemini');
  const [lang, setLang] = useState('zh-CN');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [sched, setSched] = useState<ScheduleState | null>(null);
  const [hour, setHour] = useState(7);
  const [social, setSocial] = useState<SocialStatus | null>(null);
  const [instance, setInstance] = useState('');
  const [instanceSaving, setInstanceSaving] = useState(false);
  const [instanceMessage, setInstanceMessage] = useState('');
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    void window.pnr.aiStatus().then((s) => {
      setStatus(s); setProvider(s.provider); setLang(s.outputLang);
    });
    void window.pnr.scheduleState().then((s) => { setSched(s); setHour(s.dailyHour); });
    void window.pnr.readingLanguages().then(setLangs);
    void window.pnr.socialStatus().then((s) => { setSocial(s); setInstance(s.instanceUrl ?? ''); });
    return window.pnr.onSocialProgress((p) => {
      const x = p as { phase: string; received?: number; total?: number };
      setProgress(
        x.phase === 'downloading' && x.total
          ? `下载中 ${Math.round((x.received! / x.total) * 100)}%`
          : x.phase === 'verifying' ? '校验中…'
          : x.phase === 'extracting' ? '解压中…' : ''
      );
    });
  }, []);

  const installPack = async (): Promise<void> => {
    setInstalling(true); setProgress('准备中…');
    try { const r = await window.pnr.socialInstall();
      setProgress(r.ok ? '' : `失败：${r.error ?? '请重试'}`);
      setSocial(await window.pnr.socialStatus());
    } catch { setProgress('失败：下载未完成，请重试'); }
    finally { setInstalling(false); }
  };

  // An empty selection means every language is shown.
  const toggleLang = async (lang: string): Promise<void> => {
    if (!langs) return;
    const known = langs.available.map((a) => a.lang).filter((l): l is string => Boolean(l));
    const current = langs.selected.length ? langs.selected : known;
    let next = current.includes(lang) ? current.filter((l) => l !== lang) : [...current, lang];
    if (next.length === 0 || known.every((l) => next.includes(l))) next = [];
    await window.pnr.setReadingLanguages(next);
    setLangs({ ...langs, selected: next });
    onChanged();
  };
  const showAll = async (): Promise<void> => {
    await window.pnr.setReadingLanguages([]);
    if (langs) setLangs({ ...langs, selected: [] });
    onChanged();
  };

  const toggleSchedule = async (on: boolean): Promise<void> => {
    setSched(await window.pnr.setSchedule(on, hour) as ScheduleState);
  };

  const save = async (): Promise<void> => {
    setSaving(true); setMsg('正在验证…');
    const patch: Record<string, string> = { provider, outputLang: lang };
    if (key.trim()) patch['geminiApiKey'] = key.trim();
    try {
      const result = await window.pnr.saveAiSettings(patch);
      setMsg(connectionMessage(result));
      setStatus(await window.pnr.aiStatus());
      if (result.connected) setKey('');
      onChanged();
    } catch { setMsg('保存失败，请重试。'); }
    finally { setSaving(false); }
  };

  return (
    <Dialog title="设置" onClose={onClose} className="settings-modal">
        <header><h2>设置</h2><span className="grow" /><button onClick={onClose}>完成</button></header>
        <nav className="settings-nav" aria-label="设置分类">{([['reading', '阅读'], ['ai', 'AI 与语言'], ['sources', '扩展订阅'], ['background', '后台更新']] as const).map(([id, label]) => <button key={id} aria-pressed={section === id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>)}</nav>
        <div className="settings">
          <section hidden={section !== 'reading'}><h3 className="sub">阅读语言</h3>
            <p className="muted">选择要在文章列表里显示的语言。语言由正文自动识别；识别不出语言的文章总会显示。</p>
            <div className="lang-picker">
              <label className="inline-check"><input type="checkbox" checked={!langs?.selected.length} onChange={() => void showAll()} />全部语言</label>
              {langs?.available.filter((a) => a.lang).map((a) => (
                <label key={a.lang} className="inline-check">
                  <input type="checkbox" checked={!langs.selected.length || langs.selected.includes(a.lang!)} onChange={() => void toggleLang(a.lang!)} />
                  {a.lang === 'zh' ? '中文' : a.lang === 'en' ? '英文' : langName(a.lang!)}<span className="muted small"> {a.count} 篇</span>
                </label>
              ))}
            </div>
          </section>
          <section hidden={section !== 'ai'}><h3 className="sub">AI 与语言</h3>
          <p className="muted">
            阅读无需 AI。连接后可生成摘要、快讯和进展。密钥保存在本机；使用云端 AI 时，相关内容会发送给所选服务。
          </p>

          <label className="field">
            <span>AI 服务商</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="gemini">Google Gemini（云端）</option>
              <option value="ollama">Ollama（本地模型）</option>
              <option value="none">先不用 AI</option>
            </select>
          </label>

          {provider === 'gemini' && (
            <label className="field">
              <span>Gemini API Key</span>
              <input type="password" value={key} placeholder={status?.available ? '已保存，留空则不改' : 'AIza…'}
                     onChange={(e) => setKey(e.target.value)} />
              <small className="muted">在 Google AI Studio 获取密钥。使用费用由 Google 收取。</small>
            </label>
          )}

          {provider === 'ollama' && (
            <p className="muted">
              请先在这台 Mac 上安装并启动 Ollama。模型在本机运行，不支持搜索补全。
            </p>
          )}

          <label className="field">
            <span>输出语言</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
            </select>
            <small className="muted">用于生成的摘要和进展，不改变原文语言。</small>
          </label>

          <div className="settings-actions">
            <button className="primary" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
            {msg && <span role="status" className="muted">{msg}</span>}
          </div>

          </section><section hidden={section !== 'sources'}>
          <h3 className="sub">扩展订阅</h3>
          <p className="muted">
            通过 RSSHub 订阅更多社交平台。按需下载约 63 MB，安装后占用约 370 MB。
          </p>

          <label className="field">
            <span>RSSHub 服务地址（选填）</span>
            <input placeholder="http://127.0.0.1:1200" value={instance}
                   onChange={(e) => { setInstance(e.target.value); setInstanceMessage(''); }} />
            <small className="muted">
              仅连接你自建或信任的服务，留空则使用本地扩展。输入地址后点击保存。
            </small>
          </label>

          <div className="save-row"><button disabled={instanceSaving} onClick={async () => {
            setInstanceSaving(true); setInstanceMessage('');
            try { await window.pnr.socialSetInstance(instance.trim()); setSocial(await window.pnr.socialStatus()); setInstanceMessage('地址已保存'); }
            catch { setInstanceMessage('保存失败，请检查地址后重试。'); }
            finally { setInstanceSaving(false); }
          }}>{instanceSaving ? '保存中…' : '保存地址'}</button><span role="status" className="muted">{instanceMessage}</span></div>
          {!social?.instanceUrl && (
            <div className="pack-box">
              {social?.pack.installed ? (
                <>
                  <p className="muted ok">
                    已安装 · {Math.round((social.pack.bytes ?? 0) / 1048576)} MB
                    {social.pack.version && <> · {social.pack.version.split('-').pop()}</>}
                  </p>
                  <button onClick={async () => {
                    await window.pnr.socialRemove();
                    setSocial(await window.pnr.socialStatus());
                  }}>移除扩展</button>
                </>
              ) : (
                <>
                  <p className="muted">安装后可启用 RSSHub 订阅，普通订阅无需安装。</p>
                  <button className="primary" onClick={() => void installPack()} disabled={installing}>
                    {installing ? progress : '下载扩展'}
                  </button>
                </>
              )}
              {progress && progress.startsWith('失败') && <p className="muted warn">{progress}</p>}
            </div>
          )}

          </section><section hidden={section !== 'background'}>
          <h3 className="sub">后台更新</h3>
          <p className="muted">
            关闭窗口后继续更新新闻。Mac 休眠时暂停，唤醒后补上。
          </p>

          <label className="inline-check big">
            <input type="checkbox" checked={Boolean(sched?.enabled)}
                   onChange={(e) => void toggleSchedule(e.target.checked)} />
            允许后台更新
          </label>

          {sched?.enabled && (
            <>
              {sched.status === 'requires-approval' && (
                <p className="muted warn">还差一步：请到「系统设置 → 通用 → 登录项」允许「所闻」后台运行。</p>
              )}
              <label className="field">
                <span>每日摘要时间</span>
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
                ) : <p className="muted">尚未运行。</p>}
                <p className="muted small">
                  它会出现在「系统设置 → 通用 → 登录项」里，你随时可以在那里关掉。
                  {sched.mode === 'launchAgent' && sched.plistPath && (
                    <><br />开发模式下的任务文件：<code>{sched.plistPath}</code></>
                  )}
                </p>
              </div>
            </>
          )}
          </section>
        </div>
    </Dialog>
  );
}
