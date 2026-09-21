import { categoryLabel, countryLabel } from '@pnr/core/catalog-labels';
import { Dialog } from './Dialog.tsx';
import { useEffect, useState } from 'react';
import type { CatalogueResult, SourceRow } from '../types.ts';

type Tab = 'browse' | 'add';

/** Why a new source produced nothing, by the reason code it failed with. */
const SOURCE_FAILURE: Record<string, string> = {
  parse_error: '这个地址返回的不是订阅源（可能是普通网页，或被网站的防护拦截了）',
  not_found: '这个地址不存在',
  forbidden: '网站拒绝了访问',
  unauthorized: '网站要求登录',
  rate_limited: '访问太频繁，网站暂时拒绝了',
  server_error: '网站服务器出错',
  timeout: '网络超时',
  network: '网络连接失败',
  route_not_found: '这个 RSSHub 路由不存在，或参数不对',
  rsshub_not_available: '还没有安装社交平台扩展'
};
const sourceFailure = (code?: string): string =>
  code ? SOURCE_FAILURE[code] ?? (code.startsWith('instance_') ? 'RSSHub 服务没有响应' : '暂时没抓到内容') : '暂时没抓到内容';

/** Browse the built-in catalogue, or add anything the user has in mind. */
export function Catalogue({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('browse');
  return (
    <Dialog title="订阅管理" onClose={onClose}>
        <header>
          <h2>订阅源</h2>
          <nav className="tabs small">
            <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>内置目录</button>
            <button className={tab === 'add' ? 'active' : ''} onClick={() => setTab('add')}>添加链接</button>
          </nav>
          <span className="grow" />
          <button onClick={onClose}>完成</button>
        </header>
        {tab === 'browse' ? <Browse /> : <AddSource />}
    </Dialog>
  );
}

function Browse() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogueResult | null>(null);
  const rows = result?.rows ?? [];

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void window.pnr.catalogue({ q, category, country, limit: 300 }).then((r) => { if (live) setResult(r); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [q, category, country]);

  const toggle = async (s: SourceRow): Promise<void> => {
    const next = !s.enabled;
    await window.pnr.setSourceEnabled(s.id, next);
    setResult((prev) => prev && { ...prev, rows: prev.rows.map((r) => (r.id === s.id ? { ...r, enabled: next ? 1 : 0 } : r)) });
  };

  return (
    <>
      <div className="modal-search">
        <input autoFocus aria-label="搜索订阅源" placeholder="搜索媒体、分类、国家或域名，例如：国际新闻、美国、bbc" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="facets" aria-label="按分类筛选">
        <button className={category === null ? 'chip active' : 'chip'} onClick={() => setCategory(null)}>全部分类</button>
        {result?.categories.slice(0, 16).map((c) => (
          <button key={c.key} className={category === c.key ? 'chip active' : 'chip'} onClick={() => setCategory(category === c.key ? null : c.key)}>
            {categoryLabel(c.key)} <small>{c.count}</small>
          </button>
        ))}
      </div>
      {(result?.countries.length ?? 0) > 0 && (
        <div className="facets" aria-label="按国家筛选">
          <button className={country === null ? 'chip active' : 'chip'} onClick={() => setCountry(null)}>全部国家</button>
          {result!.countries.map((c) => (
            <button key={c.key} className={country === c.key ? 'chip active' : 'chip'} onClick={() => setCountry(country === c.key ? null : c.key)}>
              {countryLabel(c.key)} <small>{c.count}</small>
            </button>
          ))}
        </div>
      )}
      <p className="modal-note">找到 {rows.length} 个，其中已订阅 {rows.filter((r) => r.enabled).length} 个。</p>
      <ul className="catalogue">
        {rows.length === 0 && <li className="empty-block">没有找到订阅源，试试其他关键词。</li>}
        {rows.map((s) => (
          <li key={s.id}>
            <label>
              <input type="checkbox" checked={Boolean(s.enabled)} onChange={() => void toggle(s)} />
              <span className="name">{s.name}</span>
              <span className="tag">{categoryLabel(s.category)}</span>
              {s.country && <span className="tag country">{countryLabel(s.country)}</span>}
              <span className="domain">{s.domain}</span>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}

const KINDS: { id: string; label: string; hint: string; example: string }[] = [
  { id: 'auto',       label: '自动识别',  hint: '粘贴订阅链接或频道名，自动识别类型', example: 'https://example.com/feed 或 @durov' },
  { id: 'rss',        label: 'RSS 地址',  hint: '任何 RSS / Atom 地址',        example: 'https://www.theverge.com/rss/index.xml' },
  { id: 'telegram',   label: 'Telegram', hint: '公开频道，不需要登录',         example: 'durov 或 https://t.me/durov' },
  { id: 'reddit',     label: 'Reddit',   hint: '子版名',                       example: 'worldnews' },
  { id: 'hackernews', label: 'Hacker News', hint: '首页热门',                  example: 'front_page' },
  { id: 'github',     label: 'GitHub',   hint: '用户动态，或 owner/repo 的发布', example: 'torvalds 或 nodejs/node' },
  { id: 'rsshub',     label: 'RSSHub 路由', hint: '微博、B站、知乎、小红书等',   example: '/bilibili/popular/all' }
];

function AddSource() {
  const [kind, setKind] = useState('auto');
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [routes, setRoutes] = useState<{ label: string; route: string; note?: string }[]>([]);
  const [rssHub, setRssHub] = useState<boolean | null>(null);

  useEffect(() => {
    void window.pnr.suggestedRoutes().then((r) => setRoutes(r as typeof routes));
    void window.pnr.rssHubReady().then(setRssHub);
  }, []);

  const submit = async (): Promise<void> => {
    if (!value.trim() || busy) return;
    setBusy(true); setResult(null);
    try {
    const r = await window.pnr.addSource({ kind, value, ...(name.trim() ? { name: name.trim() } : {}) });
    if (!r.ok) setResult({ ok: false, text: r.error ?? '添加失败' });
    else if (r.items === 0) setResult({ ok: false, text: `已添加「${r.name}」，但${sourceFailure(r.error)}` });
    else { setResult({ ok: true, text: `已添加「${r.name}」，抓到 ${r.items} 条` }); setValue(''); setName(''); }
    } catch { setResult({ ok: false, text: '未能添加订阅，请重试。' }); }
    finally { setBusy(false); }
  };

  const active = KINDS.find((k) => k.id === kind)!;

  return (
    <div className="add-source">
      <div className="kind-picker">
        {KINDS.map((k) => (
          <button key={k.id} className={kind === k.id ? 'active' : ''} onClick={() => setKind(k.id)}>{k.label}</button>
        ))}
      </div>
      <p className="muted">{active.hint}　例：<code>{active.example}</code></p>

      <div className="new-watch">
        <input aria-label="订阅名称（选填）" placeholder="名称（选填）" value={name} onChange={(e) => setName(e.target.value)} />
        <input autoFocus aria-label="订阅地址或频道" placeholder={active.example} value={value}
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit(); }} />
        <button className="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {busy ? '正在验证…' : '添加'}
        </button>
      </div>

      {result && <p role="status" className={result.ok ? 'muted ok' : 'muted warn'}>{result.text}</p>}

      {kind === 'rsshub' && (
        <div className="routes">
          {rssHub === false && (
            <p className="muted warn">
              这台机器上还没有 RSSHub，这类源暂时用不了。
            </p>
          )}
          <p className="muted">常用路由，点一下填进去：</p>
          <ul>
            {routes.map((r) => (
              <li key={r.route}>
                <button className="chip" onClick={() => setValue(r.route)}>{r.label}</button>
                <code>{r.route}</code>
                {r.note && <span className="muted warn"> · {r.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {kind === 'telegram' && (
        <p className="muted">
          公开频道不需要登录、不需要 API key。少数频道关掉了网页预览，那种目前抓不到。
        </p>
      )}
    </div>
  );
}
