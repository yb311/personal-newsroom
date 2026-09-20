import type { Db } from '@pnr/store';
import type { DiscoveredItem, SourceRecord } from '@pnr/core';
import { canonicalDedupKey, log } from '@pnr/core';
import { adapterFor } from './adapters/index.ts';
import { createHash } from 'node:crypto';

const idFor = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 24);

/** Inserts items, skipping any whose canonical dedup key is already present. */
export function storeItems(db: Db, items: DiscoveredItem[]): { inserted: number; duplicate: number } {
  const stmt = db.prepare(
    `INSERT INTO items (id, dedup_key, source_id, url, title, published_at, discovered_at,
                        snippet, author, lang, image_url, date_estimated)
     VALUES (@id, @dedupKey, @sourceId, @url, @title, @publishedAt, @discoveredAt,
             @snippet, @author, @lang, @imageUrl, @dateEstimated)
     ON CONFLICT(dedup_key) DO NOTHING`
  );
  let inserted = 0;
  const now = Date.now();
  db.transaction(() => {
    for (const it of items) {
      const dedupKey = canonicalDedupKey(it.url);
      const r = stmt.run({
        id: idFor(dedupKey), dedupKey, sourceId: it.sourceId, url: it.url, title: it.title,
        publishedAt: Date.parse(it.publishedAt), discoveredAt: now,
        snippet: it.snippet ?? null, author: it.author ?? null,
        lang: it.lang ?? null, imageUrl: it.imageUrl ?? null,
        dateEstimated: it.publishedAtEstimated ? 1 : 0
      });
      inserted += r.changes;
    }
  })();
  return { inserted, duplicate: items.length - inserted };
}

/** Fetches one source and stores what it yields. Never throws: a broken source
 *  records its failure and the run continues. */
export async function ingestSource(db: Db, source: SourceRecord): Promise<{ kept: number; inserted: number }> {
  const now = Date.now();
  const adapter = adapterFor(source.kind);
  if (!adapter) {
    log({ event: 'feed.ingest', stage: 'fetch', phase: 'skipped', entityId: source.id, reasonCode: 'no_adapter' });
    return { kept: 0, inserted: 0 };
  }
  try {
    const { items, diagnostics } = await adapter(source, { db });
    const { inserted } = storeItems(db, items);
    db.prepare('UPDATE sources SET last_fetch_at=?, last_ok_at=?, last_error=NULL, consecutive_failures=0 WHERE id=?')
      .run(now, now, source.id);
    log({ event: 'feed.ingest', stage: 'fetch', phase: 'completed', entityId: source.id,
          attrs: { kept: diagnostics.kept, inserted, dropped: diagnostics.droppedByReason } });
    return { kept: diagnostics.kept, inserted };
  } catch (e) {
    const reason = (e as Error)?.message ?? 'error';
    db.prepare('UPDATE sources SET last_fetch_at=?, last_error=?, consecutive_failures=consecutive_failures+1 WHERE id=?')
      .run(now, reason, source.id);
    log({ event: 'feed.ingest', stage: 'fetch', phase: 'failed', entityId: source.id, reasonCode: reason });
    return { kept: 0, inserted: 0 };
  }
}

/** Runs enabled sources with bounded concurrency. */
export async function ingestAll(db: Db, concurrency = 8): Promise<{ sources: number; inserted: number }> {
  const sources = db.prepare(
    `SELECT id, kind, name, domain, url, category, lang, country, trust, enabled,
            date_hydration AS dateHydration, config_json AS configJson
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
        mine += (await ingestSource(db, s)).inserted;
      }
    })
  );
  return { sources: sources.length, inserted: perWorker.reduce((a, b) => a + b, 0) };
}
