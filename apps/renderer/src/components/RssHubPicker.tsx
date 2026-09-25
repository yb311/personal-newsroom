import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CuratedRoute, SocialStatus } from '../types.ts';
import { Select } from './Form.tsx';

/** Values a route's example uses, so each field can show a working sample. */
function exampleValues(route: CuratedRoute): Record<string, string> {
  const tpl = route.path.split('/').filter(Boolean);
  const ex = route.example.split('/').filter(Boolean);
  const out: Record<string, string> = {};
  tpl.forEach((seg, i) => {
    const m = seg.match(/^:([A-Za-z0-9_]+)/);
    if (m && ex[i] !== undefined) out[m[1]!] = decodeURIComponent(ex[i]!);
  });
  return out;
}

/** Mirrors fillRoute in @pnr/feed: builds the route from the entered values. */
function fill(route: CuratedRoute, values: Record<string, string>): string | null {
  const out: string[] = [];
  let gap = false;
  for (const seg of route.path.split('/').filter(Boolean)) {
    const m = seg.match(/^:([A-Za-z0-9_]+)(\{[^}]*\})?(\?)?$/);
    if (!m) { if (gap) return null; out.push(seg); continue; }
    const v = values[m[1]!]?.trim();
    if (!v) { if (!m[3]) return null; gap = true; continue; }
    if (gap) return null;
    out.push(encodeURIComponent(v));
  }
  return `/${out.join('/')}`;
}

/**
 * The 社交平台 tab: ready-made RSSHub routes by platform. Pick a route, fill
 * in what it needs (each field explained by RSSHub's own description, with a
 * working example), try it, add it. Or paste the address of a page — a
 * 少数派 author, a 即刻 circle — and the matching route is filled in.
 */
