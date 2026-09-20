import type { DiscoveredItem } from '@pnr/core';
import { domainOf } from '@pnr/core';
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

const decode = (s: string): string =>
  s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
   .replace(/[ \t]+/g, ' ').trim();

export function parseTelegram(html: string, source: SourceRecord, channel: string): ParseResult {
  const dropped: Record<string, number> = {};
  const drop = (r: string): void => { dropped[r] = (dropped[r] ?? 0) + 1; };
  const items: DiscoveredItem[] = [];

  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const idM = b.match(/data-post="([^"]+)"/);
    const timeM = b.match(/datetime="([^"]+)"/);
    const textM = b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!idM?.[1]) { drop('no_id'); continue; }
    if (!timeM?.[1]) { drop('no_date'); continue; }
    const ts = Date.parse(timeM[1]);
    if (!Number.isFinite(ts)) { drop('no_date'); continue; }
    const body = textM?.[1] ? decode(textM[1]) : '';
    if (!body) { drop('no_text'); continue; }   // media-only posts

    const url = `https://t.me/${idM[1]}`;
    const title = body.split('\n')[0]!.slice(0, 120) || body.slice(0, 120);
    const photo = b.match(/background-image:url\('([^']+)'\)/);
    items.push({
      title, url, publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: source.name || `Telegram @${channel}`,
      domain: 't.me',
      snippet: body.slice(0, 600),
      ...(photo?.[1] ? { imageUrl: photo[1] } : {}),
      ...(source.lang ? { lang: source.lang } : {})
    });
  }
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
