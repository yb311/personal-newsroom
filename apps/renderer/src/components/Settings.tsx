import { Bot, Clock, Rss, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Group, Row, Select, Switch } from './Form.tsx';
import { useTranslation } from 'react-i18next';
import { changeLanguage, dateTime, languageName } from '../i18n.ts';
import type { AiConnection, AiStatus, ScheduleState, SocialStatus } from '../types.ts';

type UiChoice = 'system' | 'zh-CN' | 'en';
type Section = 'general' | 'ai' | 'sources' | 'background';
type ProviderChoice = 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'none';
const SECTIONS = [['general', SlidersHorizontal], ['ai', Bot], ['sources', Rss], ['background', Clock]] as const;
const PROVIDERS: ProviderChoice[] = ['gemini', 'openai', 'anthropic', 'openai-compatible', 'ollama', 'none'];
const CLOUD = new Set<ProviderChoice>(['gemini', 'openai', 'anthropic', 'openai-compatible']);
/** Output languages, each named in itself. */
const OUTPUT_LANGS: [string, string][] = [['zh-CN', '中文'], ['en-US', 'English'], ['ja-JP', '日本語']];

/** Which message the settings screen shows after saving AI settings. */
const connectionKey = (c: AiConnection): string =>
  c.mode === 'none' ? 'none' : c.connected ? 'connected' : c.problem ? c.problem : 'ollama_down';
const hasKey = (s: AiStatus, p: ProviderChoice): boolean =>
  p === 'gemini' ? s.hasGeminiKey : p === 'openai' ? s.hasOpenAiKey
    : p === 'anthropic' ? s.hasAnthropicKey : p === 'openai-compatible' ? s.hasCompatibleKey : false;
/** Tells the main window to reload what a setting affects. */
const changed = (): void => { void window.pnr.broadcast('settingsChanged'); };

/** Keys live on this machine only. The app is deliberately usable without one. */
export function SettingsWindow({ initial }: { initial?: string | undefined }) {
  const { t } = useTranslation();
  const start = SECTIONS.some(([id]) => id === initial) ? initial as Section : 'general';
  const [section, setSection] = useState<Section>(start);
  useEffect(() => { document.title = t('settings.title'); }, [t]);
  // Opening Settings for a particular section (e.g. "Connect AI") while it is already open.
  useEffect(() => window.pnr.onCommand?.((c) => {
    const s = c.startsWith('section:') ? c.slice(8) : '';
    if (SECTIONS.some(([id]) => id === s)) setSection(s as Section);
  }), []);

  return (
    <div className="settings-window">
      <aside className="sidebar settings-sidebar">
        <div className="sidebar-top" />
        <nav className="sidebar-scroll" aria-label={t('settings.title')}>
          <ul className="side-list">
            {SECTIONS.map(([id, Icon]) => <li key={id}>
              <button className={`side-row ${section === id ? 'selected' : ''}`} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
                <Icon size={16} className="accent" /><span>{t(`settings.sections.${id}`)}</span></button></li>)}
          </ul>
        </nav>
      </aside>
      <main className="settings-main">
        <header className="toolbar"><div className="toolbar-title"><h1>{t(`settings.sections.${section}`)}</h1></div></header>
        <div className="settings-body">
          {section === 'general' && <General />}
          {section === 'ai' && <Ai />}
          {section === 'sources' && <Sources />}
          {section === 'background' && <Background />}
        </div>
      </main>
    </div>
  );
}

function General() {
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
  const shown = (lang: string): boolean => !langs?.selected.length || langs.selected.includes(lang);
  const toggle = async (lang: string, on: boolean): Promise<void> => {
    const current = langs?.selected.length ? langs.selected : known;
    const next = on ? [...new Set([...current, lang])] : current.filter((l) => l !== lang);
    const value = next.length === 0 || known.every((l) => next.includes(l)) ? [] : next;
    await window.pnr.setReadingLanguages(value);
    setLangs((l) => l && { ...l, selected: value });
    changed();
  };

  return <>
    <Group>
      <Row label={t('settings.uiLanguage')} hint={t('settings.uiLanguageHint')}>
        <Select value={uiChoice} onChange={(e) => void pickUi(e.target.value as UiChoice)} aria-label={t('settings.uiLanguage')}>
          <option value="system">{t('settings.followSystem')}</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </Select>
      </Row>
    </Group>
    <Group title={t('settings.readingLanguages')} footer={t('settings.readingLanguagesHint')}>
      {known.length === 0 && <div className="row"><p className="row-status">{t('settings.noLanguages')}</p></div>}
      {langs?.available.filter((a) => a.lang).map((a) => (
        <Row key={a.lang} label={languageName(a.lang!)} hint={t('settings.articles', { count: a.count })}>
          <Switch label={languageName(a.lang!)} checked={shown(a.lang!)} onChange={(on) => void toggle(a.lang!, on)} />
        </Row>
      ))}
    </Group>
  </>;
}

