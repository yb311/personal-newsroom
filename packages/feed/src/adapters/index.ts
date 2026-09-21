import type { SourceKind } from '@pnr/core';
import { fetchFeed } from '../parse.ts';
import type { Adapter, AdapterRegistry, AdapterCtx } from './types.ts';
import { newsSitemapAdapter, newsSitemapIndexAdapter } from './sitemap.ts';
import { telegramAdapter } from './telegram.ts';
import { hackerNewsAdapter, redditAdapter, githubAdapter } from './api.ts';
import { googleNewsAdapter, bingNewsAdapter } from './search.ts';
import { gdeltAdapter } from './gdelt.ts';
import { rssHubAdapter } from './rsshub.ts';

const rssAdapter: Adapter = (source) => fetchFeed(source, { conditional: true });

/**
 * Every adapter returns the same DiscoveredItem shape, so dedupe, recall,
 * judging, extraction and ranking are written once and work for all of them.
 * Adding a source type means adding one entry here.
 */
export const adapters: AdapterRegistry = {
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
  rsshub: rssHubAdapter
};

export const adapterFor = (kind: SourceKind): Adapter | undefined => adapters[kind];
export { siteProbeQuery } from './search.ts';
export { channelOf } from './telegram.ts';
export { rssHubAvailable, rssHubMode, configureRssHub, normalizeRoute, SUGGESTED_ROUTES,
         type RssHubMode, type RssHubConfig } from './rsshub.ts';
export type { Adapter, AdapterCtx, AdapterRegistry } from './types.ts';
