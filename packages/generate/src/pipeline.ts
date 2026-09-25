import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { log, localDateKey } from '@pnr/core';
import { ingestAll } from '@pnr/feed';
import { enrichItem, enrichPending } from '@pnr/reader';
import { listWatches, getWatch, prepareWatch, type Watch } from '@pnr/watch';
import { recallForWatch, aiPrescreenWatches, judgeAll, gateWatch, matchKeywords } from '@pnr/recall';
import { generateDigest, DIGEST_FALLBACK_HOURS, type Digest } from './digest.ts';
import { generateProgress, PROGRESS_WINDOW_DAYS } from './progress.ts';
import { generateFlashes, FLASH_WINDOW_HOURS, type SearchFillContext } from './flashes.ts';
import { generateOutsidePicks, outsideDue } from './outside.ts';

/**
 * The runs behind the window's update buttons, shared by the app and the
 * background worker so the two cannot drift apart (they had: the worker's flash
 * run never fetched news, the app's never recalled it).
 *
 * Every writing step is incremental. Judging already skips articles it has seen;
 * on top of that a timeline is only re-read when something new passed its gate,
 * flashes only look at material no earlier check showed the model, the brief is
 * only rewritten when a new development arrived, and 关注之外 is written once a
 * day. Pressing a button twice therefore costs one fetch, not two rounds of
 * writing. `force` is the escape hatch that writes everything again.
 */
export interface RunOptions {
  dataDir: string;
  /** Global output language; a watch's own setting overrides it. */
  lang: string;
  onProgress?: (p: { phase: 'fetch' | 'watch' | 'extract' | 'writing'; label?: string }) => void;
  /** Write every document again even when nothing new arrived. */
  force?: boolean;
  /** Whether the full run also writes flashes (the caller holds the flash lock). */
  flashes?: boolean;
}

/** A writing step that did not call the model because nothing new arrived. */
export type SkippedStep = 'progress' | 'flashes' | 'digest' | 'outside';

