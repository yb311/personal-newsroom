import { fetchFeed } from '../parse.ts';
import type { Adapter } from './types.ts';

/** Google News Sitemap. Used where a publisher has no usable RSS —
 *  AP (its RSS returns 401 and is robots-disallowed) and Reuters (no public RSS). */
export const newsSitemapAdapter: Adapter = (source) =>
  fetchFeed(source, { kind: 'sitemap', conditional: true });

/** Sitemap index: the newest few child sitemaps, merged. */
export const newsSitemapIndexAdapter: Adapter = (source) =>
  fetchFeed(source, { kind: 'sitemap_index', conditional: true });
