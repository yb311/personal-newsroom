/**
 * Independently verifies every candidate feed: reachable, parseable, and fresh.
 * Only survivors ship in the built-in catalogue.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogFeed } from './build.ts';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const CONCURRENCY = 12;
const TIMEOUT_MS = 15_000;
const STALE_DAYS = 45;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

type Verdict = { ok: true; items: number; newestAt: number | null } | { ok: false; reason: string };

async function check(feed: CatalogFeed): Promise<Verdict> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.text()).slice(0, 400_000);
    if (!/<(rss|feed|urlset|sitemapindex|rdf:RDF)[\s>]/i.test(body)) return { ok: false, reason: 'not_a_feed' };
    const entries = body.match(/<(item|entry|url|sitemap)[\s>]/gi) ?? [];
    if (entries.length === 0) return { ok: false, reason: 'empty' };
    const dates = [...body.matchAll(/<(?:pubDate|published|updated|lastmod|news:publication_date)>([^<]+)</gi)]
      .map((m) => Date.parse(m[1]!.trim()))
      .filter((n) => Number.isFinite(n));
    const newest = dates.length ? Math.max(...dates) : null;
    if (newest !== null && Date.now() - newest > STALE_DAYS * 864e5) return { ok: false, reason: 'stale' };
    return { ok: true, items: entries.length, newestAt: newest };
  } catch (e) {
    const m = (e as Error)?.name === 'AbortError' ? 'timeout' : ((e as Error)?.message ?? 'error');
    return { ok: false, reason: m.slice(0, 40) };
  } finally { clearTimeout(timer); }
}

async function main(): Promise<void> {
  const feeds = JSON.parse(readFileSync(join(DATA, 'candidates.json'), 'utf8')) as CatalogFeed[];
  console.log(`验证 ${feeds.length} 个源，并发 ${CONCURRENCY}…\n`);

  const alive: CatalogFeed[] = [];
  const dead: { url: string; name: string; reason: string }[] = [];
  let done = 0;
  const queue = [...feeds];

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const feed = queue.shift();
      if (!feed) return;
      const v = await check(feed);
      done++;
      if (done % 100 === 0) process.stdout.write(`  ${done}/${feeds.length}\n`);
      if (v.ok) alive.push(feed);
      else dead.push({ url: feed.url, name: feed.name, reason: v.reason });
    }
  }));

  alive.sort((a, b) => a.domain.localeCompare(b.domain));
  writeFileSync(join(DATA, 'feeds.json'), JSON.stringify(alive, null, 1));
  writeFileSync(join(DATA, 'rejected.json'), JSON.stringify(dead, null, 1));

  const byReason = dead.reduce<Record<string, number>>((a, d) => ((a[d.reason] = (a[d.reason] ?? 0) + 1), a), {});
  console.log(`\n存活 ${alive.length} / ${feeds.length}  (剔除 ${dead.length})`);
  console.log('剔除原因:');
  for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}  ${r}`);
  }
  const cats = [...new Set(alive.map((f) => f.category))];
  const countries = [...new Set(alive.map((f) => f.country).filter(Boolean))];
  console.log(`\n最终: ${alive.length} 源 · ${cats.length} 分类 · ${countries.length} 国家 · 默认启用 ${alive.filter(f=>f.featured).length}`);
}
main();