export interface RunResult {
  fetched: number;
  watches: number;
  failed: number;
  mode: 'ai' | 'keywords';
  digest?: boolean;
  milestones?: number;
  flashes?: number;
  outside?: number;
  skipped?: SkippedStep[];
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

/** Whether a watch's timeline needs another progress pass: something judged
 *  since the last one passed the gate, or the watch was edited or corrected
 *  (which clears `progress_at`). */
export function progressDue(db: Db, watchId: string): boolean {
  const row = db.prepare('SELECT progress_at AS at FROM watches WHERE id = ?').get(watchId) as { at: number | null } | undefined;
  if (row?.at == null) return true;
  return Boolean(db.prepare(
    `SELECT 1 FROM matches m JOIN items i ON i.id = m.item_id
     WHERE m.watch_id = ? AND m.passed_gate = 1 AND m.judged_at > ? AND i.published_at >= ? LIMIT 1`
  ).get(watchId, row.at, Date.now() - PROGRESS_WINDOW_DAYS * 864e5));
}

/** Whether today's brief is out of date: not written yet, written in another
 *  language, a new development arrived since, or a watch it does not cover yet
 *  has material judged since (a new watch, or one whose first articles only
 *  just arrived — its opening baseline is never marked new). More reports on
 *  what it already told do not count. */
export function digestDue(db: Db, watches: Watch[], lang: string, date = localDateKey()): boolean {
  const d = db.prepare('SELECT generated_at AS at, lang, body_json AS body FROM digests WHERE edition_date = ?')
    .get(date) as { at: number; lang: string; body: string } | undefined;
  if (!d || d.lang !== lang) return true;
  if (watches.length === 0) return false;
  const ids = watches.map((w) => w.id); const marks = ids.map(() => '?').join(',');
  if (db.prepare(`SELECT 1 FROM milestones WHERE is_new = 1 AND first_seen_at > ? AND watch_id IN (${marks}) LIMIT 1`).get(d.at, ...ids)) return true;
  let covered = new Set<string>();
  try { covered = new Set((JSON.parse(d.body) as { watchId?: string }[]).map((b) => b.watchId).filter((x): x is string => Boolean(x))); }
  catch { return true; }
  const uncovered = ids.filter((id) => !covered.has(id));
  if (uncovered.length === 0) return false;
  return Boolean(db.prepare(
    `SELECT 1 FROM matches m JOIN items i ON i.id = m.item_id
     WHERE m.passed_gate = 1 AND m.judged_at > ? AND i.published_at >= ? AND m.watch_id IN (${uncovered.map(() => '?').join(',')}) LIMIT 1`
  ).get(d.at, Date.now() - DIGEST_FALLBACK_HOURS * 3600_000, ...uncovered));
}

/** Timelines for the watches that have something new; the rest are skipped. */
async function writeProgress(db: Db, provider: Provider, ready: Watch[], opts: RunOptions, startedAt: number,
                             skipped: Set<SkippedStep>): Promise<{ milestones: number; failed: number }> {
  let milestones = 0, failed = 0;
  for (const w of ready) {
    if (!opts.force && !progressDue(db, w.id)) { skipped.add('progress'); continue; }
    const mark = Date.now();
    try {
      milestones += (await generateProgress(db, provider, w, w.outputLang ?? opts.lang, { toldBefore: startedAt })).length;
      db.prepare('UPDATE watches SET progress_at = ? WHERE id = ?').run(mark, w.id);
    } catch (e) {
      failed++;
      log({ event: 'run.progress', phase: 'failed', entityId: w.id, reasonDetail: String(e).slice(0, 160) });
    }
  }
  return { milestones, failed };
}

/** Flashes across every watch — one call per output language. */
async function writeFlashes(db: Db, provider: Provider, ready: Watch[], opts: RunOptions,
                            skipped: Set<SkippedStep>): Promise<{ flashes: number; failed: number }> {
  const byLang = new Map<string, Watch[]>();
  for (const w of ready) {
    const l = w.outputLang ?? opts.lang;
    byLang.set(l, [...(byLang.get(l) ?? []), w]);
  }
  let flashes = 0, failed = 0, idle = 0;
  const enabled = (db.prepare("SELECT value FROM settings WHERE key='ai.searchFillEnabled'").get() as { value: string } | undefined)?.value !== '0';
  const searchFill: SearchFillContext | undefined = enabled ? { remaining: 5, byEvent: new Map() } : undefined;
  for (const [lang, group] of byLang) {
    try {
      flashes += (await generateFlashes(db, provider, group, lang, searchFill, undefined,
        { force: Boolean(opts.force), onSkip: () => { idle++; } })).length;
    } catch (e) { failed++; log({ event: 'run.flashes', phase: 'failed', reasonDetail: String(e).slice(0, 160) }); }
  }
  if (idle > 0 && idle === byLang.size) skipped.add('flashes');
  return { flashes, failed };
}

/**
 * 全部更新 — the daily run, and the button that brings everything up to date:
 * fetch, match every watch, then timelines BEFORE flashes and the brief.
 *
 * Order matters. The brief and flashes record what they said as "already told";
 * run first, they made the progress pass see today's developments as told and
 * mark them all "not new". Progress also ignores anything told after this run
 * started.
 */
export async function runDaily(db: Db, provider: Provider | null, opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const skipped = new Set<SkippedStep>();
  opts.onProgress?.({ phase: 'fetch' });
  const ing = await ingestAll(db, 8, { dataDir: opts.dataDir });
  opts.onProgress?.({ phase: 'extract' });
  await enrichPending(db, opts.dataDir, 40, 5);

  const watches = listWatches(db, true);
  const matched = await matchAll(db, provider, watches, { windowHours: 72, useSearch: true, maxJudged: 40 }, opts.onProgress);
  const ready = matched.ready; let failed = matched.failed;
  const base: RunResult = { fetched: ing.inserted, watches: ready.length, failed, mode: provider ? 'ai' : 'keywords' };
  let milestones = 0, flashes = 0;
  let digest: Digest | null = null;
  if (provider && ready.length) {
    opts.onProgress?.({ phase: 'extract' });
    await enrichMatched(db, opts.dataDir, ready.map((w) => w.id), Date.now() - 72 * 3600_000, 30);
    opts.onProgress?.({ phase: 'writing' });
    const p = await writeProgress(db, provider, ready, opts, startedAt, skipped);
    milestones = p.milestones; failed += p.failed;
    if (opts.flashes !== false) {
      const f = await writeFlashes(db, provider, ready, opts, skipped);
      flashes = f.flashes; failed += f.failed;
    }
    if (opts.force || digestDue(db, ready, opts.lang)) {
      try { digest = await generateDigest(db, provider, ready, opts.lang); }
      catch (e) { failed++; log({ event: 'run.digest', phase: 'failed', reasonDetail: String(e).slice(0, 160) }); }
    } else skipped.add('digest');
  }
  let outside = 0;
  // Without AI the picks are counted locally, which costs nothing.
  if (opts.force || !provider || outsideDue(db, ready, opts.lang)) {
    try { outside = (await generateOutsidePicks(db, provider, ready, opts.lang)).length; }
    catch (e) { failed++; log({ event: 'run.outside', phase: 'failed', reasonDetail: String(e).slice(0, 160) }); }
  } else skipped.add('outside');
  return { ...base, failed, digest: Boolean(digest), milestones, flashes, outside, skipped: [...skipped] };
}

/**
 * The frequent check behind 快讯: fetch, look at the last day for every watch
 * (no search arm, already-judged items skipped), fetch bodies for what passed,
 * then write flashes — one call per output language across all watches, and
 * none when nothing new passed since the last check.
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
  const skipped = new Set<SkippedStep>();
  const f = await writeFlashes(db, provider, ready, opts, skipped);
  return { ...base, failed: failed + f.failed, flashes: f.flashes, skipped: [...skipped] };
}

/**
 * "立即更新" on one watch: fetch, match it and refresh its timeline, without a
 * new brief. It fetches first because the person asked for the latest on this
 * story; matching only what an earlier fetch left would often find nothing.
 * The timeline is only re-read when something new passed.
 */
export async function runWatch(db: Db, provider: Provider | null, watchId: string, opts: RunOptions): Promise<RunResult> {
  const w = getWatch(db, watchId);
  if (!w) return { fetched: 0, watches: 0, failed: 1, mode: provider ? 'ai' : 'keywords' };
  const startedAt = Date.now();
  opts.onProgress?.({ phase: 'fetch' });
  const ing = await ingestAll(db, 8, { dataDir: opts.dataDir });
  opts.onProgress?.({ phase: 'watch', label: w.label });
  const matched = await matchAll(db, provider, [w], { windowHours: 72, useSearch: true, maxJudged: 40 }, opts.onProgress);
  const ready = matched.ready[0];
  if (!ready) return { fetched: ing.inserted, watches: 0, failed: matched.failed || 1, mode: provider ? 'ai' : 'keywords' };
  const base: RunResult = { fetched: ing.inserted, watches: 1, failed: 0, mode: provider ? 'ai' : 'keywords' };
  if (!provider) return base;
  const skipped = new Set<SkippedStep>();
  if (!opts.force && !progressDue(db, w.id)) return { ...base, milestones: 0, skipped: ['progress'] };
  await enrichMatched(db, opts.dataDir, [w.id], Date.now() - 72 * 3600_000, 15);
  opts.onProgress?.({ phase: 'writing' });
  const p = await writeProgress(db, provider, [ready], opts, startedAt, skipped);
  return { ...base, failed: p.failed, milestones: p.milestones, skipped: [...skipped] };
}

/**
 * 「重新生成」 on today's brief: write it again from what is already matched and
 * judged — one call, no fetching or re-judging. Bringing the material itself up
 * to date is 全部更新's job.
 */
export async function rewriteDigest(db: Db, provider: Provider, opts: RunOptions): Promise<RunResult> {
  const watches = listWatches(db, true);
  opts.onProgress?.({ phase: 'writing' });
  const digest = watches.length ? await generateDigest(db, provider, watches, opts.lang) : null;
  return { fetched: 0, watches: watches.length, failed: 0, mode: 'ai', digest: Boolean(digest) };
}
