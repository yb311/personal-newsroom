/**
 * The universal contract every source adapter produces, ported from
 * daily-brief lib/feed/parsers/types.ts.
 *
 * Invariants enforced by adapters, not by consumers:
 *  - publishedAt is a real date taken from the source. Never fabricated. When
 *    the upstream has no date at all, the item may carry the discovery time
 *    with `publishedAtEstimated`, which the UI surfaces as "发现于".
 *  - url has tracking parameters stripped.
 *  - title is non-empty.
 *
 * Because every adapter — RSS, sitemap, RSSHub, Telegram, Hacker News, Reddit,
 * GitHub, GDELT, Google News — emits this same shape, everything downstream
 * (dedupe, recall, judging, extraction, ranking) is written once.
 */
export interface DiscoveredItem {
  title: string;
  url: string;
  publishedAt: string;      // ISO 8601
  /** True when the upstream gave no date and this is the time we first saw it.
   *  The date is still never invented — it is labelled as a discovery time. */
  publishedAtEstimated?: boolean;
  sourceId: string;
  sourceName: string;
  domain: string;
  snippet?: string;
  /** Body HTML carried by the source itself. Raw from adapters that read JSON
   *  or HTML; already sanitised when `contentText` is set (the reader core). */
  contentHtml?: string;
  contentText?: string;
  /** Word count of contentText (CJK characters count one each). */
  words?: number;
  imageUrl?: string;
  author?: string;
  lang?: string;
}

export interface ParseDiagnostics {
  fetched: number;
  kept: number;
  droppedByReason: Record<string, number>;
}

export interface ParseResult {
  items: DiscoveredItem[];
  diagnostics: ParseDiagnostics;
  /** HTTP cache validators to send next time, so an unchanged feed is not re-downloaded. */
  cache?: { etag: string | null; lastModified: string | null };
  /** The server said nothing changed since last time. */
  notModified?: boolean;
}

export type SourceKind =
  | 'rss' | 'news_sitemap' | 'news_sitemap_index'
  | 'rsshub' | 'telegram' | 'hackernews' | 'reddit' | 'github'
  | 'gdelt' | 'googlenews' | 'bingnews' | 'apify_x';

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  name: string;
  domain: string | null;
  url: string;
  category: string | null;
  lang: string | null;
  country: string | null;
  trust: number;
  enabled: number;
  dateHydration: 'article_html' | null;
  configJson: string | null;
  etag?: string | null;
  lastModified?: string | null;
}
