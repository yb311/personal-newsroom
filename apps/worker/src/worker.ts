/**
 * The headless worker. launchd runs this while the app is closed, which is what
 * makes "it keeps working when you are not looking" true.
 *
 * It shares the same database as the UI and takes the same SQLite lock, so the
 * two can never run the pipeline at once. It never talks to the UI directly —
 * the UI is usually not running — it writes structured events to the database
 * and the UI reads them next time it opens.
 */
import { join } from 'node:path';
import { openDb, defaultDataDir, acquireLock, renewLock, releaseLock, HEARTBEAT_MS } from '@pnr/store';
import { ingestAll } from '@pnr/feed';
import { enrichPending } from '@pnr/reader';
import { resolveProvider, readSettings, pruneVectors } from '@pnr/ai';
import { listWatches, prepareWatch } from '@pnr/watch';
import { recallForWatch, judgeAll, gateWatch } from '@pnr/recall';
import { generateDigest, generateProgress, generateFlashes } from '@pnr/generate';
import { setSink, log } from '@pnr/core';

type Mode = 'daily' | 'flashes' | 'fetch';

const mode = (process.argv[2] ?? 'daily') as Mode;
const dataDir = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const db = openDb(join(dataDir, 'newsroom.db'));

const runId = `${mode}-${Date.now()}`;
db.prepare('INSERT INTO runs (id, kind, started_at) VALUES (?, ?, ?)').run(runId, mode, Date.now());

// Every log line lands in the database, because there is no console for the
// user to look at when this runs at 6am with the app closed.
const insEvent = db.prepare(
  `INSERT INTO events (run_id, at, event, stage, phase, entity_type, entity_id, outcome,
                       reason_code, reason_detail, elapsed_ms, attrs_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);
setSink((e) => {
  insEvent.run(runId, Date.now(), e.event, e.stage ?? null, e.phase ?? null,
    e.entityType ?? null, e.entityId ?? null, e.outcome ?? null, e.reasonCode ?? null,
    e.reasonDetail ?? null, e.elapsedMs ?? null, e.attrs ? JSON.stringify(e.attrs) : null);
});

const finish = (outcome: 'ok' | 'partial' | 'failed', stats: Record<string, unknown>): void => {
  db.prepare('UPDATE runs SET finished_at = ?, outcome = ?, stats_json = ? WHERE id = ?')
    .run(Date.now(), outcome, JSON.stringify(stats), runId);
};

async function main(): Promise<void> {
  const lockName = mode === 'flashes' ? 'flashes' : 'daily';
  if (!acquireLock(db, lockName)) {
    // The app is doing this right now. Missing one scheduled run is correct;
    // running it twice is not.
    log({ event: 'worker.skipped', reasonCode: 'locked' });
    finish('ok', { skipped: 'locked' });
    return;
  }
  const beat = setInterval(() => renewLock(db, lockName), HEARTBEAT_MS);

  try {
    const stats: Record<string, unknown> = { mode };

    if (mode === 'fetch' || mode === 'daily') {
      const ing = await ingestAll(db, 8);
      stats['fetched'] = ing.inserted;
      const en = await enrichPending(db, dataDir, mode === 'daily' ? 60 : 25, 5);
      stats['extracted'] = en.ok;
    }
    if (mode === 'fetch') { finish('ok', stats); return; }

    const provider = await resolveProvider(db);
    if (!provider) {
      // Not an error: the app is perfectly usable as an RSS reader with no key.
      log({ event: 'worker.no_provider', phase: 'skipped' });
      finish('ok', { ...stats, ai: 'not_configured' });
      return;
    }

    const lang = readSettings(db).outputLang ?? 'zh-CN';
    const watches = listWatches(db, true);
    stats['watches'] = watches.length;
    if (watches.length === 0) { finish('ok', stats); return; }

    if (mode === 'flashes') {
      let published = 0;
      for (const w of watches) {
        try { published += (await generateFlashes(db, provider, w, w.outputLang ?? lang)).length; }
        catch (e) { log({ event: 'worker.flash', phase: 'failed', entityId: w.id, reasonDetail: String(e).slice(0, 120) }); }
      }
      finish('ok', { ...stats, published });
      return;
    }

    // daily
    const ready = [];
    let failed = 0;
    for (const w of watches) {
      try {
        const prepared = await prepareWatch(db, provider, w);
        const cands = await recallForWatch(db, provider, prepared, { windowHours: 72, maxJudged: 40 });
        await judgeAll(db, provider, prepared, cands);
        gateWatch(db, prepared, 'balanced');
        ready.push(prepared);
      } catch (e) {
        failed++;
        log({ event: 'worker.watch', phase: 'failed', entityId: w.id, reasonDetail: String(e).slice(0, 120) });
      }
    }
    const digest = ready.length ? await generateDigest(db, provider, ready, lang) : null;
    for (const w of ready) {
      try { await generateProgress(db, provider, w, w.outputLang ?? lang); }
      catch (e) { log({ event: 'worker.progress', phase: 'failed', entityId: w.id, reasonDetail: String(e).slice(0, 120) }); }
    }

    // Vectors are the one thing that grows without bound (~3.2 KB each).
    const pruned = pruneVectors(db, 180);
    finish(failed > 0 ? 'partial' : 'ok', { ...stats, processed: ready.length, failed, digest: Boolean(digest), pruned });
  } catch (e) {
    log({ event: 'worker.failed', reasonDetail: String(e).slice(0, 200) });
    finish('failed', { mode, error: String(e).slice(0, 200) });
    process.exitCode = 1;
  } finally {
    clearInterval(beat);
    releaseLock(db, mode === 'flashes' ? 'flashes' : 'daily');
    db.close();
  }
}

// Not top-level await: this bundles to CommonJS so launchd can run it with a
// plain `node worker.cjs`, and CJS has no top-level await.
void main().catch((e) => {
  log({ event: 'worker.crashed', reasonDetail: String(e).slice(0, 200) });
  finish('failed', { mode, error: String(e).slice(0, 200) });
  process.exitCode = 1;
});
