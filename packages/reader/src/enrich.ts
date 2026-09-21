import type { Db } from '@pnr/store';
import { writeBody } from '@pnr/store';
import { log, domainOf } from '@pnr/core';
import { extractArticle } from '@pnr/reader-core';
import { fetchPage, PAYWALLED } from './fetch.ts';

export type BodyState = 'pending' | 'ok' | 'blocked' | 'failed' | 'skipped';

export interface EnrichResult { state: BodyState; words: number; engine?: string; reason?: string }

/** A clean extraction shorter than this is a brief rather than a failure:
 *  sports results and breaking-news stubs are complete at 60 words. */
export const MIN_WORDS = 40;

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

  if (PAYWALLED.has(domainOf(item.url))) {
    // Do not spend a request or pretend: the reader shows the snippet and an
    // "open in browser" button instead.
    return finish('blocked', 0, undefined, 'paywalled');
  }

  let page;
  try { page = await fetchPage(item.url); }
  catch (e) { return finish('failed', 0, undefined, (e as { reason?: string }).reason ?? 'network'); }

  let article;
  try { article = await extractArticle(page.url, page.body, page.contentType); }
  catch (e) { return finish('failed', 0, undefined, (e as { reason?: string }).reason ?? 'no_content'); }

  if (article.words < MIN_WORDS) return finish('failed', article.words, article.engine, 'too_thin');

  const path = writeBody(dataDir, {
    itemId: item.id, url: item.url, html: article.html, text: article.text, words: article.words,
    lang: article.lang ?? null, source: 'page', engine: article.engine, extractedAt: now
  });
  log({ event: 'reader.enrich', phase: 'completed', entityId: item.id,
        attrs: { words: article.words, engine: article.engine, tier: page.tier } });
  return finish('ok', article.words, article.engine, undefined, path);
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
