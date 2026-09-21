import type { DiscoveredItem } from '@pnr/core';
import { cleanUrl, domainOf } from '@pnr/core';
import type { Adapter, ParseResult, SourceRecord } from './types.ts';
import { fetchFeed } from '../parse.ts';

const UA = 'personal-newsroom/0.1 (+https://github.com/yb311/personal-newsroom)';

async function getJson<T>(url: string, timeoutMs = 20_000, headers: Record<string, string> = {}): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(t); }
}

const build = (items: DiscoveredItem[], fetched: number, dropped: Record<string, number> = {}): ParseResult =>
  ({ items, diagnostics: { fetched, kept: items.length, droppedByReason: dropped } });

// ───────────────────────── Hacker News ─────────────────────────
/** Uses the Algolia index rather than the Firebase API: one request for the
 *  whole front page instead of one request per story. `url` selects the mode,
 *  e.g. "front_page" or "story". */
export const hackerNewsAdapter: Adapter = async (source) => {
  const tag = source.url.trim() || 'front_page';
  const data = await getJson<{ hits?: any[] }>(
    `https://hn.algolia.com/api/v1/search?tags=${encodeURIComponent(tag)}&hitsPerPage=50`);
  const hits = data.hits ?? [];
  const dropped: Record<string, number> = {};
  const items: DiscoveredItem[] = [];
  for (const h of hits) {
    const title = String(h.title ?? h.story_title ?? '').trim();
    const link = String(h.url ?? h.story_url ?? (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''));
    const ts = h.created_at ? Date.parse(h.created_at) : NaN;
    if (!title) { dropped['no_title'] = (dropped['no_title'] ?? 0) + 1; continue; }
    if (!link) { dropped['no_url'] = (dropped['no_url'] ?? 0) + 1; continue; }
    if (!Number.isFinite(ts)) { dropped['no_date'] = (dropped['no_date'] ?? 0) + 1; continue; }
    const clean = cleanUrl(link);
    items.push({
      title, url: clean, publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: source.name, domain: domainOf(clean) || 'news.ycombinator.com',
      ...(h.author ? { author: String(h.author) } : {}),
      snippet: `${h.points ?? 0} points · ${h.num_comments ?? 0} comments · https://news.ycombinator.com/item?id=${h.objectID}`,
      lang: 'en'
    });
  }
  return build(items, hits.length, dropped);
};

// ───────────────────────── Reddit ─────────────────────────
/**
 * Reddit's public JSON endpoints now return 403 for unauthenticated clients
 * regardless of user agent (verified 2026-09-20), but the .rss endpoint is
 * still open. So this goes through the shared RSS parser rather than the API.
 * `url` is the subreddit name or an /r/<sub> path.
 */
export const redditAdapter: Adapter = async (source) => {
  const sub = source.url
    .replace(/^https?:\/\/(www\.|old\.)?reddit\.com/, '')
    .replace(/^\/?r\//, '').replace(/\/.*$/, '').trim();
  const res = await fetchFeed({ ...source, name: source.name || `r/${sub}` },
                              { url: `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.rss?limit=50` });
  return { ...res, items: res.items.map((i) => ({ ...i, domain: i.domain || 'reddit.com' })) };
};

// ───────────────────────── GitHub ─────────────────────────
/**
 * Rising repositories: created in the last week, most-starred first, from
 * GitHub's public search API — a stable JSON endpoint that needs no key.
 * This stands in for OSS Insight's trending ranking, which its maintainers
 * marked unavailable in 2026 (their event capture fell to ~0.3% of baseline,
 * so the API now returns an empty ranking by design).
 */
async function githubRising(source: SourceRecord, language: string): Promise<ParseResult> {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const q = `created:>${since}${language ? ` language:${language}` : ''}`;
  const token = process.env['GITHUB_TOKEN'];
  const data = await getJson<{ items?: any[] }>(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`, 20_000,
    { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const items: DiscoveredItem[] = (data?.items ?? []).map((r) => ({
    title: `${r.full_name}${r.description ? ` — ${String(r.description).slice(0, 100)}` : ''}`,
    url: cleanUrl(String(r.html_url)), publishedAt: new Date(Date.parse(r.created_at)).toISOString(),
    sourceId: source.id, sourceName: source.name, domain: 'github.com',
    snippet: `★ ${r.stargazers_count}${r.language ? ` · ${r.language}` : ''}${r.description ? ` · ${r.description}` : ''}`.slice(0, 600),
    lang: 'en'
  }));
  return build(items, (data?.items ?? []).length, {});
}

/** `url` is "<user>" for public activity, "<owner>/<repo>" for releases, or
 *  "trending" / "trending:<language>" for rising repositories. */
export const githubAdapter: Adapter = async (source) => {
  const trending = source.url.match(/^trending(?::(.+))?$/i);
  if (trending) return githubRising(source, trending[1]?.trim() ?? '');
  const path = source.url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, '').trim();
  const isRepo = path.includes('/');
  const api = isRepo
    ? `https://api.github.com/repos/${path}/releases?per_page=30`
    : `https://api.github.com/users/${path}/events/public?per_page=50`;
  const token = process.env['GITHUB_TOKEN'];
  const data = await getJson<any[]>(api, 20_000, {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  });
  const dropped: Record<string, number> = {};
  const items: DiscoveredItem[] = [];
  for (const e of data ?? []) {
    let title: string, link: string, ts: number, snippet = '';
    if (isRepo) {
      title = String(e.name || e.tag_name || '').trim();
      link = String(e.html_url ?? '');
      ts = Date.parse(e.published_at ?? e.created_at ?? '');
      snippet = String(e.body ?? '').slice(0, 600);
    } else {
      const type = String(e.type ?? '').replace(/Event$/, '');
      const repo = String(e.repo?.name ?? '');
      title = `${e.actor?.login ?? path} ${type} ${repo}`.trim();
      link = repo ? `https://github.com/${repo}` : '';
      ts = Date.parse(e.created_at ?? '');
    }
    if (!title) { dropped['no_title'] = (dropped['no_title'] ?? 0) + 1; continue; }
    if (!link) { dropped['no_url'] = (dropped['no_url'] ?? 0) + 1; continue; }
    if (!Number.isFinite(ts)) { dropped['no_date'] = (dropped['no_date'] ?? 0) + 1; continue; }
    items.push({
      title, url: cleanUrl(link), publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: source.name, domain: 'github.com',
      ...(snippet ? { snippet } : {}), lang: 'en'
    });
  }
  return build(items, (data ?? []).length, dropped);
};
