import type { DiscoveredItem } from '@pnr/core';
import { fetchText } from '../transport.ts';
import { parseFeed } from '../parsers/rss.ts';
import type { Adapter, ParseResult, SourceRecord } from './types.ts';

/**
 * Search-backed discovery (the R3 layer). These return real article URLs that
 * go through normal local fetching and verification, exactly like an RSS source
 * — unlike Google Search grounding, which returns the model's retelling.
 *
 * For these sources, `url` holds the QUERY, not an address.
 */

/** Google News search RSS. Primary R3 source: free, no key, ~100 results per
 *  query, and measured at 8 back-to-back queries with no throttling
 *  (docs/SPIKES.zh-CN.md §3). hl/gl/ceid carry the per-watch output language. */
export const googleNewsAdapter: Adapter = async (source) => {
  const q = source.url.trim();
  if (!q) return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { empty_query: 1 } } };
  const lang = source.lang ?? 'en-US';
  const country = source.country ?? (lang.split('-')[1] ?? 'US');
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}`
    + `&hl=${encodeURIComponent(lang)}&gl=${encodeURIComponent(country)}&ceid=${encodeURIComponent(`${country}:${lang.split('-')[0]}`)}`;
  const res = parseFeed(await fetchText(url), source);
  return { ...res, items: res.items.map(splitPublisher) };
};

/** Google News appends " - Publisher" to every headline. Recover the publisher
 *  so the item is attributed to the outlet, not to Google. */
function splitPublisher(item: DiscoveredItem): DiscoveredItem {
  const m = item.title.match(/^(.*?)\s+-\s+([^-]{2,40})$/);
  if (!m?.[1] || !m[2]) return item;
  return { ...item, title: m[1].trim(), sourceName: m[2].trim() };
}

/** Bing News search RSS. Thinner (about 5 results) but useful for probing
 *  whether one specific outlet published today — the way daily-brief uses it. */
export const bingNewsAdapter: Adapter = async (source) => {
  const q = source.url.trim();
  if (!q) return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { empty_query: 1 } } };
  return parseFeed(await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`), source);
};

/** Builds the Bing site-scoped probe daily-brief uses when a feed goes stale. */
export const siteProbeQuery = (domain: string): string => `site:${domain} when:1d`;
