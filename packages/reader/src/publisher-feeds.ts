import { download, ACCEPT_FEED, canonicalDedupKey, cleanUrl, domainOf, log } from '@pnr/core';
import { parseFeed, type CoreItem } from '@pnr/reader-core';

/**
 * Full-text feeds that publishers syndicate to partners, for sites whose
 * article pages turn the reader away. The article comes from the publisher's
 * own feed instead of its page; nothing is done to get past the block.
 *
 * reuters.com: DataDome answers every article page with 401 and a CAPTCHA once
 * it has flagged the connection — a real Chromium window included (checked
 * 2026-10-12) — while the outbound feeds on the same site stay open. The MSN
 * feed carries the full text of the latest 100 stories (about 12 hours; it
 * does not page). The sitemap stays the discovery source because it reaches
 * further back; this only supplies bodies.
 */
const FULL_TEXT_FEEDS: Record<string, string> = {
  'reuters.com': 'https://www.reuters.com/arc/outboundfeeds/msn/?outputType=xml'
};

/** One download serves every item from the site for this long; a failed
 *  download is remembered as long, so a run never asks twice. */
const TTL_MS = 10 * 60_000;

/** Reuters' wire links survive as `[USN:L1N45V0MW TEXT:"supply diesel"]`
 *  (quotes escaped as `&#34;` in the cleaned HTML); only the quoted words
 *  belong in the article. */
const wireLinks = (s: string): string =>
  s.replace(/\[USN:[^\]\s]+ TEXT:(?:"|&#34;|&quot;)(.*?)(?:"|&#34;|&quot;)\]/g, '$1');

const cache = new Map<string, { at: number; items: Promise<Map<string, CoreItem>> }>();

async function load(site: string, feed: string): Promise<Map<string, CoreItem>> {
  const out = new Map<string, CoreItem>();
  try {
    const d = await download(feed, { accept: ACCEPT_FEED });
    const parsed = await parseFeed(d.url, 'feed', d.body);
    for (const i of parsed.items) {
      if (!i.contentHtml) continue;
      out.set(canonicalDedupKey(cleanUrl(i.url)), {
        ...i, contentHtml: wireLinks(i.contentHtml), contentText: wireLinks(i.contentText ?? '')
      });
    }
    log({ event: 'reader.publisher_feed', phase: 'completed', entityId: site, attrs: { items: out.size } });
  } catch (e) {
    log({ event: 'reader.publisher_feed', phase: 'failed', entityId: site,
          reasonCode: (e as { reason?: string }).reason ?? 'error' });
  }
  return out;
}

export const hasPublisherFeed = (url: string): boolean => domainOf(url) in FULL_TEXT_FEEDS;

/** The item as the publisher's full-text feed carries it, or null when the
 *  site has no such feed or the item has dropped out of it. */
export async function publisherFeedItem(url: string): Promise<CoreItem | null> {
  const site = domainOf(url);
  const feed = FULL_TEXT_FEEDS[site];
  if (!feed) return null;
  let entry = cache.get(site);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    entry = { at: Date.now(), items: load(site, feed) };
    cache.set(site, entry);
  }
  return (await entry.items).get(canonicalDedupKey(url)) ?? null;
}
