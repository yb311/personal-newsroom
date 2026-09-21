import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { log } from '@pnr/core';
import { ingestAll } from '@pnr/feed';
import { enrichItem, enrichPending } from '@pnr/reader';
import { listWatches, getWatch, prepareWatch, type Watch } from '@pnr/watch';
import { recallForWatch, aiPrescreenWatches, judgeAll, gateWatch, matchKeywords } from '@pnr/recall';
import { generateDigest, type Digest } from './digest.ts';
import { generateProgress } from './progress.ts';
import { generateFlashes, FLASH_WINDOW_HOURS, type SearchFillContext } from './flashes.ts';
import { generateOutsidePicks } from './outside.ts';

/**
 * The runs behind 今日 and 快讯, shared by the app and the background worker so
 * the two cannot drift apart (they had: the worker's flash run never fetched
 * news, the app's never recalled it).
 */
export interface RunOptions {
  dataDir: string;
  /** Global output language; a watch's own setting overrides it. */
  lang: string;
  onProgress?: (p: { phase: 'fetch' | 'watch' | 'extract' | 'writing'; label?: string }) => void;
}

export interface RunResult {
  fetched: number;
  watches: number;
  failed: number;
  mode: 'ai' | 'keywords';
  digest?: boolean;
  milestones?: number;
  flashes?: number;
  outside?: number;
}

/** Bodies for what passed the gate, so writing works from articles rather than
 *  headlines. The global enrich pass only takes the newest items, which are
 *  rarely the ones a watch picked. */
async function enrichMatched(db: Db, dataDir: string, watchIds: string[], sinceMs: number, limit: number): Promise<number> {
  if (watchIds.length === 0) return 0;
  const rows = db.prepare(
    `SELECT DISTINCT i.id, i.url FROM matches m JOIN items i ON i.id = m.item_id
     WHERE m.passed_gate = 1 AND i.body_state = 'pending' AND i.published_at >= ?
       AND m.watch_id IN (${watchIds.map(() => '?').join(',')})
     ORDER BY i.published_at DESC LIMIT ?`
  ).all(sinceMs, ...watchIds, limit) as { id: string; url: string }[];
  const queue = [...rows];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) await enrichItem(db, dataDir, r);
  }));
  return rows.length;
}

/** Recall, judge and gate one watch. Keyword matching instead when AI is off. */
async function matchWatch(db: Db, provider: Provider | null, w: Watch,
                          recall: { windowHours: number; useSearch: boolean; maxJudged: number;
                            aiMatches?: Set<string>; aiDegraded?: Set<string> }, prepared = false): Promise<Watch> {
  if (!provider) { matchKeywords(db, w, recall.windowHours); }
  else {
    const ready = prepared ? w : await prepareWatch(db, provider, w);
    const candidates = await recallForWatch(db, provider, ready, recall);
    await judgeAll(db, provider, ready, candidates);
    gateWatch(db, ready);
    w = ready;
  }
  db.prepare('UPDATE watches SET last_run_at = ? WHERE id = ?').run(Date.now(), w.id);
  return w;
}

async function matchAll(
  db: Db, provider: Provider | null, watches: Watch[],
  recall: { windowHours: number; useSearch: boolean; maxJudged: number },
  onProgress?: RunOptions['onProgress']
): Promise<{ ready: Watch[]; failed: number }> {
  const prepared: Watch[] = []; let failed = 0;
  if (provider) {
    for (const watch of watches) {
      onProgress?.({ phase: 'watch', label: watch.label });
      try { prepared.push(await prepareWatch(db, provider, watch)); }
      catch (error) { failed++; log({ event: 'run.watch.prepare', phase: 'failed', entityId: watch.id, reasonDetail: String(error).slice(0, 160) }); }
    }
  } else prepared.push(...watches);
  const prescreen = provider && !provider.capabilities.embedding
    ? await aiPrescreenWatches(db, provider, prepared, recall.windowHours) : null;
  const ready: Watch[] = [];
  for (const watch of prepared) {
    onProgress?.({ phase: 'watch', label: watch.label });
    try {
      ready.push(await matchWatch(db, provider, watch, {
        ...recall, ...(prescreen ? { aiMatches: prescreen.matches.get(watch.id)!, aiDegraded: prescreen.degraded.get(watch.id)! } : {})
      }, Boolean(provider)));
    } catch (error) {
      failed++; log({ event: 'run.watch', phase: 'failed', entityId: watch.id, reasonDetail: String(error).slice(0, 160) });
    }
  }
  return { ready, failed };
}

/**
 * The daily run: fetch, match every watch, then progress BEFORE the digest.
 *
 * Order matters. The digest records what it said as "already told"; run first,
 * it made the progress pass see today's developments as told and mark them all
 * "not new", so 昨天到今天 came out empty. Progress also ignores anything told
 * after this run started.
 */
