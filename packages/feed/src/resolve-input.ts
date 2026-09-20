import type { SourceKind } from '@pnr/core';
import { channelOf } from './adapters/telegram.ts';
import { normalizeRoute } from './adapters/rsshub.ts';

export interface ResolvedSource {
  kind: SourceKind;
  /** What goes in the source row's `url` column — a feed address for RSS, a
   *  channel name for Telegram, a route path for RSSHub, and so on. */
  url: string;
  domain: string | null;
  suggestedName: string;
}

/**
 * Works out what the user pasted.
 *
 * People have a feed address, a Telegram handle or an RSSHub route in hand and
 * should not have to know which category it falls into. Everything resolves to
 * the same source row, so the rest of the pipeline never sees the difference.
 */
export function resolveSourceInput(raw: string, hint: SourceKind | 'auto' = 'auto'): ResolvedSource | null {
  const value = raw.trim();
  if (!value) return null;

  let kind: SourceKind;
  if (hint !== 'auto') kind = hint;
  else if (/(?:^|\/\/)t\.me\//.test(value) || /^@[A-Za-z0-9_]{4,32}$/.test(value)) kind = 'telegram';
  else if (/^https?:\/\/(www\.|old\.)?reddit\.com\/r\//.test(value)) kind = 'reddit';
  else if (/^https?:\/\/(www\.)?github\.com\//.test(value)) kind = 'github';
  else if (value.startsWith('/')) kind = 'rsshub';
  else if (/^https?:\/\//.test(value) || value.includes('.')) kind = 'rss';
  // Slashes but no dot and no scheme: almost always an RSSHub route pasted
  // without its leading slash. If the guess is wrong the immediate test fetch
  // says so straight away.
  else if (value.includes('/')) kind = 'rsshub';
  else if (/^[A-Za-z0-9_]{3,32}$/.test(value)) kind = 'telegram';
  else return null;

  let url = value;
  let domain: string | null = null;
  switch (kind) {
    case 'telegram': url = channelOf(value); break;
    case 'rsshub': url = normalizeRoute(value); break;
    case 'reddit':
      url = value.replace(/^https?:\/\/(www\.|old\.)?reddit\.com/, '').replace(/^\/?r\//, '').replace(/\/.*$/, '');
      break;
    case 'github':
      url = value.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, '');
      break;
    case 'rss': {
      url = /^https?:/i.test(value) ? value : `https://${value}`;
      try { domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
      break;
    }
    default: break;
  }

  return { kind, url, domain, suggestedName: nameFor(kind, url, domain) };
}

function nameFor(kind: SourceKind, url: string, domain: string | null): string {
  switch (kind) {
    case 'telegram': return `Telegram @${url}`;
    case 'reddit': return `r/${url}`;
    case 'github': return url.includes('/') ? `${url} 发布` : `${url} 的动态`;
    case 'hackernews': return 'Hacker News';
    case 'rsshub': return url.split('/').filter(Boolean).slice(0, 2).join(' / ') || url;
    default: return domain ?? url;
  }
}
