import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@pnr/store';
import { log, domainOf } from '@pnr/core';
import { fetchArticleHtml, PAYWALLED } from './fetch.ts';
import { extractArticle, MIN_WORDS } from './extract.ts';

export type BodyState = 'pending' | 'ok' | 'blocked' | 'failed' | 'skipped';

export interface EnrichResult { state: BodyState; words: number; engine?: string; reason?: string }

/** Article bodies live on disk, not in the database: they are large, they are
 *  never queried by content, and keeping them as files makes backup a folder copy. */
export function bodyPathFor(dataDir: string, itemId: string): string {
  const shard = itemId.slice(0, 2);
  return join(dataDir, 'bodies', shard, `${itemId}.json`);
}

/** Fetches and extracts one item's body. Never throws: failure is recorded on
 *  the row so the reader can be honest about it instead of pretending. */
export async function enrichItem(
  db: Db, dataDir: string, item: { id: string; url: string }
): Promise<EnrichResult> {
  const now = Date.now();
  const finish = (state: BodyState, words: number, engine?: string, reason?: string, path?: string): EnrichResult => {
    db.prepare(
      `UPDATE items SET body_state=?, body_path=?, body_words=?, body_engine=?, body_fetched_at=?, body_error=?
       WHERE id=?`
    ).run(state, path ?? null, words || null, engine ?? null, now, reason ?? null, item.id);
    return { state, words, ...(engine ? { engine } : {}), ...(reason ? { reason } : {}) };
  };

  const domain = domainOf(item.url);
  if (PAYWALLED.has(domain)) {
    // Do not spend a request or pretend: the reader shows the snippet and an
    // "open in browser" button instead.
    return finish('blocked', 0, undefined, 'paywalled');
  }

  let html: string;
  let tier: string;
  try {
    const r = await fetchArticleHtml(item.url);
    html = r.html; tier = r.tier;
  } catch (e) {
    return finish('failed', 0, undefined, (e as Error)?.message?.slice(0, 60) ?? 'fetch_failed');
  }

  let extraction;
  try { extraction = await extractArticle(html, item.url); }
  catch (e) { return finish('failed', 0, undefined, `extract:${(e as Error)?.message?.slice(0, 40)}`); }

  if (!extraction || extraction.blocks.length === 0) return finish('failed', 0, undefined, 'no_content');
  if (extraction.words < MIN_WORDS) return finish('failed', extraction.words, extraction.engine, 'too_thin');

  const path = bodyPathFor(dataDir, item.id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    itemId: item.id, url: item.url, fetchTier: tier, engine: extraction.engine,
    words: extraction.words, extractedAt: now, blocks: extraction.blocks
  }));

  log({ event: 'reader.enrich', phase: 'completed', entityId: item.id,
        attrs: { words: extraction.words, engine: extraction.engine, tier } });
  return finish('ok', extraction.words, extraction.engine, undefined, path);
}

/** Enriches pending items, newest first, with bounded concurrency. */
export async function enrichPending(
  db: Db, dataDir: string, limit = 50, concurrency = 6
): Promise<Record<BodyState, number>> {
  const rows = db.prepare(
    `SELECT id, url FROM items WHERE body_state='pending' ORDER BY published_at DESC LIMIT ?`
  ).all(limit) as { id: string; url: string }[];

  const tally: Record<BodyState, number> = { pending: 0, ok: 0, blocked: 0, failed: 0, skipped: 0 };
  const queue = [...rows];
  const perWorker = await Promise.all(Array.from({ length: concurrency }, async () => {
    const mine: BodyState[] = [];
    for (;;) {
      const it = queue.shift();
      if (!it) return mine;
      mine.push((await enrichItem(db, dataDir, it)).state);
    }
  }));
  for (const states of perWorker) for (const s of states) tally[s]++;
  return tally;
}