export async function runDaily(db: Db, provider: Provider | null, opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  opts.onProgress?.({ phase: 'fetch' });
  const ing = await ingestAll(db, 8, { dataDir: opts.dataDir });
  opts.onProgress?.({ phase: 'extract' });
  await enrichPending(db, opts.dataDir, 40, 5);

  const watches = listWatches(db, true);
  const matched = await matchAll(db, provider, watches, { windowHours: 72, useSearch: true, maxJudged: 40 }, opts.onProgress);
  const ready = matched.ready; let failed = matched.failed;
  const base: RunResult = { fetched: ing.inserted, watches: ready.length, failed, mode: provider ? 'ai' : 'keywords' };
  let milestones = 0;
  let digest: Digest | null = null;
  if (provider && ready.length) {
    opts.onProgress?.({ phase: 'extract' });
    await enrichMatched(db, opts.dataDir, ready.map((w) => w.id), Date.now() - 72 * 3600_000, 30);
    opts.onProgress?.({ phase: 'writing' });
    for (const w of ready) {
      try { milestones += (await generateProgress(db, provider, w, w.outputLang ?? opts.lang, { toldBefore: startedAt })).length; }
      catch (e) {
        failed++;
        log({ event: 'run.progress', phase: 'failed', entityId: w.id, reasonDetail: String(e).slice(0, 160) });
      }
    }
    try { digest = await generateDigest(db, provider, ready, opts.lang); }
    catch (e) { failed++; log({ event: 'run.digest', phase: 'failed', reasonDetail: String(e).slice(0, 160) }); }
  }
  let outside = 0;
  try { outside = (await generateOutsidePicks(db, provider, ready, opts.lang)).length; }
  catch (e) { failed++; log({ event: 'run.outside', phase: 'failed', reasonDetail: String(e).slice(0, 160) }); }
  return { ...base, failed, digest: Boolean(digest), milestones, outside };
}

/**
 * The frequent check behind 快讯: fetch, look at the last day for every watch
 * (no search arm, already-judged items skipped), fetch bodies for what passed,
 * then write flashes — one call per output language across all watches.
 */
export async function runFlashCheck(db: Db, provider: Provider | null, opts: RunOptions): Promise<RunResult> {
  opts.onProgress?.({ phase: 'fetch' });
  const ing = await ingestAll(db, 8, { dataDir: opts.dataDir });
  const watches = listWatches(db, true);
  const matched = await matchAll(db, provider, watches, { windowHours: FLASH_WINDOW_HOURS, useSearch: false, maxJudged: 30 }, opts.onProgress);
  const ready = matched.ready; let failed = matched.failed;
  const base: RunResult = { fetched: ing.inserted, watches: ready.length, failed, mode: provider ? 'ai' : 'keywords' };
  if (!provider || ready.length === 0) return base;

  opts.onProgress?.({ phase: 'extract' });
  await enrichMatched(db, opts.dataDir, ready.map((w) => w.id), Date.now() - FLASH_WINDOW_HOURS * 3600_000, 20);

  opts.onProgress?.({ phase: 'writing' });
  const byLang = new Map<string, Watch[]>();
  for (const w of ready) {
    const l = w.outputLang ?? opts.lang;
    byLang.set(l, [...(byLang.get(l) ?? []), w]);
  }
  let flashes = 0;
  const enabled = (db.prepare("SELECT value FROM settings WHERE key='ai.searchFillEnabled'").get() as { value: string } | undefined)?.value !== '0';
  const searchFill: SearchFillContext | undefined = enabled ? { remaining: 5, byEvent: new Map() } : undefined;
  for (const [lang, group] of byLang) {
    try { flashes += (await generateFlashes(db, provider, group, lang, searchFill)).length; }
    catch (e) { failed++; log({ event: 'run.flashes', phase: 'failed', reasonDetail: String(e).slice(0, 160) }); }
  }
  return { ...base, failed, flashes };
}

/** "立即更新" on one watch: match it and refresh its timeline, without a new digest. */
export async function runWatch(db: Db, provider: Provider | null, watchId: string, opts: RunOptions): Promise<RunResult> {
  const w = getWatch(db, watchId);
  if (!w) return { fetched: 0, watches: 0, failed: 1, mode: provider ? 'ai' : 'keywords' };
  const startedAt = Date.now();
  opts.onProgress?.({ phase: 'watch', label: w.label });
  const matched = await matchAll(db, provider, [w], { windowHours: 72, useSearch: true, maxJudged: 40 }, opts.onProgress);
  const ready = matched.ready[0];
  if (!ready) return { fetched: 0, watches: 0, failed: matched.failed || 1, mode: provider ? 'ai' : 'keywords' };
  const base: RunResult = { fetched: 0, watches: 1, failed: 0, mode: provider ? 'ai' : 'keywords' };
  if (!provider) return base;
  await enrichMatched(db, opts.dataDir, [w.id], Date.now() - 72 * 3600_000, 15);
  opts.onProgress?.({ phase: 'writing' });
  const ms = await generateProgress(db, provider, ready, ready.outputLang ?? opts.lang, { toldBefore: startedAt });
  return { ...base, milestones: ms.length };
}
