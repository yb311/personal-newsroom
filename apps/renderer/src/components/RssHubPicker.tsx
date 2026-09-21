import { useEffect, useMemo, useState } from 'react';
import type { CuratedRoute, SocialStatus } from '../types.ts';

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
export function RssHubPicker({ describe }: { describe: (reason?: string) => string }) {
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

  useEffect(() => {
    void window.pnr.rsshubRoutes().then((r) => { setRoutes(r); setPlatform(r[0]?.platform ?? null); });
    void window.pnr.rssHubReady().then(setReady);
    void window.pnr.socialStatus().then(setSocial);
    return window.pnr.onSocialProgress((p) => {
      const x = p as { phase: string; received?: number; total?: number };
      setInstalling(x.phase === 'downloading' && x.total ? `下载中 ${Math.round((x.received! / x.total) * 100)}%`
        : x.phase === 'verifying' ? '校验中…' : x.phase === 'extracting' ? '解压中…' : '');
    });
  }, []);

  const platforms = useMemo(() => [...new Set(routes.map((r) => r.platform))], [routes]);
  const choose = (r: CuratedRoute, preset?: Record<string, string>): void => {
    setRoute(r); setValues(preset ?? {}); setPreview(null); setResult('');
  };
  const path = route ? fill(route, values) : null;
  const examples = route ? exampleValues(route) : {};

  const install = async (): Promise<void> => {
    setInstalling('准备中…');
    const r = await window.pnr.socialInstall().catch(() => ({ ok: false, error: undefined }));
    setInstalling(r.ok ? '' : `失败：${r.error ?? '请重试'}`);
    setReady(await window.pnr.rssHubReady());
    setSocial(await window.pnr.socialStatus());
  };

  const recognise = async (): Promise<void> => {
    const hit = await window.pnr.matchRoute(pasted);
    const r = hit ? routes.find((x) => x.id === hit.routeId) : null;
    if (!hit || !r) { setResult('没认出这个地址。可以在下面按平台挑选，或到「添加链接」里手动填路由。'); return; }
    setPlatform(r.platform);
    // Recover the values from the matched path so the form shows them.
    const tpl = r.path.split('/').filter(Boolean);
    const got = hit.path.split('/').filter(Boolean);
    const v: Record<string, string> = {};
    tpl.forEach((seg, i) => { const m = seg.match(/^:([A-Za-z0-9_]+)/); if (m && got[i]) v[m[1]!] = decodeURIComponent(got[i]!); });
    choose(r, v);
    setResult(`认出来了：${r.platform} · ${r.name}`);
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
      setResult(!r.ok ? r.error ?? '添加失败' : r.items ? `已添加「${r.name}」，抓到 ${r.items} 条` : `已添加「${r.name}」，但${describe(r.error)}`);
    } catch { setResult('未能添加，请重试。'); }
    finally { setBusy(false); }
  };

  const usingInstance = Boolean(social?.instanceUrl);
  return (
    <div className="rsshub-picker">
      {ready === false && !usingInstance && (
        <div className="pack-banner">
          <p>社交平台订阅由 RSSHub 提供，需要先下载扩展（约 63 MB，安装后约 370 MB，放在本机，可随时移除）。</p>
          <button className="primary" disabled={Boolean(installing) && !installing.startsWith('失败')} onClick={() => void install()}>
            {installing && !installing.startsWith('失败') ? installing : '下载扩展'}
          </button>
          {installing.startsWith('失败') && <p className="muted warn">{installing}</p>}
        </div>
      )}

      <div className="paste-row">
        <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="粘贴网页地址，例如少数派作者主页、即刻圈子、小宇宙播客页"
               onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void recognise(); }} />
        <button onClick={() => void recognise()} disabled={!pasted.trim()}>识别</button>
      </div>

      <div className="picker-body">
        <nav className="platforms" aria-label="平台">
          {platforms.map((p) => (
            <button key={p} className={platform === p ? 'active' : ''} onClick={() => { setPlatform(p); setRoute(null); }}>{p}</button>
          ))}
        </nav>
        <div className="routes-pane">
          <ul className="route-list">
            {routes.filter((r) => r.platform === platform).map((r) => (
              <li key={r.id}>
                <button className={route?.id === r.id ? 'active' : ''} onClick={() => choose(r)}>
                  <strong>{r.name}</strong>
                  <small>{r.params.some((p) => !p.advanced && !p.optional) ? '需要填写' : '直接可用'}{r.sources.length ? ' · 可粘贴网址' : ''}</small>
                </button>
              </li>
            ))}
          </ul>

          {route && (
            <div className="route-form">
              <h4>{route.platform} · {route.name}</h4>
              {route.params.filter((p) => !p.advanced).map((p) => (
                <label key={p.key} className="field">
                  <span>{p.description.split(/[，,。]/)[0] || p.key}{p.optional ? '（选填）' : ''}</span>
                  {p.options?.length
                    ? <select value={values[p.key] ?? p.default ?? ''} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}>
                        {p.optional && <option value="">默认</option>}
                        {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    : <input value={values[p.key] ?? ''} placeholder={examples[p.key] ? `例如 ${examples[p.key]}` : ''}
                             onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} />}
                  {p.description && <small className="muted">{p.description}</small>}
                </label>
              ))}
              {route.sources.length > 0 && <p className="muted small">也可以直接把对应页面的网址粘贴到上面识别，例如：{route.sources[0]}</p>}
              <p className="muted small">路由：<code>{path ?? '（还差必填项）'}</code></p>
              <div className="dialog-actions">
                <button disabled={!path || busy || (ready === false && !usingInstance)} onClick={() => void tryIt()}>{busy ? '请稍候…' : '试抓'}</button>
                <button className="primary" disabled={!path || busy || (ready === false && !usingInstance)} onClick={() => void add()}>添加</button>
              </div>
              {preview && (preview.ok
                ? <ul className="preview-titles">{preview.titles.map((t, i) => <li key={i}>{t}</li>)}</ul>
                : <p className="muted warn">试抓没有结果：{describe(preview.reason)}</p>)}
            </div>
          )}
        </div>
      </div>
      {result && <p role="status" className="muted">{result}</p>}
    </div>
  );
}
