/** Second pass: re-check feeds rejected for reasons that look like our own fault
 *  (rate limiting from concurrency, UA blocks, transient timeouts). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogFeed } from './build.ts';
import { check } from './verify.ts';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const RETRYABLE = new Set(['rate_limited', 'forbidden', 'timeout', 'network', 'http_error', 'server_error']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const alive = JSON.parse(readFileSync(join(DATA, 'feeds.json'), 'utf8')) as CatalogFeed[];
  const dead = JSON.parse(readFileSync(join(DATA, 'rejected.json'), 'utf8')) as {url:string;name:string;reason:string}[];
  const all = JSON.parse(readFileSync(join(DATA, 'candidates.json'), 'utf8')) as CatalogFeed[];
  const byUrl = new Map(all.map((f) => [f.url, f]));

  const retry = dead.filter((d) => RETRYABLE.has(d.reason));
  console.log(`重试 ${retry.length} 个（原因: ${[...RETRYABLE].join(', ')}），单线程 + 每域名间隔\n`);

  const recovered: CatalogFeed[] = [];
  const stillDead: typeof dead = [];
  const lastHit = new Map<string, number>();

  for (const d of retry) {
    const feed = byUrl.get(d.url);
    if (!feed) { stillDead.push(d); continue; }
    const wait = 2500 - (Date.now() - (lastHit.get(feed.domain) ?? 0));
    if (wait > 0) await sleep(wait);
    lastHit.set(feed.domain, Date.now());
    const v = await check(feed);
    if (v.ok) recovered.push(feed);
    else stillDead.push({ ...d, reason: v.reason });
  }

  const merged = [...alive, ...recovered].sort((a, b) => a.domain.localeCompare(b.domain));
  const finalDead = [...dead.filter((d) => !RETRYABLE.has(d.reason)), ...stillDead];
  writeFileSync(join(DATA, 'feeds.json'), JSON.stringify(merged, null, 1));
  writeFileSync(join(DATA, 'rejected.json'), JSON.stringify(finalDead, null, 1));
  console.log(`捞回 ${recovered.length} 个，仍失败 ${stillDead.length} 个`);
  console.log(`最终目录: ${merged.length} 源 · ${new Set(merged.map(f=>f.category)).size} 分类 · ${new Set(merged.map(f=>f.country).filter(Boolean)).size} 国家 · 默认启用 ${merged.filter(f=>f.featured).length}`);
  const curatedDead = finalDead.filter(d => ['apnews.com','reuters.com','bbc.co.uk','theguardian.com','aljazeera.com','npr.org','dw.com','france24.com','cnbc.com','scmp.com','japantimes.co.jp'].some(x => d.url.includes(x)));
  if (curatedDead.length) { console.log('\n⚠️ 精选源中失败的:'); for (const c of curatedDead) console.log(`   ${c.reason.padEnd(12)} ${c.url}`); }
}
main();