export function RssHubPicker({ describe, onAdded }: { describe: (reason?: string) => string; onAdded: () => void }) {
  const { t } = useTranslation();
  const [routes, setRoutes] = useState<CuratedRoute[]>([]);
  const [social, setSocial] = useState<SocialStatus | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState('');
  const [platform, setPlatform] = useState<string | null>(null);
  const [route, setRoute] = useState<CuratedRoute | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<{ ok: boolean; titles: string[]; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [failed, setFailed] = useState('');

  useEffect(() => {
    void window.pnr.rsshubRoutes().then((r) => { setRoutes(r); setPlatform(r[0]?.platform ?? null); });
    void window.pnr.rssHubReady().then(setReady);
    void window.pnr.socialStatus().then(setSocial);
  }, []);
  useEffect(() => {
    return window.pnr.onSocialProgress((p) => {
      const x = p as { phase: string; received?: number; total?: number };
      setInstalling(x.phase === 'downloading' && x.total ? t('settings.downloading', { percent: Math.round((x.received! / x.total) * 100) })
        : x.phase === 'verifying' ? t('settings.verifyingPack') : x.phase === 'extracting' ? t('settings.extracting') : '');
    });
  }, [t]);

  const platforms = useMemo(() => [...new Set(routes.map((r) => r.platform))], [routes]);
  const choose = (r: CuratedRoute, preset?: Record<string, string>): void => {
    // A select shows its default; the route has to be built with it too.
    const defaults = Object.fromEntries(r.params.filter((p) => p.default != null).map((p) => [p.key, p.default!]));
    setRoute(r); setValues({ ...defaults, ...preset }); setPreview(null); setResult('');
  };
  const path = route ? fill(route, values) : null;
  const examples = route ? exampleValues(route) : {};

  const install = async (): Promise<void> => {
    setInstalling(t('settings.preparing')); setFailed('');
    const r = await window.pnr.socialInstall().catch(() => ({ ok: false, error: undefined }));
    setInstalling('');
    if (!r.ok) setFailed(t('common.failedWith', { error: r.error ? t(`catalogue.packError.${r.error}`, { defaultValue: r.error }) : t('common.retry') }));
    setReady(await window.pnr.rssHubReady());
    setSocial(await window.pnr.socialStatus());
  };

  const recognise = async (): Promise<void> => {
    const hit = await window.pnr.matchRoute(pasted);
    const r = hit ? routes.find((x) => x.id === hit.routeId) : null;
    if (!hit || !r) { setResult(t('rsshub.notRecognised')); return; }
    setPlatform(r.platform);
    // Recover the values from the matched path so the form shows them.
    const tpl = r.path.split('/').filter(Boolean);
    const got = hit.path.split('/').filter(Boolean);
    const v: Record<string, string> = {};
    tpl.forEach((seg, i) => { const m = seg.match(/^:([A-Za-z0-9_]+)/); if (m && got[i]) v[m[1]!] = decodeURIComponent(got[i]!); });
    choose(r, v);
    setResult(t('rsshub.recognised', { platform: r.platform, name: r.name }));
  };

  const tryIt = async (): Promise<void> => {
    if (!path) return;
    setBusy(true); setPreview(null);
    try { setPreview(await window.pnr.previewRoute(path)); }
    finally { setBusy(false); }
  };

  const add = async (): Promise<void> => {
    if (!path || !route) return;
    setBusy(true); setResult('');
    try {
      const r = await window.pnr.addSource({ kind: 'rsshub', value: path, name: `${route.platform} · ${route.name}` });
      if (r.ok) onAdded();
      setResult(!r.ok ? (r.error ? describe(r.error) : t('catalogue.addFailed')) : r.items ? t('catalogue.added', { name: r.name, count: r.items }) : t('catalogue.addedEmpty', { name: r.name, why: describe(r.error) }));
    } catch { setResult(t('catalogue.addError')); }
    finally { setBusy(false); }
  };

  const usingInstance = Boolean(social?.instanceUrl);
  return (
    <div className="dialog-body rsshub-picker">
      {ready === false && !usingInstance && (
        <div className="pack-banner">
          <p>{t('rsshub.packBanner')}</p>
          <button className="primary" disabled={Boolean(installing)} onClick={() => void install()}>
            {installing || t('settings.downloadPack')}
          </button>
          {failed && <p className="error-text">{failed}</p>}
        </div>
      )}

      <div className="paste-row">
        <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={t('rsshub.pastePlaceholder')}
               onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void recognise(); }} />
        <button className="push" onClick={() => void recognise()} disabled={!pasted.trim()}>{t('rsshub.recognise')}</button>
      </div>

      <div className="picker-body">
        <nav className="platforms" aria-label={t('rsshub.platforms')}>
          {platforms.map((p) => (
            <button key={p} className={platform === p ? 'active' : ''} aria-pressed={platform === p} onClick={() => { setPlatform(p); setRoute(null); }}>{p}</button>
          ))}
        </nav>
        <div className="routes-pane">
          <ul className="route-list">
            {routes.filter((r) => r.platform === platform).map((r) => (
              <li key={r.id}>
                <button className={route?.id === r.id ? 'active' : ''} aria-pressed={route?.id === r.id} onClick={() => choose(r)}>
                  <strong>{r.name}</strong>
                  <small>{r.params.some((p) => !p.advanced && !p.optional) ? t('rsshub.needsInput') : t('rsshub.ready')}{r.sources.length ? t('rsshub.pasteable') : ''}</small>
                </button>
              </li>
            ))}
          </ul>

          {route && (
            <div className="route-form">
              <h4>{route.platform} · {route.name}</h4>
              {route.params.filter((p) => !p.advanced).map((p) => (
                <label key={p.key} className="field">
                  <span>{p.description.split(/[，,。]/)[0] || p.key}{p.optional ? t('rsshub.optional') : ''}</span>
                  {p.options?.length
                    ? <Select value={values[p.key] ?? ''} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}>
                        {p.optional && <option value="">{t('rsshub.default')}</option>}
                        {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    : <input value={values[p.key] ?? ''} placeholder={examples[p.key] ? t('rsshub.exampleValue', { value: examples[p.key] }) : ''}
                             onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} />}
                  {p.description && <small>{p.description}</small>}
                </label>
              ))}
              {route.sources.length > 0 && <p className="section-hint">{t('rsshub.pasteHint', { example: route.sources[0] })}</p>}
              <p className="section-hint">{t('rsshub.route')}<code>{path ?? t('rsshub.missing')}</code></p>
              <div className="form-actions">
                <button className="push" disabled={!path || busy || (ready === false && !usingInstance)} onClick={() => void tryIt()}>{busy ? t('common.pleaseWait') : t('rsshub.try')}</button>
                <button className="primary" disabled={!path || busy || (ready === false && !usingInstance)} onClick={() => void add()}>{t('common.add')}</button>
              </div>
              {preview && (preview.ok
                ? <ul className="preview-titles">{preview.titles.map((t, i) => <li key={i}>{t}</li>)}</ul>
                : <p className="error-text">{t('rsshub.tryEmpty', { why: describe(preview.reason) })}</p>)}
            </div>
          )}
        </div>
      </div>
      {result && <p role="status" className="section-hint">{result}</p>}
    </div>
  );
}
