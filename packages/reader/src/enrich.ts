import type { Db } from '@pnr/store';
import { writeBody } from '@pnr/store';
import { log, domainOf, flags } from '@pnr/core';
import { extractArticle } from '@pnr/reader-core';
import { fetchPage, PAYWALLED } from './fetch.ts';

export type BodyState = 'pending' | 'ok' | 'blocked' | 'failed' | 'skipped';

export interface EnrichResult { state: BodyState; words: number; engine?: string; reason?: string }

/** A clean extraction shorter than this is a brief rather than a failure:
 *  sports results and breaking-news stubs are complete at 60 words. */
export const MIN_WORDS = 40;

/** Failures that say nothing about the page itself, so the article is tried
 *  again whenever it is opened instead of being remembered as final. Reuters'
 *  bot protection turns requests away at random, more often the more we send. */
export const TRANSIENT = new Set(['blocked', 'rate_limited', 'server_error', 'timeout', 'network']);
/** The site asked us to back off: asking again at once only makes it worse. */
const BACK_OFF = new Set(['blocked', 'rate_limited']);
const RETRY_AFTER_MS = 2_000;

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

  if (flags.disableExtract) return { state: 'pending', words: 0, reason: 'PNR_DISABLE_EXTRACT' };

  if (PAYWALLED.has(domainOf(item.url))) {
    // Do not spend a request or pretend: the reader shows the snippet and an
    // "open in browser" button instead.
    return finish('blocked', 0, undefined, 'paywalled');
  }

  let page;
  try { page = await fetchPage(item.url); }
  catch (first) {
    const reason = (first as { reason?: string }).reason ?? 'network';
    if (!TRANSIENT.has(reason) || BACK_OFF.has(reason)) return finish('failed', 0, undefined, reason);
    await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    try { page = await fetchPage(item.url); }
    catch (e) { return finish('failed', 0, undefined, (e as { reason?: string }).reason ?? 'network'); }
  }

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

/** Enriches pending items, newest first, with bounded concurrency. Workers
 *  never hit the same site at once — a burst of simultaneous requests to one
 *  publisher is what bot protection is built to catch — and once a site turns
 *  us away, its remaining items stay pending for this run and are fetched when
 *  opened, rather than spending more requests that raise the block rate. */
export async function enrichPending(
  db: Db, dataDir: string, limit = 50, concurrency = 6
): Promise<Record<BodyState, number>> {
  const rows = db.prepare(
    `SELECT id, url FROM items WHERE body_state='pending' ORDER BY published_at DESC LIMIT ?`
  ).all(limit) as { id: string; url: string }[];

  const tally: Record<BodyState, number> = { pending: 0, ok: 0, blocked: 0, failed: 0, skipped: 0 };
  const queue = [...rows];
  const busy = new Set<string>();
  const walled = new Set<string>();
  const perWorker = await Promise.all(Array.from({ length: concurrency }, async () => {
    const mine: BodyState[] = [];
    for (;;) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (walled.has(domainOf(queue[i]!.url))) { queue.splice(i, 1); mine.push('pending'); }
      }
      if (!queue.length) return mine;
      const at = queue.findIndex((r) => !busy.has(domainOf(r.url)));
      if (at < 0) { await new Promise((r) => setTimeout(r, 200)); continue; }
      const [it] = queue.splice(at, 1);
      const site = domainOf(it!.url);
      busy.add(site);
      try {
        const r = await enrichItem(db, dataDir, it!);
        mine.push(r.state);
        if (r.state === 'failed' && BACK_OFF.has(r.reason ?? '')) walled.add(site);
      } finally { busy.delete(site); }
    }
  }));
  for (const states of perWorker) for (const s of states) tally[s]++;
  return tally;
}
