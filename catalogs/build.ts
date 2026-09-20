/**
 * Builds the built-in feed catalogue.
 *
 * Feed URLs are factual data. This script gathers candidates, then
 * catalogs/verify.ts independently checks each one for reachability and
 * freshness; only survivors ship. The result is this project's own
 * compilation under its own taxonomy and trust weights.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'data');

export interface CatalogFeed {
  id: string;
  kind: 'rss' | 'news_sitemap' | 'news_sitemap_index';
  name: string;
  domain: string;
  url: string;
  category: string;
  lang?: string;
  country?: string;
  trust: number;
  featured: boolean;           // enabled on first run
  dateHydration?: 'article_html';
}

const GH = 'https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master';
const API = 'https://api.github.com/repos/plenaryapp/awesome-rss-feeds/git/trees/master?recursive=1';

const domainOf = (u: string): string => {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Minimal OPML reader: pulls every outline that carries an xmlUrl. */
function parseOpml(xml: string): { title: string; url: string; group: string }[] {
  const out: { title: string; url: string; group: string }[] = [];
  let group = '';
  for (const line of xml.split(/\n/)) {
    const g = line.match(/<outline[^>]*text="([^"]*)"[^>]*(?!xmlUrl)>/);
    if (g?.[1] && !line.includes('xmlUrl')) group = decode(g[1]);
    const m = line.match(/<outline[^>]*xmlUrl="([^"]+)"[^>]*\/?>/);
    if (!m?.[1]) continue;
    const t = line.match(/(?:text|title)="([^"]*)"/);
    out.push({ title: decode(t?.[1] ?? ''), url: decode(m[1]), group });
  }
  return out;
}
const decode = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const tree = (await (await fetch(API)).json()) as { tree?: { path: string }[] };
  const opmls = (tree.tree ?? [])
    .map((t) => t.path)
    .filter((p) => p.endsWith('.opml') && p.includes('with_category'));
  console.log(`发现 ${opmls.length} 个 OPML 文件`);

  const byUrl = new Map<string, CatalogFeed>();
  let dupes = 0;

  for (const path of opmls) {
    const isCountry = path.startsWith('countries/');
    const region = decodeURIComponent(path.split('/').pop()!.replace('.opml', ''));
    let xml: string;
    try { xml = await (await fetch(`${GH}/${path}`)).text(); } catch { continue; }
    for (const e of parseOpml(xml)) {
      const domain = domainOf(e.url);
      if (!domain || !e.title) continue;
      const key = e.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (byUrl.has(key)) { dupes++; continue; }
      byUrl.set(key, {
        id: `${slug(domain)}-${slug(e.title)}`.slice(0, 80),
        kind: 'rss',
        name: e.title,
        domain,
        url: e.url,
        category: isCountry ? 'news' : slug(e.group || region) || 'general',
        ...(isCountry ? { country: region } : {}),
        trust: 0.75,
        featured: false
      });
    }
  }

  // Curated international outlets, ported from daily-brief's registry along with
  // the reasons each surface was chosen. These ship enabled by default.
  const curated: CatalogFeed[] = [
    ...[
      // AP is deliberately NOT featured. Its RSS returns 401 and is robots-disallowed,
      // and its sitemap returns 403 from consumer IPs no matter what headers are sent
      // (verified 2026-09-20). It works from datacenter IPs, which is why daily-brief
      // can use it from CI — but this is a desktop app on a home connection.
      ['usatoday', 'USA Today', 'usatoday.com', 'https://www.usatoday.com/news-sitemap.xml', 0.85, 'news_sitemap'],
      ['reuters', '路透社', 'reuters.com', 'https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml', 1.0, 'news_sitemap_index'],
      // Reuters has no public RSS; the sitemap index is the canonical path.
      ['bbc', 'BBC News', 'bbc.com', 'https://feeds.bbci.co.uk/news/world/rss.xml', 0.95, 'rss'],
      ['guardian', 'The Guardian', 'theguardian.com', 'https://www.theguardian.com/world/rss', 0.92, 'rss'],
      ['aljazeera', '半岛电视台', 'aljazeera.com', 'https://www.aljazeera.com/xml/rss/all.xml', 0.88, 'rss'],
      ['npr', 'NPR', 'npr.org', 'https://feeds.npr.org/1001/rss.xml', 0.9, 'rss'],
      ['dw-en', 'Deutsche Welle 英文', 'dw.com', 'https://rss.dw.com/xml/rss-en-all', 0.88, 'rss'],
      ['dw', 'Deutsche Welle', 'dw.com', 'https://rss.dw.com/rdf/rss-en-world', 0.88, 'rss'],
      ['france24', 'France 24', 'france24.com', 'https://www.france24.com/en/rss', 0.86, 'rss'],
      ['cnbc', 'CNBC', 'cnbc.com', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', 0.85, 'rss'],
      ['scmp', '南华早报', 'scmp.com', 'https://www.scmp.com/rss/91/feed', 0.85, 'rss'],
      ['japantimes', 'The Japan Times', 'japantimes.co.jp', 'https://www.japantimes.co.jp/feed/', 0.85, 'rss']
    ].map(([id, name, domain, url, trust, kind]) => ({
      id: id as string, kind: kind as CatalogFeed['kind'], name: name as string,
      domain: domain as string, url: url as string, category: 'world',
      trust: trust as number, featured: true
    }))
  ];
  for (const c of curated) byUrl.set(c.url.replace(/^https?:\/\//, ''), c);

  const feeds = [...byUrl.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  const cats = [...new Set(feeds.map((f) => f.category))].sort();
  const countries = [...new Set(feeds.map((f) => f.country).filter(Boolean))].sort();

  // Writes ONLY candidates.json. feeds.json is produced by verify.ts, so that
  // re-running build can never clobber an already-verified catalogue.
  writeFileSync(join(OUT, 'candidates.json'), JSON.stringify(feeds, null, 1));
  console.log(`\n候选源 ${feeds.length} 个（去重掉 ${dupes} 个）`);
  console.log(`分类 ${cats.length} 个, 国家 ${countries.length} 个, 默认启用 ${feeds.filter(f=>f.featured).length} 个`);
  console.log(`写入 ${join(OUT, 'candidates.json')} —— 接着跑 catalog:verify 生成 feeds.json`);
}
main();
