import type { Db } from '@pnr/store';
import { writeBody } from '@pnr/store';
import type { DiscoveredItem, SourceRecord } from '@pnr/core';
import { canonicalDedupKey, log, flags } from '@pnr/core';
import { cleanHtml, plainText } from '@pnr/reader-core';
import { adapterFor } from './adapters/index.ts';
import { createHash } from 'node:crypto';

const idFor = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 24);

/** Older items are not stored. A dead feed would otherwise pour its whole
 *  history into the reader the first time it is fetched. */
export const MAX_ITEM_AGE_DAYS = 30;

/** When the feed's own content reaches this length it is the article, and the
 *  page is never fetched. Below it, it is a teaser. */
export const FEED_BODY_MIN_WORDS = 150;

/**
 * Makes every adapter's output look the same before it is stored: markup and
 * escaped entities out of titles, authors and snippets; raw body HTML
 * sanitised. Feed and sitemap items already come out of the reader core clean,
 * and cleaning them again changes nothing; RSSHub, Telegram and the JSON APIs
 * rely on this step.
 */
export async function normalizeItems(items: DiscoveredItem[]): Promise<DiscoveredItem[]> {
  const raw = items.filter((i) => i.contentHtml && i.contentText === undefined);
  const cleaned = await cleanHtml(raw.map((i) => ({ baseUrl: i.url, html: i.contentHtml! })));
  raw.forEach((i, n) => {
    const c = cleaned[n]!;
    i.contentHtml = c.html; i.contentText = c.text; i.words = c.words;
    if (!i.snippet) i.snippet = c.text.replace(/\n/g, ' ').slice(0, 600);
  });

  const texts = items.flatMap((i) => [i.title, i.snippet ?? '', i.author ?? '']);
  const plain = await plainText(texts);
  return items.map((i, n) => {
    const [title, snippet, author] = plain.slice(n * 3, n * 3 + 3) as [string, string, string];
    const { snippet: _s, author: _a, ...rest } = i;
    return { ...rest, title, ...(snippet ? { snippet } : {}), ...(author ? { author } : {}) };
  });
}

/** Inserts items, skipping any whose canonical dedup key is already present.
 *  Returns the items that were new. */
export function storeItems(db: Db, items: DiscoveredItem[]): { inserted: number; duplicate: number; fresh: { id: string; item: DiscoveredItem }[] } {
  const stmt = db.prepare(
    `INSERT INTO items (id, dedup_key, source_id, url, title, published_at, discovered_at,
                        snippet, author, lang, image_url, date_estimated)
     VALUES (@id, @dedupKey, @sourceId, @url, @title, @publishedAt, @discoveredAt,
             @snippet, @author, @lang, @imageUrl, @dateEstimated)
     ON CONFLICT(dedup_key) DO NOTHING`
  );
  const fresh: { id: string; item: DiscoveredItem }[] = [];
  const now = Date.now();
  db.transaction(() => {
    for (const it of items) {
      const dedupKey = canonicalDedupKey(it.url);
      const id = idFor(dedupKey);
      const r = stmt.run({
        id, dedupKey, sourceId: it.sourceId, url: it.url, title: it.title,
        publishedAt: Date.parse(it.publishedAt), discoveredAt: now,
        snippet: it.snippet ?? null, author: it.author ?? null,
        lang: it.lang ?? null, imageUrl: it.imageUrl ?? null,
        dateEstimated: it.publishedAtEstimated ? 1 : 0
      });
      if (r.changes) fresh.push({ id, item: it });
    }
  })();
  return { inserted: fresh.length, duplicate: items.length - fresh.length, fresh };
}

/** Saves the feed's own full text as the body of newly stored items, so they
 *  open instantly and never hit the publisher's page. */
function storeFeedBodies(db: Db, dataDir: string, fresh: { id: string; item: DiscoveredItem }[]): number {
  const mark = db.prepare(
    `UPDATE items SET body_state='ok', body_path=?, body_words=?, body_engine='feed', body_fetched_at=?, body_error=NULL
     WHERE id=?`
  );
  let n = 0;
  const now = Date.now();
  for (const { id, item } of fresh) {
    if (!item.contentHtml || (item.words ?? 0) < FEED_BODY_MIN_WORDS) continue;
    const path = writeBody(dataDir, {
      itemId: id, url: item.url, html: item.contentHtml, text: item.contentText ?? '',
      words: item.words ?? 0, lang: item.lang ?? null, source: 'feed', engine: 'feed', extractedAt: now
    });
    mark.run(path, item.words ?? 0, now, id);
    n++;
  }
  return n;
}

