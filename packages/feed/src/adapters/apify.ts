import type { DiscoveredItem } from '@pnr/core';
import { cleanUrl } from '@pnr/core';
import type { Adapter } from './types.ts';
import { emptyResult } from './types.ts';

/**
 * X (Twitter) through Apify's Tweet Scraper (apidojo/tweet-scraper).
 *
 * X has no free API and RSSHub's X routes need a logged-in cookie, so this is
 * the paid, dependable path the architecture document chose. The person
 * supplies their own Apify token (Settings → 扩展订阅); without one the source
 * reports `apify_no_token` instead of failing silently. The actor bills per
 * tweet with a 50-tweet minimum per query — about US$0.02 per fetch.
 *
 * `url` is a handle ("@name" or "name") or "search:<query>" using X's search
 * syntax.
 */
const ACTOR = 'apidojo~tweet-scraper';
export const APIFY_TOKEN_KEY = 'apify.token';

interface Tweet {
  id?: string; url?: string; text?: string; createdAt?: string; lang?: string;
  author?: { userName?: string; name?: string };
}

export const apifyXAdapter: Adapter = async (source, ctx) => {
  const token = (ctx.db?.prepare('SELECT value FROM settings WHERE key = ?').get(APIFY_TOKEN_KEY) as { value: string } | undefined)?.value
    ?? process.env['APIFY_TOKEN'];
  if (!token) return emptyResult('apify_no_token');

  const target = source.url.trim();
  const search = target.match(/^search:(.+)$/i)?.[1]?.trim();
  const handle = target.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0]!;
  const input = { ...(search ? { searchTerms: [search] } : { twitterHandles: [handle] }), maxItems: 50, sort: 'Latest' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  let tweets: Tweet[];
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    });
    if (res.status === 401 || res.status === 403) return emptyResult('apify_bad_token');
    if (res.status === 402) return emptyResult('apify_no_credit');
    if (!res.ok) return emptyResult('upstream_error');
    tweets = (await res.json()) as Tweet[];
  } catch { return emptyResult(ctl.signal.aborted ? 'timeout' : 'network'); }
  finally { clearTimeout(timer); }

  const dropped: Record<string, number> = {};
  const items: DiscoveredItem[] = [];
  for (const t of Array.isArray(tweets) ? tweets : []) {
    const text = String(t.text ?? '').trim();
    const ts = Date.parse(t.createdAt ?? '');
    if (!t.url || !text) { dropped['no_text'] = (dropped['no_text'] ?? 0) + 1; continue; }
    if (!Number.isFinite(ts)) { dropped['no_date'] = (dropped['no_date'] ?? 0) + 1; continue; }
    items.push({
      title: text.split('\n')[0]!.slice(0, 120), url: cleanUrl(t.url), publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: source.name || `X @${t.author?.userName ?? handle}`, domain: 'x.com',
      snippet: text.slice(0, 600), ...(t.author?.userName ? { author: `@${t.author.userName}` } : {}),
      ...(t.lang ? { lang: t.lang } : source.lang ? { lang: source.lang } : {})
    });
  }
  return { items, diagnostics: { fetched: Array.isArray(tweets) ? tweets.length : 0, kept: items.length, droppedByReason: dropped } };
};
