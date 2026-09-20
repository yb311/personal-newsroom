import { XMLParser } from 'fast-xml-parser';
import type { DiscoveredItem } from '@pnr/core';
import { cleanUrl, domainOf } from '@pnr/core';
import { fetchText } from '../transport.ts';
import type { Adapter, ParseResult, SourceRecord } from './types.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, processEntities: true });
const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string =>
  typeof v === 'string' ? v.trim()
  : v && typeof v === 'object' && typeof (v as any)['#text'] === 'string' ? String((v as any)['#text']).trim()
  : '';

/** Google News Sitemap. Used where a publisher has no usable RSS —
 *  AP (its RSS returns 401 and is robots-disallowed) and Reuters (no public RSS). */
function parseUrlset(xml: string, source: SourceRecord): ParseResult {
  const dropped: Record<string, number> = {};
  const drop = (r: string): void => { dropped[r] = (dropped[r] ?? 0) + 1; };
  const items: DiscoveredItem[] = [];
  const doc = parser.parse(xml) as any;
  const urls = asArray(doc?.urlset?.url);

  for (const u of urls) {
    const loc = txt(u?.loc);
    const news = u?.['news:news'];
    const title = txt(news?.['news:title']) || '';
    const dateRaw = txt(news?.['news:publication_date']) || txt(u?.lastmod);
    const ts = Date.parse(dateRaw);
    if (!loc) { drop('no_url'); continue; }
    if (!title) { drop('no_title'); continue; }
    if (!Number.isFinite(ts)) { drop('no_date'); continue; }
    const clean = cleanUrl(loc);
    items.push({
      title, url: clean, publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: source.name,
      domain: domainOf(clean) || source.domain || '',
      ...(source.lang ? { lang: source.lang } : {})
    });
  }
  return { items, diagnostics: { fetched: urls.length, kept: items.length, droppedByReason: dropped } };
}

export const newsSitemapAdapter: Adapter = async (source) =>
  parseUrlset(await fetchText(source.url), source);

/** Sitemap index: fetch the first N child sitemaps and merge. */
export const newsSitemapIndexAdapter: Adapter = async (source) => {
  const MAX_CHILDREN = 4;
  const doc = parser.parse(await fetchText(source.url)) as any;
  const children = asArray(doc?.sitemapindex?.sitemap)
    .map((s: any) => txt(s?.loc)).filter(Boolean).slice(0, MAX_CHILDREN);

  const results = await Promise.all(children.map(async (url) => {
    try { return parseUrlset(await fetchText(url), source); } catch { return null; }
  }));

  const items: DiscoveredItem[] = [];
  const dropped: Record<string, number> = {};
  let fetched = 0;
  for (const r of results) {
    if (!r) { dropped['child_fetch_failed'] = (dropped['child_fetch_failed'] ?? 0) + 1; continue; }
    items.push(...r.items);
    fetched += r.diagnostics.fetched;
    for (const [k, v] of Object.entries(r.diagnostics.droppedByReason)) dropped[k] = (dropped[k] ?? 0) + v;
  }
  return { items, diagnostics: { fetched, kept: items.length, droppedByReason: dropped } };
};
