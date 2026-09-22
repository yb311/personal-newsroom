import { Dialog } from './Dialog.tsx';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, dateTime, languageName } from '../i18n.ts';
import type { AiConnection, AiStatus, ScheduleState, SocialStatus } from '../types.ts';

type UiChoice = 'system' | 'zh-CN' | 'en';
type Section = 'general' | 'ai' | 'sources' | 'background';
type ProviderChoice = 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'none';
const SECTIONS: Section[] = ['general', 'ai', 'sources', 'background'];
const PROVIDERS: ProviderChoice[] = ['gemini', 'openai', 'anthropic', 'openai-compatible', 'ollama', 'none'];
const CLOUD = new Set<ProviderChoice>(['gemini', 'openai', 'anthropic', 'openai-compatible']);
/** Output languages, each named in itself. */
const OUTPUT_LANGS: [string, string][] = [['zh-CN', '中文'], ['en-US', 'English'], ['ja-JP', '日本語']];

/** Which message the settings screen shows after saving AI settings. */
const connectionKey = (c: AiConnection): string =>
  c.mode === 'none' ? 'none' : c.connected ? 'connected' : c.problem ? c.problem : 'ollama_down';

const hasKey = (s: AiStatus | null, p: ProviderChoice): boolean =>
  p === 'gemini' ? Boolean(s?.hasGeminiKey) : p === 'openai' ? Boolean(s?.hasOpenAiKey)
    : p === 'anthropic' ? Boolean(s?.hasAnthropicKey) : p === 'openai-compatible' ? Boolean(s?.hasCompatibleKey) : false;

/** Keys live on this machine only. The app is deliberately usable without one. */
export function Settings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>('general');
  const [status, setStatus] = useState<AiStatus | null>(null);

  const reload = async (): Promise<void> => setStatus(await window.pnr.aiStatus());
  useEffect(() => { void reload(); }, []);

  return (
    <Dialog title={t('settings.title')} onClose={onClose} className="settings-dialog">
      <header><h2>{t('settings.title')}</h2><span className="grow" /><button className="secondary" onClick={onClose}>{t('common.done')}</button></header>
      <nav className="settings-nav" aria-label={t('settings.title')}>
        {SECTIONS.map((id) => <button key={id} aria-current={section === id ? 'page' : undefined} className={section === id ? 'selected' : ''}
          onClick={() => setSection(id)}>{t(`settings.sections.${id}`)}</button>)}
      </nav>
      <div className="settings-body">
        {section === 'general' && <General onChanged={onChanged} />}
        {section === 'ai' && status && <Ai status={status} onSaved={async () => { await reload(); onChanged(); }} />}
        {section === 'sources' && <Sources />}
        {section === 'background' && <Background />}
      </div>
    </Dialog>
  );
}

