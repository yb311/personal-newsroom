import type { Db } from '@pnr/store';
import { categoryLabel } from '@pnr/core/catalog-labels';
import { normalizeRoute } from './adapters/rsshub.ts';

export interface OpmlResult {
  xml: string;
  /** Feeds written. */
  count: number;
  /** Subscribed sources another reader cannot open (sitemaps, APIs, RSSHub routes with no instance of the person's own). */
  skipped: number;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The subscribed sources as OPML, the file every feed reader imports, grouped
 * by category.
 *
 * Only addresses another reader can fetch go in: plain feeds, and RSSHub
 * routes when the person runs their own instance (its address is then the
 * feed's). Routes served from the downloaded pack, news sitemaps and the API
 * adapters exist only inside this app; they are counted, not written as links
 * that would fail elsewhere. No public RSSHub instance is filled in for them —
 * that would send what someone reads to a stranger's server.
 */
export function buildOpml(db: Db, opts: { title: string; lang: string; rssHubInstance?: string | null }): OpmlResult {
  const rows = db.prepare(`SELECT kind, name, url, domain, category FROM sources
    WHERE enabled = 1 AND id NOT LIKE 'search:%' ORDER BY category, name COLLATE NOCASE`).all() as
    { kind: string; name: string; url: string; domain: string | null; category: string | null }[];
  const instance = (opts.rssHubInstance ?? '').trim().replace(/\/+$/, '');
  const groups = new Map<string, string[]>();
  let count = 0, skipped = 0;
  for (const r of rows) {
    const feed = r.kind === 'rss' && /^https?:\/\//i.test(r.url) ? r.url
      : r.kind === 'rsshub' && /^https?:\/\//i.test(instance) ? `${instance}${normalizeRoute(r.url)}`
      : null;
    if (!feed) { skipped++; continue; }
    const site = r.domain ? ` htmlUrl="${esc(`https://${r.domain}`)}"` : '';
    const label = categoryLabel(r.category, opts.lang);
    groups.set(label, [...(groups.get(label) ?? []), `      <outline type="rss" text="${esc(r.name)}" title="${esc(r.name)}" xmlUrl="${esc(feed)}"${site}/>`]);
    count++;
  }
  const body = [...groups].map(([label, lines]) => `    <outline text="${esc(label)}" title="${esc(label)}">\n${lines.join('\n')}\n    </outline>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${esc(opts.title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${body}
  </body>
</opml>
`;
  return { xml, count, skipped };
}