/** Diagnostics that mean the source failed, not that items were filtered. */
const FAILURE_REASONS = new Set(['rsshub_not_available', 'route_not_found', 'needs_browser', 'upstream_blocked',
                                 'upstream_error', 'route_error', 'empty',
                                 'apify_no_token', 'apify_bad_token', 'apify_no_credit']);

export interface IngestOptions {
  /** Where bodies are written. Without it, full-text feeds are stored as teasers. */
  dataDir?: string;
}

/** Fetches one source and stores what it yields. Never throws: a broken source
 *  records its failure and the run continues. */
export async function ingestSource(db: Db, source: SourceRecord, opts: IngestOptions = {}): Promise<{ kept: number; inserted: number }> {
  const now = Date.now();
  const adapter = adapterFor(source.kind);
  if (!adapter) {
    log({ event: 'feed.ingest', stage: 'fetch', phase: 'skipped', entityId: source.id, reasonCode: 'no_adapter' });
    return { kept: 0, inserted: 0 };
  }
  try {
    const res = await adapter(source, { db });
    const cutoff = now - MAX_ITEM_AGE_DAYS * 864e5;
    const recent = res.items.filter((i) => i.publishedAtEstimated || Date.parse(i.publishedAt) >= cutoff);
    const tooOld = res.items.length - recent.length;
    const { inserted, fresh } = storeItems(db, await normalizeItems(recent));
    const bodies = opts.dataDir ? storeFeedBodies(db, opts.dataDir, fresh) : 0;

    // Some adapters report failure as an empty result with a reason (RSSHub,
    // GDELT) rather than by throwing; that is still a failure to show.
    const failure = res.items.length === 0 && !res.notModified
      ? Object.keys(res.diagnostics.droppedByReason).find((r) => FAILURE_REASONS.has(r) || r.startsWith('instance_'))
      : undefined;
    if (failure) {
      db.prepare('UPDATE sources SET last_fetch_at=?, last_error=?, consecutive_failures=consecutive_failures+1 WHERE id=?')
        .run(now, failure, source.id);
    } else {
      db.prepare(`UPDATE sources SET last_fetch_at=?, last_ok_at=?, last_error=NULL, consecutive_failures=0
                  ${res.cache ? ', etag=?, last_modified=?' : ''} WHERE id=?`)
        .run(now, now, ...(res.cache ? [res.cache.etag, res.cache.lastModified] : []), source.id);
    }
    log({ event: 'feed.ingest', stage: 'fetch', phase: 'completed', entityId: source.id,
          attrs: { kept: res.diagnostics.kept, inserted, bodies, tooOld,
                   notModified: Boolean(res.notModified), dropped: res.diagnostics.droppedByReason } });
    return { kept: res.diagnostics.kept, inserted };
  } catch (e) {
    const reason = (e as { reason?: string })?.reason ?? (e as Error)?.message ?? 'error';
    db.prepare('UPDATE sources SET last_fetch_at=?, last_error=?, consecutive_failures=consecutive_failures+1 WHERE id=?')
      .run(now, reason, source.id);
    log({ event: 'feed.ingest', stage: 'fetch', phase: 'failed', entityId: source.id, reasonCode: reason });
    return { kept: 0, inserted: 0 };
  }
}

/** Runs enabled sources with bounded concurrency. */
export async function ingestAll(db: Db, concurrency = 8, opts: IngestOptions = {}): Promise<{ sources: number; inserted: number }> {
  if (flags.disableFetch) {
    log({ event: 'feed.ingest', phase: 'skipped', reasonCode: 'PNR_DISABLE_FETCH' });
    return { sources: 0, inserted: 0 };
  }
  const sources = db.prepare(
    `SELECT id, kind, name, domain, url, category, lang, country, trust, enabled,
            date_hydration AS dateHydration, config_json AS configJson,
            etag, last_modified AS lastModified
     FROM sources WHERE enabled = 1`
  ).all() as SourceRecord[];
  const queue = [...sources];
  // Each worker accumulates locally. `total += await f()` would be a lost-update
  // race: the read of `total` happens before the await, so a worker can overwrite
  // a result another worker wrote while it was suspended.
  const perWorker = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      let mine = 0;
      for (;;) {
        const s = queue.shift();
        if (!s) return mine;
        mine += (await ingestSource(db, s, opts)).inserted;
      }
    })
  );
  return { sources: sources.length, inserted: perWorker.reduce((a, b) => a + b, 0) };
}
