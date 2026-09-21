import type { DiscoveredItem } from '@pnr/core';
import { cleanHtml } from '@pnr/reader-core';
import type { Adapter, ParseResult, SourceRecord } from './types.ts';

/**
 * Reads a public Telegram channel through its web preview.
 *
 * Verified (docs/SPIKES.zh-CN.md §5): t.me/s/<channel> needs no login, no API
 * key and no proxy, returns 20 messages per page and supports ?before= paging.
 * Implemented here rather than via RSSHub so the highest-value social source
 * does not depend on an external process.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export async function parseTelegram(html: string, source: SourceRecord, channel: string): Promise<ParseResult> {
  const dropped: Record<string, number> = {};
  const drop = (r: string): void => { dropped[r] = (dropped[r] ?? 0) + 1; };

  const posts: { url: string; ts: number; html: string; photo?: string }[] = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const idM = b.match(/data-post="([^"]+)"/);
    const timeM = b.match(/datetime="([^"]+)"/);
    const textM = b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!idM?.[1]) { drop('no_id'); continue; }
    const ts = Date.parse(timeM?.[1] ?? '');
    if (!Number.isFinite(ts)) { drop('no_date'); continue; }
    if (!textM?.[1]) { drop('no_text'); continue; }   // media-only posts
    const photo = b.match(/background-image:url\('([^']+)'\)/)?.[1];
    posts.push({ url: `https://t.me/${idM[1]}`, ts, html: textM[1], ...(photo ? { photo } : {}) });
  }

  // A post has no headline, so its first line serves as one. The reader core
  // turns the post's markup into text the same way it does for every feed.
  const cleaned = await cleanHtml(posts.map((p) => ({ baseUrl: p.url, html: p.html })));
  const items: DiscoveredItem[] = [];
  posts.forEach((p, i) => {
    const c = cleaned[i]!;
    if (!c.text) { drop('no_text'); return; }
    items.push({
      title: c.text.split('\n')[0]!.slice(0, 120), url: p.url, publishedAt: new Date(p.ts).toISOString(),
      sourceId: source.id, sourceName: source.name || `Telegram @${channel}`,
      domain: 't.me',
      snippet: c.text.replace(/\n/g, ' ').slice(0, 600),
      contentHtml: c.html, contentText: c.text, words: c.words,
      ...(p.photo ? { imageUrl: p.photo } : {}),
      ...(source.lang ? { lang: source.lang } : {})
    });
  });
  return { items, diagnostics: { fetched: blocks.length, kept: items.length, droppedByReason: dropped } };
}

/** `url` may be a bare channel name, t.me/name, or t.me/s/name. */
export function channelOf(url: string): string {
  const m = url.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]+)/);
  return m?.[1] ?? url.replace(/^@/, '').trim();
}

export const telegramAdapter: Adapter = async (source) => {
  const channel = channelOf(source.url);
  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return parseTelegram(await res.text(), source, channel);
};