function General({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [uiChoice, setUiChoice] = useState<UiChoice>('system');
  const [langs, setLangs] = useState<{ available: { lang: string | null; count: number }[]; selected: string[] } | null>(null);
  useEffect(() => {
    void window.pnr.uiLanguage().then((u) => setUiChoice(u.choice));
    void window.pnr.readingLanguages().then(setLangs);
  }, []);

  const pickUi = async (choice: UiChoice): Promise<void> => {
    setUiChoice(choice);
    const r = await window.pnr.setUiLanguage(choice);
    await changeLanguage(r.resolved);
  };
  // An empty selection means every language is shown.
  const known = (langs?.available ?? []).map((a) => a.lang).filter((l): l is string => Boolean(l));
  const setSelection = async (next: string[]): Promise<void> => {
    const value = next.length === 0 || known.every((l) => next.includes(l)) ? [] : next;
    await window.pnr.setReadingLanguages(value);
    setLangs((l) => l && { ...l, selected: value });
    onChanged();
  };
  const toggleLang = (lang: string): void => {
    const current = langs?.selected.length ? langs.selected : known;
    void setSelection(current.includes(lang) ? current.filter((l) => l !== lang) : [...current, lang]);
  };

  return <section>
    <h3>{t('settings.uiLanguage')}</h3>
    <label className="field">
      <select value={uiChoice} onChange={(e) => void pickUi(e.target.value as UiChoice)} aria-label={t('settings.uiLanguage')}>
        <option value="system">{t('settings.followSystem')}</option>
        <option value="zh-CN">中文</option>
        <option value="en">English</option>
      </select>
      <small>{t('settings.uiLanguageHint')}</small>
    </label>
    <h3>{t('settings.readingLanguages')}</h3>
    <p className="section-hint">{t('settings.readingLanguagesHint')}</p>
    <div className="check-grid">
      <label className="check"><input type="checkbox" checked={!langs?.selected.length} onChange={() => void setSelection([])} />{t('settings.allLanguages')}</label>
      {langs?.available.filter((a) => a.lang).map((a) => (
        <label key={a.lang} className="check">
          <input type="checkbox" checked={!langs.selected.length || langs.selected.includes(a.lang!)} onChange={() => toggleLang(a.lang!)} />
          {languageName(a.lang!)}<small>{a.count}</small>
        </label>
      ))}
    </div>
  </section>;
}

function Ai({ status, onSaved }: { status: AiStatus; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const saved = status.provider as ProviderChoice;
  const [provider, setProvider] = useState<ProviderChoice>(saved);
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(status.compatibleEndpoint);
  const [models, setModels] = useState({ write: status.writeModel, fast: status.fastModel, embed: status.embedModel });
  const [contextTokens, setContextTokens] = useState(status.contextTokens);
  const [ollamaHost, setOllamaHost] = useState(status.ollamaHost);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [options, setOptions] = useState({ outputLang: status.outputLang, searchFillEnabled: status.searchFillEnabled, outsidePicksEnabled: status.outsidePicksEnabled });

  // Model names are stored once for all cloud providers: switching provider
  // must not carry one vendor's model names over to another.
  const pickProvider = (p: ProviderChoice): void => {
    setProvider(p); setKey(''); setMsg('');
    setModels(p === saved ? { write: status.writeModel, fast: status.fastModel, embed: status.embedModel } : { write: '', fast: '', embed: '' });
  };
  const defaults = provider === 'gemini' || provider === 'openai' || provider === 'anthropic' ? status.defaults[provider] : null;
  const placeholder = (value: string | undefined, fallback: string): string => (value ? t('settings.defaultIs', { value }) : fallback);

  const save = async (): Promise<void> => {
    setSaving(true); setMsg(t('common.checking'));
    const patch: Record<string, string> = { provider };
    const keyField = provider === 'gemini' ? 'geminiApiKey' : provider === 'openai' ? 'openaiApiKey'
      : provider === 'anthropic' ? 'anthropicApiKey' : 'compatibleApiKey';
    if (key.trim() && CLOUD.has(provider)) patch[keyField] = key.trim();
    if (CLOUD.has(provider)) { patch['writeModel'] = models.write.trim(); patch['fastModel'] = models.fast.trim(); patch['embedModel'] = models.embed.trim(); }
    if (provider === 'openai-compatible') patch['compatibleEndpoint'] = endpoint.trim();
    if (provider === 'openai-compatible' || provider === 'ollama') patch['contextTokens'] = contextTokens.trim();
    if (provider === 'ollama') patch['ollamaHost'] = ollamaHost.trim();
    try {
      const result = await window.pnr.saveAiSettings(patch);
      setMsg(t(`settings.connection.${connectionKey(result)}`));
      if (result.connected) setKey('');
      await onSaved();
    } catch { setMsg(t('common.saveFailed')); }
    finally { setSaving(false); }
  };
  const setOption = async (name: keyof typeof options, value: string | boolean): Promise<void> => {
    setOptions((o) => ({ ...o, [name]: value }));
    await window.pnr.setAiOption(name, typeof value === 'boolean' ? (value ? '1' : '0') : value);
    await onSaved();
  };

  const current = status.available ? t('settings.state.connected', { provider: t(`settings.providers.${saved}`) })
    : saved === 'none' ? t('settings.state.off') : t('settings.state.notConnected');

  return <section>
    <h3>{t('settings.connectionTitle')}</h3>
    <p className="section-hint">{t('settings.aiIntro')}</p>
    <p className={`state-line ${status.available ? 'on' : ''}`}><i className={`status-dot ${status.available ? 'on' : ''}`} />{current}</p>

    <label className="field"><span>{t('settings.provider')}</span>
      <select value={provider} onChange={(e) => pickProvider(e.target.value as ProviderChoice)}>
        {PROVIDERS.map((p) => <option key={p} value={p}>{t(`settings.providers.${p}`)}</option>)}
      </select></label>

    {CLOUD.has(provider) && <label className="field"><span>{t('settings.apiKey')}{provider === 'openai-compatible' && <i>{t('common.optional')}</i>}</span>
      <input type="password" value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)}
             placeholder={hasKey(status, provider) ? t('settings.keySaved') : t('settings.keyPlaceholder')} />
      <small>{t(`settings.keyHint.${provider === 'openai-compatible' ? 'compatible' : provider}`)}</small></label>}

    {provider === 'openai-compatible' && <>
      <label className="field"><span>{t('settings.endpoint')}</span>
        <input value={endpoint} placeholder="https://api.example.com/v1" onChange={(e) => setEndpoint(e.target.value)} /></label>
      <label className="field"><span>{t('settings.writeModel')}</span>
        <input value={models.write} onChange={(e) => setModels({ ...models, write: e.target.value })} /></label>
    </>}
    {provider === 'ollama' && <>
      <p className="section-hint">{t('settings.ollamaHint')}</p>
      <label className="field"><span>{t('settings.ollamaHost')}</span><input value={ollamaHost} onChange={(e) => setOllamaHost(e.target.value)} /></label>
    </>}

    {(CLOUD.has(provider) || provider === 'ollama') && <details className="disclosure">
      <summary>{t('settings.advanced')}</summary>
      {provider !== 'openai-compatible' && provider !== 'ollama' && <label className="field"><span>{t('settings.writeModel')}</span>
        <input value={models.write} onChange={(e) => setModels({ ...models, write: e.target.value })} placeholder={placeholder(defaults?.write, t('settings.useDefault'))} /></label>}
      {provider !== 'ollama' && <label className="field"><span>{t('settings.fastModel')}</span>
        <input value={models.fast} onChange={(e) => setModels({ ...models, fast: e.target.value })} placeholder={placeholder(defaults?.fast, t('settings.sameAsWrite'))} /></label>}
      {provider !== 'anthropic' && provider !== 'ollama' && <label className="field"><span>{t('settings.embedModel')}</span>
        <input value={models.embed} onChange={(e) => setModels({ ...models, embed: e.target.value })} placeholder={placeholder(defaults?.embed, t('settings.noEmbed'))} />
        <small>{t('settings.embedHint')}</small></label>}
      {(provider === 'openai-compatible' || provider === 'ollama') && <label className="field"><span>{t('settings.contextTokens')}</span>
        <input inputMode="numeric" value={contextTokens} onChange={(e) => setContextTokens(e.target.value.replace(/\D/g, ''))} placeholder="8192" /></label>}
    </details>}

    <div className="form-actions">
      <button className="primary" onClick={() => void save()} disabled={saving}>{saving ? t('common.checking') : provider === 'none' ? t('common.save') : t('settings.saveConnect')}</button>
      {msg && <span role="status" className="section-hint">{msg}</span>}
    </div>

    <h3>{t('settings.featuresTitle')}</h3>
    <label className="field"><span>{t('settings.outputLanguage')}</span>
      <select value={options.outputLang} onChange={(e) => void setOption('outputLang', e.target.value)}>
        {OUTPUT_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <small>{t('settings.outputLanguageHint')}</small></label>
    <label className="check block"><input type="checkbox" checked={options.searchFillEnabled} onChange={(e) => void setOption('searchFillEnabled', e.target.checked)} />
      <span>{t('settings.searchFill')}<small>{t('settings.searchFillHint')}</small></span></label>
    <label className="check block"><input type="checkbox" checked={options.outsidePicksEnabled} onChange={(e) => void setOption('outsidePicksEnabled', e.target.checked)} />
      <span>{t('settings.outsidePicks')}<small>{t('settings.outsidePicksHint')}</small></span></label>
  </section>;
}

function Sources() {
  const { t } = useTranslation();
  const [social, setSocial] = useState<SocialStatus | null>(null);
  const [instance, setInstance] = useState('');
  const [instanceMessage, setInstanceMessage] = useState('');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState('');
  const [apify, setApify] = useState('');
  const [hasApify, setHasApify] = useState(false);
  const [apifyMessage, setApifyMessage] = useState('');

  useEffect(() => {
    void window.pnr.socialStatus().then((s) => { setSocial(s); setInstance(s.instanceUrl ?? ''); });
    void window.pnr.hasApifyToken().then(setHasApify);
  }, []);
  useEffect(() => window.pnr.onSocialProgress((p) => {
    const x = p as { phase: string; received?: number; total?: number };
    setProgress(x.phase === 'downloading' && x.total ? t('settings.downloading', { percent: Math.round((x.received! / x.total) * 100) })
      : x.phase === 'verifying' ? t('settings.verifyingPack') : x.phase === 'extracting' ? t('settings.extracting') : '');
  }), [t]);

  const install = async (): Promise<void> => {
    setInstalling(true); setProgress(t('settings.preparing'));
    try {
      const r = await window.pnr.socialInstall();
      setProgress(r.ok ? '' : t('common.failedWith', { error: r.error ? t(`catalogue.packError.${r.error}`, { defaultValue: r.error }) : t('common.retry') }));
      setSocial(await window.pnr.socialStatus());
    } catch { setProgress(t('common.failedWith', { error: t('settings.downloadFailed') })); }
    finally { setInstalling(false); }
  };
  const saveInstance = async (): Promise<void> => {
    setInstanceMessage('');
    try { await window.pnr.socialSetInstance(instance.trim()); setSocial(await window.pnr.socialStatus()); setInstanceMessage(t('common.saved')); }
    catch { setInstanceMessage(t('settings.instanceFailed')); }
  };

  return <section>
    <h3>{t('settings.rsshubTitle')}</h3>
    <p className="section-hint">{t('settings.rsshubIntro')}</p>
    {!social?.instanceUrl && <div className="panel row">
      {social?.pack.installed
        ? <><span>{t('settings.packInstalled', { mb: Math.round((social.pack.bytes ?? 0) / 1048576) })}{social.pack.version ? ` · ${social.pack.version.split('-').pop()}` : ''}</span>
            <span className="grow" /><button className="secondary" onClick={async () => { await window.pnr.socialRemove(); setSocial(await window.pnr.socialStatus()); }}>{t('settings.removePack')}</button></>
        : <><span>{t('settings.packMissing')}</span><span className="grow" />
            <button className="primary" onClick={() => void install()} disabled={installing}>{installing ? progress || t('settings.preparing') : t('settings.downloadPack')}</button></>}
    </div>}
    {progress && !installing && <p className="error-text">{progress}</p>}
    <label className="field"><span>{t('settings.instance')}<i>{t('common.optional')}</i></span>
      <div className="input-row">
        <input placeholder="http://127.0.0.1:1200" value={instance} onChange={(e) => { setInstance(e.target.value); setInstanceMessage(''); }} />
        <button className="secondary" onClick={() => void saveInstance()}>{t('common.save')}</button>
      </div>
      <small>{instanceMessage || t('settings.instanceHint')}</small>
    </label>

    <h3>X / Twitter</h3>
    <p className="section-hint">{t('settings.xIntro')}</p>
    <label className="field"><span>{t('settings.apifyToken')}</span>
      <div className="input-row">
        <input type="password" autoComplete="off" value={apify} placeholder={hasApify ? t('settings.keySaved') : 'apify_api_…'} onChange={(e) => { setApify(e.target.value); setApifyMessage(''); }} />
        <button className="secondary" disabled={!apify.trim()} onClick={async () => {
          try { await window.pnr.setApifyToken(apify); setApify(''); setHasApify(true); setApifyMessage(t('common.saved')); }
          catch { setApifyMessage(t('common.saveFailed')); }
        }}>{t('common.save')}</button>
        {hasApify && <button className="secondary" onClick={async () => { await window.pnr.setApifyToken(''); setHasApify(false); setApifyMessage(t('common.removed')); }}>{t('common.remove')}</button>}
      </div>
      {apifyMessage && <small role="status">{apifyMessage}</small>}
    </label>
  </section>;
}

function Background() {
  const { t } = useTranslation();
  const [sched, setSched] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void window.pnr.scheduleState().then(setSched); }, []);
  const apply = async (on: boolean, hour = sched?.dailyHour ?? 7): Promise<void> => {
    setBusy(true);
    try { setSched(await window.pnr.setSchedule(on, hour)); } finally { setBusy(false); }
  };

  return <section>
    <h3>{t('settings.sections.background')}</h3>
    <p className="section-hint">{t('settings.backgroundIntro')}</p>
    <label className="check block panel"><input type="checkbox" disabled={busy || !sched} checked={Boolean(sched?.enabled)} onChange={(e) => void apply(e.target.checked)} />
      <span>{t('settings.allowBackground')}<small>{t('settings.loginItems')}</small></span></label>
    {sched?.enabled && <>
      {sched.status === 'requires-approval' && <p className="error-text">{t('common.loginItemsHint')}</p>}
      <label className="field"><span>{t('settings.dailyTime')}</span>
        <select value={sched.dailyHour} disabled={busy} onChange={(e) => void apply(true, Number(e.target.value))}>
          {[5, 6, 7, 8, 9, 10].map((h) => <option key={h} value={h}>{h}:15</option>)}
        </select>
        <small>{t('settings.flashInterval', { count: sched.flashIntervalHours })}</small></label>
      <p className="section-hint">
        {sched.lastRun
          ? t('settings.lastRun', { when: dateTime(sched.lastRun.at), kind: t(`settings.runKind.${sched.lastRun.kind}`, { defaultValue: sched.lastRun.kind }),
              outcome: t(`settings.outcome.${sched.lastRun.outcome === 'ok' || sched.lastRun.outcome === 'partial' ? sched.lastRun.outcome : 'failed'}`) })
          : t('settings.neverRun')}
      </p>
      {sched.mode === 'launchAgent' && sched.plistPath && <p className="section-hint">{t('settings.plistPath')}<code>{sched.plistPath}</code></p>}
    </>}
  </section>;
}
