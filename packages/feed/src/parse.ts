import type { DiscoveredItem, ParseResult, SourceRecord } from '@pnr/core';
import { download, ACCEPT_FEED, cleanUrl, domainOf } from '@pnr/core';
import { parseFeed as parseWithCore, type CoreItem } from '@pnr/reader-core';

export interface FetchFeedOptions {
  /** "feed" covers RSS, Atom, RDF and JSON Feed; the format is detected from the body. */
  kind?: 'feed' | 'sitemap' | 'sitemap_index';
  /** Address to download when it differs from the source's own url (search queries, RSSHub routes). */
  url?: string;
  /**
   * Keep items that carry no date, stamped with the time they were seen and
   * flagged `publishedAtEstimated`. Off by default: a feed is expected to date
   * its items. On for sources that genuinely publish undated items (several
   * RSSHub routes), where dropping them would discard the whole source.
   */
  allowEstimatedDate?: boolean;
  /** Send the source's stored ETag/Last-Modified and return new ones. */
  conditional?: boolean;
  timeoutMs?: number;
}

/** A sitemap index lists child sitemaps; the reader core returns the newest few. */
async function childSitemaps(children: string[]): Promise<{ items: CoreItem[]; fetched: number; dropped: Record<string, number> }> {
  const parts = await Promise.all(children.map(async (url) => {
    try {
      const d = await download(url, { accept: ACCEPT_FEED });
      return await parseWithCore(d.url, 'sitemap', d.body);
    } catch { return null; }
  }));
  const out = { items: [] as CoreItem[], fetched: 0, dropped: {} as Record<string, number> };
  for (const p of parts) {
    if (!p) { out.dropped['child_fetch_failed'] = (out.dropped['child_fetch_failed'] ?? 0) + 1; continue; }
    out.items.push(...p.items);
    out.fetched += p.fetched;
    for (const [k, v] of Object.entries(p.dropped)) out.dropped[k] = (out.dropped[k] ?? 0) + v;
  }
  return out;
}

/**
 * Downloads a feed or news sitemap and parses it with the reader core, which
 * handles charsets, entity decoding (including double-escaped titles) and
 * sanitising any full text the feed carries.
 */
export async function fetchFeed(source: SourceRecord, opts: FetchFeedOptions = {}): Promise<ParseResult> {
  const kind = opts.kind ?? 'feed';
  const d = await download(opts.url ?? source.url, {
    accept: ACCEPT_FEED,
    ...(opts.conditional ? { etag: source.etag ?? null, lastModified: source.lastModified ?? null } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
  });
  const cache = opts.conditional ? { cache: { etag: d.etag, lastModified: d.lastModified } } : {};
  if (d.notModified) {
    return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { not_modified: 1 } }, notModified: true, ...cache };
  }

  let parsed = await parseWithCore(d.url, kind, d.body);
  if (kind === 'sitemap_index') parsed = { ...parsed, ...(await childSitemaps(parsed.children ?? [])) };

  const dropped = { ...parsed.dropped };
  const items: DiscoveredItem[] = [];
  for (const i of parsed.items) {
    // The date is never fabricated. Without one the item is dropped, unless
    // the caller opted into keeping it as a labelled discovery time.
    if (i.dateEstimated && !opts.allowEstimatedDate) { dropped['no_date'] = (dropped['no_date'] ?? 0) + 1; continue; }
    const url = cleanUrl(i.url);
    items.push({
      title: i.title, url, publishedAt: i.publishedAt,
      ...(i.dateEstimated ? { publishedAtEstimated: true } : {}),
      sourceId: source.id, sourceName: source.name,
      domain: domainOf(url) || source.domain || '',
      ...(i.summary ? { snippet: i.summary } : {}),
      ...(i.contentHtml ? { contentHtml: i.contentHtml, contentText: i.contentText ?? '', words: i.words } : {}),
      ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
      ...(i.author ? { author: i.author } : {}),
      ...(i.lang || source.lang ? { lang: i.lang || source.lang! } : {})
    });
  }
  return { items, diagnostics: { fetched: parsed.fetched, kept: items.length, droppedByReason: dropped }, ...cache };
}
