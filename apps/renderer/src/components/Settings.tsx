import { Dialog } from './Dialog.tsx';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, dateTime, languageName } from '../i18n.ts';
import type { AiConnection, AiStatus, ScheduleState, SocialStatus } from '../types.ts';

type UiChoice = 'system' | 'zh-CN' | 'en';

/** Which message the settings screen shows after saving AI settings. */
const connectionKey = (c: AiConnection): string =>
  c.mode === 'none' ? 'none'
    : c.connected ? 'connected'
    : c.problem ? c.problem
    : 'ollama_down';

/** Keys live on this machine only. The app is deliberately usable without one. */
export function Settings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<'general' | 'ai' | 'sources' | 'background'>('general');
  const [uiChoice, setUiChoice] = useState<UiChoice>('system');
  const [langs, setLangs] = useState<{ available: { lang: string | null; count: number }[]; selected: string[] } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [provider, setProvider] = useState('gemini');
  const [lang, setLang] = useState('zh-CN');
  const [endpoint, setEndpoint] = useState('');
  const [writeModel, setWriteModel] = useState('');
  const [fastModel, setFastModel] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [contextTokens, setContextTokens] = useState('');
  const [ollamaHost, setOllamaHost] = useState('http://127.0.0.1:11434');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [sched, setSched] = useState<ScheduleState | null>(null);
  const [hour, setHour] = useState(7);
  const [social, setSocial] = useState<SocialStatus | null>(null);
  const [instance, setInstance] = useState('');
  const [instanceSaving, setInstanceSaving] = useState(false);
  const [instanceMessage, setInstanceMessage] = useState('');
  const [progress, setProgress] = useState<string>('');
  const [apify, setApify] = useState('');
  const [hasApify, setHasApify] = useState(false);
  const [apifyMessage, setApifyMessage] = useState('');

  useEffect(() => {
    void window.pnr.aiStatus().then((s) => {
      setStatus(s); setProvider(s.provider); setLang(s.outputLang);
      setEndpoint(s.compatibleEndpoint); setWriteModel(s.writeModel); setFastModel(s.fastModel);
      setEmbedModel(s.embedModel); setContextTokens(s.contextTokens); setOllamaHost(s.ollamaHost);
    });
    void window.pnr.scheduleState().then((s) => { setSched(s); setHour(s.dailyHour); });
    void window.pnr.readingLanguages().then(setLangs);
    void window.pnr.uiLanguage().then((u) => setUiChoice(u.choice));
    void window.pnr.hasApifyToken().then(setHasApify);
    void window.pnr.socialStatus().then((s) => { setSocial(s); setInstance(s.instanceUrl ?? ''); });
  }, []);
  // Separate from loading, so switching the interface language does not reload the form.
  useEffect(() => {
    return window.pnr.onSocialProgress((p) => {
      const x = p as { phase: string; received?: number; total?: number };
      setProgress(
        x.phase === 'downloading' && x.total
          ? t('settings.downloading', { percent: Math.round((x.received! / x.total) * 100) })
          : x.phase === 'verifying' ? t('settings.verifyingPack')
          : x.phase === 'extracting' ? t('settings.extracting') : ''
      );
    });
  }, [t]);

  const pickUi = async (choice: UiChoice): Promise<void> => {
    setUiChoice(choice);
    const r = await window.pnr.setUiLanguage(choice);
    await changeLanguage(r.resolved);
  };

  const installPack = async (): Promise<void> => {
    setInstalling(true); setProgress(t('settings.preparing'));
    try { const r = await window.pnr.socialInstall();
      setProgress(r.ok ? '' : t('common.failedWith', { error: r.error ? t(`catalogue.packError.${r.error}`, { defaultValue: r.error }) : t('common.retry') }));
      setSocial(await window.pnr.socialStatus());
    } catch { setProgress(t('common.failedWith', { error: t('settings.downloadFailed') })); }
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
    setSaving(true); setMsg(t('common.checking'));
    const patch: Record<string, string> = { provider, outputLang: lang };
    const keyField = provider === 'gemini' ? 'geminiApiKey' : provider === 'openai' ? 'openaiApiKey'
      : provider === 'anthropic' ? 'anthropicApiKey' : 'compatibleApiKey';
    if (key.trim() && provider !== 'ollama' && provider !== 'none') patch[keyField] = key.trim();
    if (['gemini','openai','anthropic','openai-compatible'].includes(provider)) {
      patch['writeModel'] = writeModel.trim(); patch['fastModel'] = fastModel.trim(); patch['embedModel'] = embedModel.trim();
    }
    if (provider === 'openai-compatible') patch['compatibleEndpoint'] = endpoint.trim();
    if (provider === 'openai-compatible' || provider === 'ollama') patch['contextTokens'] = contextTokens.trim();
    if (provider === 'ollama') patch['ollamaHost'] = ollamaHost.trim();
    try {
      const result = await window.pnr.saveAiSettings(patch);
      setMsg(t(`settings.connection.${connectionKey(result)}`));
      setStatus(await window.pnr.aiStatus());
      if (result.connected) setKey('');
      onChanged();
    } catch { setMsg(t('common.saveFailed')); }
    finally { setSaving(false); }
  };

  return (
    <Dialog title={t('settings.title')} onClose={onClose} className="settings-modal">
        <header><h2>{t('settings.title')}</h2><span className="grow" /><button onClick={onClose}>{t('common.done')}</button></header>
        <nav className="settings-nav" aria-label={t('settings.nav')}>{(['general', 'ai', 'sources', 'background'] as const).map((id) => <button key={id} aria-pressed={section === id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{t(`settings.sections.${id}`)}</button>)}</nav>
        <div className="settings">
          <section hidden={section !== 'general'}><h3 className="sub">{t('settings.uiLanguage')}</h3>
            <label className="field">
              <select value={uiChoice} onChange={(e) => void pickUi(e.target.value as UiChoice)} aria-label={t('settings.uiLanguage')}>
                <option value="system">{t('settings.followSystem')}</option>
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
              <small className="muted">{t('settings.uiLanguageHint')}</small>
            </label>
            <h3 className="sub">{t('settings.readingLanguages')}</h3>
            <p className="muted">{t('settings.readingLanguagesHint')}</p>
            <div className="lang-picker">
              <label className="inline-check"><input type="checkbox" checked={!langs?.selected.length} onChange={() => void showAll()} />{t('settings.allLanguages')}</label>
              {langs?.available.filter((a) => a.lang).map((a) => (
                <label key={a.lang} className="inline-check">
                  <input type="checkbox" checked={!langs.selected.length || langs.selected.includes(a.lang!)} onChange={() => void toggleLang(a.lang!)} />
                  {languageName(a.lang!)}<span className="muted small"> {t('settings.articles', { count: a.count })}</span>
                </label>
              ))}
            </div>
          </section>
          <section hidden={section !== 'ai'}><h3 className="sub">{t('settings.sections.ai')}</h3>
          <p className="muted">{t('settings.aiIntro')}</p>

          <label className="field">
            <span>{t('settings.provider')}</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="gemini">{t('settings.providerGemini')}</option>
              <option value="openai">{t('settings.providerOpenAI')}</option>
              <option value="anthropic">{t('settings.providerAnthropic')}</option>
              <option value="openai-compatible">{t('settings.providerCompatible')}</option>
              <option value="ollama">{t('settings.providerOllama')}</option>
              <option value="none">{t('settings.providerNone')}</option>
            </select>
          </label>

          {['gemini','openai','anthropic','openai-compatible'].includes(provider) && (
            <label className="field">
              <span>{t('settings.apiKey')}</span>
              <input type="password" value={key} placeholder={status?.available ? t('settings.keySaved') : t('settings.apiKeyPlaceholder')}
                     onChange={(e) => setKey(e.target.value)} />
              <small className="muted">{t('settings.keyHint')}</small>
            </label>
          )}

          {provider === 'openai-compatible' && <label className="field"><span>{t('settings.endpoint')}</span>
            <input value={endpoint} placeholder="https://api.example.com/v1" onChange={(e) => setEndpoint(e.target.value)} /></label>}

          {['gemini','openai','anthropic','openai-compatible'].includes(provider) && <>
            <label className="field"><span>{t('settings.writeModel')}</span><input value={writeModel} onChange={(e) => setWriteModel(e.target.value)} placeholder={t('settings.defaultModel')} /></label>
            <label className="field"><span>{t('settings.fastModel')}</span><input value={fastModel} onChange={(e) => setFastModel(e.target.value)} placeholder={t('settings.fastModelHint')} /></label>
            {provider !== 'anthropic' && <label className="field"><span>{t('settings.embedModel')}</span><input value={embedModel} onChange={(e) => setEmbedModel(e.target.value)} placeholder={t('settings.noVectorHint')} /></label>}
          </>}

          {provider === 'ollama' && (
            <><p className="muted">{t('settings.ollamaHint')}</p>
              <label className="field"><span>{t('settings.ollamaHost')}</span><input value={ollamaHost} onChange={(e) => setOllamaHost(e.target.value)} /></label>
            </>
          )}

          {(provider === 'ollama' || provider === 'openai-compatible') && <label className="field"><span>{t('settings.contextTokens')}</span>
            <input inputMode="numeric" value={contextTokens} onChange={(e) => setContextTokens(e.target.value.replace(/\D/g, ''))} placeholder="8192" /></label>}

          <label className="field">
            <span>{t('settings.outputLanguage')}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
            </select>
            <small className="muted">{t('settings.outputLanguageHint')}</small>
          </label>

          <div className="settings-actions">
            <button className="primary" onClick={() => void save()} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
            {msg && <span role="status" className="muted">{msg}</span>}
          </div>

          </section><section hidden={section !== 'sources'}>
          <h3 className="sub">{t('settings.sections.sources')}</h3>
          <p className="muted">{t('settings.sourcesIntro')}</p>

          <label className="field">
            <span>{t('settings.instance')}</span>
            <input placeholder="http://127.0.0.1:1200" value={instance}
                   onChange={(e) => { setInstance(e.target.value); setInstanceMessage(''); }} />
            <small className="muted">{t('settings.instanceHint')}</small>
          </label>

          <div className="save-row"><button disabled={instanceSaving} onClick={async () => {
            setInstanceSaving(true); setInstanceMessage('');
            try { await window.pnr.socialSetInstance(instance.trim()); setSocial(await window.pnr.socialStatus()); setInstanceMessage(t('settings.instanceSaved')); }
            catch { setInstanceMessage(t('settings.instanceFailed')); }
            finally { setInstanceSaving(false); }
          }}>{instanceSaving ? t('common.saving') : t('settings.saveInstance')}</button><span role="status" className="muted">{instanceMessage}</span></div>
          {!social?.instanceUrl && (
            <div className="pack-box">
              {social?.pack.installed ? (
                <>
                  <p className="muted ok">
                    {t('settings.packInstalled', { mb: Math.round((social.pack.bytes ?? 0) / 1048576) })}
                    {social.pack.version && <> · {social.pack.version.split('-').pop()}</>}
                  </p>
                  <button onClick={async () => {
                    await window.pnr.socialRemove();
                    setSocial(await window.pnr.socialStatus());
                  }}>{t('settings.removePack')}</button>
                </>
              ) : (
                <>
                  <p className="muted">{t('settings.packIntro')}</p>
                  <button className="primary" onClick={() => void installPack()} disabled={installing}>
                    {installing ? progress : t('settings.downloadPack')}
                  </button>
                </>
              )}
              {progress && progress && !installing && <p className="muted warn">{progress}</p>}
            </div>
          )}

          <h3 className="sub">X / Twitter</h3>
          <p className="muted">{t('settings.xIntro')}</p>
          <div className="save-row">
            <input type="password" value={apify} placeholder={hasApify ? t('settings.keySaved') : 'apify_api_…'} onChange={(e) => { setApify(e.target.value); setApifyMessage(''); }} />
            <button disabled={!apify.trim()} onClick={async () => {
              try { await window.pnr.setApifyToken(apify); setApify(''); setHasApify(true); setApifyMessage(t('common.saved')); }
              catch { setApifyMessage(t('common.saveFailed')); }
            }}>{t('settings.saveToken')}</button>
            {hasApify && <button onClick={async () => { await window.pnr.setApifyToken(''); setHasApify(false); setApifyMessage(t('common.removed')); }}>{t('common.remove')}</button>}
            <span role="status" className="muted">{apifyMessage}</span>
          </div>

          </section><section hidden={section !== 'background'}>
          <h3 className="sub">{t('settings.sections.background')}</h3>
          <p className="muted">{t('settings.backgroundIntro')}</p>

          <label className="inline-check big">
            <input type="checkbox" checked={Boolean(sched?.enabled)}
                   onChange={(e) => void toggleSchedule(e.target.checked)} />
            {t('settings.allowBackground')}
          </label>

          {sched?.enabled && (
            <>
              {sched.status === 'requires-approval' && (
                <p className="muted warn">{t('common.loginItemsHint')}</p>
              )}
              <label className="field">
                <span>{t('settings.dailyTime')}</span>
                <select value={hour} onChange={async (e) => {
                  const h = Number(e.target.value); setHour(h);
                  setSched(await window.pnr.setSchedule(true, h) as ScheduleState);
                }}>
                  {[5,6,7,8,9,10].map((h) => <option key={h} value={h}>{h}:15</option>)}
                </select>
                <small className="muted">{t('settings.flashInterval', { count: sched.flashIntervalHours })}</small>
              </label>

              <div className="run-info">
                {sched.lastRun ? (
                  <p className="muted">
                    {t('settings.lastRun', { when: dateTime(sched.lastRun.at), kind: sched.lastRun.kind,
                      outcome: t(`settings.outcome.${sched.lastRun.outcome === 'ok' || sched.lastRun.outcome === 'partial' ? sched.lastRun.outcome : 'failed'}`) })}
                  </p>
                ) : <p className="muted">{t('settings.neverRun')}</p>}
                <p className="muted small">
                  {t('settings.loginItems')}
                  {sched.mode === 'launchAgent' && sched.plistPath && (
                    <><br />{t('settings.plistPath')}<code>{sched.plistPath}</code></>
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