function Ai() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => { void window.pnr.aiStatus().then(setStatus); }, []);
  if (!status) return null;
  return <AiForm status={status} onSaved={async () => { setStatus(await window.pnr.aiStatus()); changed(); }} />;
}

function AiForm({ status, onSaved }: { status: AiStatus; onSaved: () => Promise<void> }) {
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
    changed();
  };

  const state = status.available ? t('settings.state.connected', { provider: t(`settings.providers.${saved}`) })
    : saved === 'none' ? t('settings.state.off') : t('settings.state.notConnected');
  const unsaved = provider !== saved || Boolean(key.trim());

  return <>
    <Group title={t('settings.connectionTitle')} footer={t('settings.aiIntro')}>
      <Row label={t('settings.provider')} hint={<><i className={`status-dot ${status.available && !unsaved ? 'on' : ''}`} />{state}</>}>
        <Select value={provider} onChange={(e) => pickProvider(e.target.value as ProviderChoice)} aria-label={t('settings.provider')}>
          {PROVIDERS.map((p) => <option key={p} value={p}>{t(`settings.providers.${p}`)}</option>)}
        </Select>
      </Row>
      {CLOUD.has(provider) && <Row label={t('settings.apiKey')} hint={t(`settings.keyHint.${provider === 'openai-compatible' ? 'compatible' : provider}`)}>
        <input type="password" value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} aria-label={t('settings.apiKey')}
               placeholder={hasKey(status, provider) ? t('settings.keySaved') : t('settings.keyPlaceholder')} />
      </Row>}
      {provider === 'openai-compatible' && <>
        <Row label={t('settings.endpoint')}><input value={endpoint} placeholder="https://api.example.com/v1" onChange={(e) => setEndpoint(e.target.value)} aria-label={t('settings.endpoint')} /></Row>
        <Row label={t('settings.writeModel')}><input value={models.write} onChange={(e) => setModels({ ...models, write: e.target.value })} aria-label={t('settings.writeModel')} /></Row>
      </>}
      {provider === 'ollama' && <Row label={t('settings.ollamaHost')} hint={t('settings.ollamaHint')}>
        <input value={ollamaHost} onChange={(e) => setOllamaHost(e.target.value)} aria-label={t('settings.ollamaHost')} /></Row>}
      <div className="row actions">
        {msg && <span role="status" className="row-status">{msg}</span>}
        <span className="grow" />
        <button className="primary" onClick={() => void save()} disabled={saving}>{saving ? t('common.checking') : provider === 'none' ? t('common.save') : t('settings.saveConnect')}</button>
      </div>
    </Group>

    {(CLOUD.has(provider) || provider === 'ollama') && <Group title={t('settings.advanced')}>
      {provider !== 'openai-compatible' && provider !== 'ollama' && <Row label={t('settings.writeModel')}>
        <input value={models.write} onChange={(e) => setModels({ ...models, write: e.target.value })} placeholder={placeholder(defaults?.write, t('settings.useDefault'))} aria-label={t('settings.writeModel')} /></Row>}
      {provider !== 'ollama' && <Row label={t('settings.fastModel')}>
        <input value={models.fast} onChange={(e) => setModels({ ...models, fast: e.target.value })} placeholder={placeholder(defaults?.fast, t('settings.sameAsWrite'))} aria-label={t('settings.fastModel')} /></Row>}
      {provider !== 'anthropic' && provider !== 'ollama' && <Row label={t('settings.embedModel')} hint={t('settings.embedHint')}>
        <input value={models.embed} onChange={(e) => setModels({ ...models, embed: e.target.value })} placeholder={placeholder(defaults?.embed, t('settings.noEmbed'))} aria-label={t('settings.embedModel')} /></Row>}
      {(provider === 'openai-compatible' || provider === 'ollama') && <Row label={t('settings.contextTokens')}>
        <input inputMode="numeric" value={contextTokens} onChange={(e) => setContextTokens(e.target.value.replace(/\D/g, ''))} placeholder="8192" aria-label={t('settings.contextTokens')} /></Row>}
    </Group>}

    <Group title={t('settings.featuresTitle')}>
      <Row label={t('settings.outputLanguage')} hint={t('settings.outputLanguageHint')}>
        <Select value={options.outputLang} onChange={(e) => void setOption('outputLang', e.target.value)} aria-label={t('settings.outputLanguage')}>
          {OUTPUT_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select></Row>
      <Row label={t('settings.searchFill')} hint={t('settings.searchFillHint')}>
        <Switch label={t('settings.searchFill')} checked={options.searchFillEnabled} onChange={(on) => void setOption('searchFillEnabled', on)} /></Row>
      <Row label={t('settings.outsidePicks')} hint={t('settings.outsidePicksHint')}>
        <Switch label={t('settings.outsidePicks')} checked={options.outsidePicksEnabled} onChange={(on) => void setOption('outsidePicksEnabled', on)} /></Row>
    </Group>
  </>;
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
    try { await window.pnr.socialSetInstance(instance.trim()); setSocial(await window.pnr.socialStatus()); setInstanceMessage(t('common.saved')); changed(); }
    catch { setInstanceMessage(t('settings.instanceFailed')); }
  };
  const packed = social?.pack.installed;

  return <>
    <Group title={t('settings.rsshubTitle')} footer={t('settings.rsshubIntro')}>
      <Row label={packed ? t('settings.packInstalled', { mb: Math.round((social!.pack.bytes ?? 0) / 1048576) }) : t('settings.packMissing')}
           hint={packed && social?.pack.version ? social.pack.version.split('-').pop() : progress && !installing ? progress : undefined}>
        {packed
          ? <button className="push" onClick={async () => { await window.pnr.socialRemove(); setSocial(await window.pnr.socialStatus()); changed(); }}>{t('settings.removePack')}</button>
          : <button className="push" onClick={() => void install()} disabled={installing || Boolean(social?.instanceUrl)}>{installing ? progress || t('settings.preparing') : t('settings.downloadPack')}</button>}
      </Row>
      <Row wide label={t('settings.instance')} hint={instanceMessage || t('settings.instanceHint')}>
        <div className="inline"><input placeholder="http://127.0.0.1:1200" value={instance} aria-label={t('settings.instance')} onChange={(e) => { setInstance(e.target.value); setInstanceMessage(''); }} />
          <button className="push" onClick={() => void saveInstance()}>{t('common.save')}</button></div>
      </Row>
    </Group>
    <Group title="X / Twitter" footer={t('settings.xIntro')}>
      <Row label={t('settings.apifyToken')} hint={apifyMessage || undefined}>
        <div className="inline">
          <input type="password" autoComplete="off" value={apify} aria-label={t('settings.apifyToken')} placeholder={hasApify ? t('settings.keySaved') : 'apify_api_…'} onChange={(e) => { setApify(e.target.value); setApifyMessage(''); }} />
          {apify.trim()
            ? <button className="push" onClick={async () => {
                try { await window.pnr.setApifyToken(apify); setApify(''); setHasApify(true); setApifyMessage(t('common.saved')); }
                catch { setApifyMessage(t('common.saveFailed')); }
              }}>{t('common.save')}</button>
            : hasApify && <button className="push" onClick={async () => { await window.pnr.setApifyToken(''); setHasApify(false); setApifyMessage(t('common.removed')); }}>{t('common.remove')}</button>}
        </div>
      </Row>
    </Group>
  </>;
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
  const last = sched?.lastRun;

  return <Group footer={<>{t('settings.backgroundIntro')} {t('settings.loginItems')}</>}>
    <Row label={t('settings.allowBackground')} hint={sched?.status === 'requires-approval' ? <span className="warn">{t('common.loginItemsHint')}</span> : undefined}>
      <Switch label={t('settings.allowBackground')} disabled={busy || !sched} checked={Boolean(sched?.enabled)} onChange={(on) => void apply(on)} />
    </Row>
    {sched?.enabled && <>
      <Row label={t('settings.dailyTime')} hint={t('settings.flashInterval', { count: sched.flashIntervalHours })}>
        <Select value={sched.dailyHour} disabled={busy} onChange={(e) => void apply(true, Number(e.target.value))} aria-label={t('settings.dailyTime')}>
          {[5, 6, 7, 8, 9, 10].map((h) => <option key={h} value={h}>{h}:15</option>)}
        </Select></Row>
      <Row label={t('settings.lastRunLabel')} hint={sched.mode === 'launchAgent' && sched.plistPath ? <>{t('settings.plistPath')}<code>{sched.plistPath}</code></> : undefined}>
        <span className="row-value">{last
          ? t('settings.lastRun', { when: dateTime(last.at), kind: t(`settings.runKind.${last.kind}`, { defaultValue: last.kind }),
              outcome: t(`settings.outcome.${last.outcome === 'ok' || last.outcome === 'partial' ? last.outcome : 'failed'}`) })
          : t('settings.neverRun')}</span>
      </Row>
    </>}
  </Group>;
}
