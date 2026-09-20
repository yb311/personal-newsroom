import { XMLParser } from 'fast-xml-parser';
import type { DiscoveredItem, ParseResult, SourceRecord } from '@pnr/core';
import { cleanUrl, domainOf } from '@pnr/core';

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true,
  parseTagValue: false, processEntities: true
});

const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['#text'] === 'string') return o['#text'].trim();
  }
  return '';
};
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Parses RSS 2.0, Atom and RDF (RSS 1.0) into the shared DiscoveredItem shape. */
export function parseFeed(xml: string, source: SourceRecord): ParseResult {
  const dropped: Record<string, number> = {};
  const drop = (r: string): void => { dropped[r] = (dropped[r] ?? 0) + 1; };
  const items: DiscoveredItem[] = [];

  let doc: Record<string, any>;
  try { doc = parser.parse(xml) as Record<string, any>; }
  catch { return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { parse_error: 1 } } }; }

  const rss = doc['rss']?.['channel'];
  const rdf = doc['rdf:RDF'] ?? doc['RDF'];
  const atom = doc['feed'];
  const raw: any[] = rss ? asArray(rss['item']) : rdf ? asArray(rdf['item']) : atom ? asArray(atom['entry']) : [];

  for (const e of raw) {
    const title = text(e['title']);
    let url = '';
    if (typeof e['link'] === 'string') url = e['link'];
    else if (Array.isArray(e['link'])) {
      const alt = e['link'].find((l: any) => l?.['@_rel'] === 'alternate' || !l?.['@_rel']);
      url = alt?.['@_href'] ?? alt?.['#text'] ?? '';
    } else if (e['link']?.['@_href']) url = e['link']['@_href'];
    else url = text(e['link']);
    if (!url) url = text(e['guid']) || text(e['id']);

    const dateRaw = text(e['pubDate']) || text(e['published']) || text(e['updated']) || text(e['dc:date']);
    const ts = Date.parse(dateRaw);

    if (!title) { drop('no_title'); continue; }
    if (!url || !/^https?:/i.test(url)) { drop('no_url'); continue; }
    // Never fabricate a date: an item with no usable date is dropped, not backfilled with now().
    if (!Number.isFinite(ts)) { drop('no_date'); continue; }

    const clean = cleanUrl(url);
    const snippet = text(e['description']) || text(e['summary']);
    const content = text(e['content:encoded']) || text(e['content']);
    const img = e['media:content']?.['@_url'] ?? e['media:thumbnail']?.['@_url']
      ?? (String(e['enclosure']?.['@_type'] ?? '').startsWith('image/') ? e['enclosure']['@_url'] : undefined);
    const author = text(e['author']?.['name'] ?? e['dc:creator'] ?? e['author']);

    items.push({
      title, url: clean, publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: source.name, domain: domainOf(clean) || source.domain || '',
      ...(snippet ? { snippet: stripTags(snippet).slice(0, 600) } : {}),
      ...(content ? { contentHtml: content } : {}),
      ...(img ? { imageUrl: String(img) } : {}),
      ...(author ? { author } : {}),
      ...(source.lang ? { lang: source.lang } : {})
    });
  }
  return { items, diagnostics: { fetched: raw.length, kept: items.length, droppedByReason: dropped } };
}
