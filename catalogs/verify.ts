/**
 * Independently verifies every candidate feed: reachable, parseable, and fresh.
 * Only survivors ship in the built-in catalogue.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CatalogFeed } from './build.ts';
import { download, ACCEPT_FEED } from '../packages/core/src/index.ts';
import { parseFeed } from '../packages/reader-core/src/index.ts';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const CONCURRENCY = 12;
const TIMEOUT_MS = 15_000;
const STALE_DAYS = 45;

type Verdict = { ok: true; items: number; newestAt: number | null } | { ok: false; reason: string };

/**
 * One feed, checked the way the app will read it: downloaded by the app's own
 * downloader and parsed by the reader core, so charsets, RDF, JSON Feed and
 * sitemaps are handled exactly as in production. Stale means the newest dated
 * item is older than STALE_DAYS.
 */
export async function check(feed: CatalogFeed): Promise<Verdict> {
  try {
    const d = await download(feed.url, { accept: ACCEPT_FEED, timeoutMs: TIMEOUT_MS });
    const kind = feed.kind === 'news_sitemap' ? 'sitemap' : feed.kind === 'news_sitemap_index' ? 'sitemap_index' : 'feed';
    const parsed = await parseFeed(d.url, kind, d.body);
    if (kind === 'sitemap_index') return parsed.children?.length ? { ok: true, items: parsed.children.length, newestAt: null } : { ok: false, reason: 'empty' };
    if (parsed.items.length === 0) return { ok: false, reason: 'empty' };
    const dated = parsed.items.filter((i) => !i.dateEstimated).map((i) => Date.parse(i.publishedAt));
    const newest = dated.length ? Math.max(...dated) : null;
    if (newest !== null && Date.now() - newest > STALE_DAYS * 864e5) return { ok: false, reason: 'stale' };
    return { ok: true, items: parsed.items.length, newestAt: newest };
  } catch (e) {
    return { ok: false, reason: (e as { reason?: string }).reason ?? ((e as Error)?.message ?? 'error').slice(0, 40) };
  }
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
// Run only when invoked directly, not when imported for its helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
