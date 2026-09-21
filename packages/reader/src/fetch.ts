import { download, DownloadError, ACCEPT_PAGE, type Downloaded } from '@pnr/core';

/** Publishers that reliably serve a paywall interstitial instead of the article.
 *  Ported from daily-brief; they still contribute feed snippets and images. */
export const PAYWALLED = new Set([
  'bloomberg.com', 'nytimes.com', 'wsj.com', 'ft.com', 'washingtonpost.com',
  'latimes.com', 'politico.com', 'economist.com', 'news.google.com'
]);

export type FetchTier = 'direct' | 'jina' | 'firecrawl';

/**
 * Downloads an article page. The direct request is the only one made unless
 * the user has supplied a key for a fetching service: without one, nothing is
 * sent to a third party. Ported from daily-brief lib/feed/multi-layer-fetch.ts.
 */
export async function fetchPage(url: string, timeoutMs = 25_000): Promise<Downloaded & { tier: FetchTier }> {
  try {
    return { ...(await download(url, { accept: ACCEPT_PAGE, timeoutMs })), tier: 'direct' };
  } catch (direct) {
    const jinaKey = process.env['JINA_API_KEY'];
    if (jinaKey) {
      try {
        const d = await download(`https://r.jina.ai/${url}`, {
          timeoutMs, headers: { 'x-return-format': 'html', authorization: `Bearer ${jinaKey}` }
        });
        return { ...d, url, tier: 'jina' };
      } catch { /* fall through */ }
    }

    const fcKey = process.env['FIRECRAWL_API_KEY'];
    if (fcKey) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${fcKey}` },
          body: JSON.stringify({ url, formats: ['html'] })
        });
        const j = res.ok ? ((await res.json()) as { data?: { html?: string } }) : null;
        if (j?.data?.html) {
          return { body: new TextEncoder().encode(j.data.html), contentType: 'text/html; charset=utf-8',
                   url, etag: null, lastModified: null, notModified: false, tier: 'firecrawl' };
        }
      } catch { /* fall through */ } finally { clearTimeout(t); }
    }
    throw direct instanceof DownloadError ? direct : new DownloadError('network');
  }
}
