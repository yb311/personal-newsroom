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
  contentHtml?: string;
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
}
