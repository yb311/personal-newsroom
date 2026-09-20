/** Three-tier article fetch, ported from daily-brief lib/feed/multi-layer-fetch.ts.
 *  Each tier only fires when the previous one failed. Tiers 2 and 3 are optional
 *  and depend on user-supplied keys. */
export type FetchTier = 'direct' | 'jina' | 'firecrawl';
export interface FetchedHtml { html: string; tier: FetchTier }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** Publishers that reliably serve a paywall interstitial instead of the article.
 *  Ported from daily-brief; they still contribute feed snippets and images. */
export const PAYWALLED = new Set([
  'bloomberg.com', 'nytimes.com', 'wsj.com', 'ft.com', 'washingtonpost.com',
  'latimes.com', 'politico.com', 'economist.com', 'news.google.com'
]);

async function get(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, ...headers } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

export async function fetchArticleHtml(url: string, timeoutMs = 25_000): Promise<FetchedHtml> {
  try {
    return { html: await get(url, timeoutMs, {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9'
    }), tier: 'direct' };
  } catch (direct) {
    const jinaKey = process.env['JINA_API_KEY'];
    try {
      return { html: await get(`https://r.jina.ai/${url}`, timeoutMs, {
        'x-return-format': 'html', ...(jinaKey ? { authorization: `Bearer ${jinaKey}` } : {})
      }), tier: 'jina' };
    } catch { /* fall through */ }

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
        if (res.ok) {
          const j = (await res.json()) as { data?: { html?: string } };
          if (j.data?.html) return { html: j.data.html, tier: 'firecrawl' };
        }
      } catch { /* fall through */ } finally { clearTimeout(t); }
    }
    throw direct;
  }
}
