/** HTTP layer for feed fetching. Browser-like headers because several
 *  publishers reject default Node user agents (ported from daily-brief). */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const FEED_HEADERS = {
  'user-agent': UA,
  accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  'accept-language': 'en-US,en;q=0.9'
} as const;

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: FEED_HEADERS });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}
