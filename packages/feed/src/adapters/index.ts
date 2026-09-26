import type { SourceKind } from '@pnr/core';
import { fetchFeed } from '../parse.ts';
import type { Adapter } from './types.ts';
import { newsSitemapAdapter, newsSitemapIndexAdapter } from './sitemap.ts';
import { telegramAdapter } from './telegram.ts';
import { hackerNewsAdapter, redditAdapter, githubAdapter } from './api.ts';
import { googleNewsAdapter, bingNewsAdapter } from './search.ts';
import { gdeltAdapter } from './gdelt.ts';
import { rssHubAdapter } from './rsshub.ts';
import { apifyXAdapter } from './apify.ts';

const rssAdapter: Adapter = (source) => fetchFeed(source, { conditional: true });

/**
 * Every adapter returns the same DiscoveredItem shape, so dedupe, recall,
 * judging, extraction and ranking are written once and work for all of them.
 * Adding a source type means adding one entry here.
 */
export const adapters: Partial<Record<SourceKind, Adapter>> = {
  rss: rssAdapter,
  news_sitemap: newsSitemapAdapter,
  news_sitemap_index: newsSitemapIndexAdapter,
  telegram: telegramAdapter,
  hackernews: hackerNewsAdapter,
  reddit: redditAdapter,
  github: githubAdapter,
  googlenews: googleNewsAdapter,
  bingnews: bingNewsAdapter,
  gdelt: gdeltAdapter,
  rsshub: rssHubAdapter,
  apify_x: apifyXAdapter
};

export const adapterFor = (kind: SourceKind): Adapter | undefined => adapters[kind];
export { channelOf } from './telegram.ts';
export { rssHubMode, configureRssHub, normalizeRoute,
         type RssHubMode, type RssHubConfig } from './rsshub.ts';
export { APIFY_TOKEN_KEY } from './apify.ts';
export type { Adapter, AdapterCtx } from './types.ts';
