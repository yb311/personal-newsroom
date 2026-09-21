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
import { runDaily, runFlashCheck } from '@pnr/generate';
import { setSink, log, withRunContext } from '@pnr/core';

type Mode = 'daily' | 'flashes' | 'fetch';

const mode = (process.env['PNR_WORKER_MODE'] ?? process.argv[2] ?? 'daily') as Mode;
process.title = mode === 'daily' ? '所闻 · 每日更新'
  : mode === 'flashes' ? '所闻 · 快讯检查' : '所闻 · 新闻抓取';
const dataDir = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const db = openDb(join(dataDir, 'newsroom.db'));

/** The packaged daily agent wakes every 30 minutes so a user-selected hour can
 * be honoured without rewriting the signed plist inside the app bundle. It
 * works only after the chosen local time and at most once per local day. */
function scheduledDailyIsDue(now = Date.now()): boolean {
  if (mode !== 'daily' || process.env['PNR_SCHEDULED_RUN'] !== '1') return true;
  const configured = db.prepare("SELECT value FROM settings WHERE key = 'schedule.dailyHour'")
    .get() as { value: string } | undefined;
  const hour = Math.min(23, Math.max(0, Number(configured?.value ?? '7')));
  const target = new Date(now);
  target.setHours(hour, 15, 0, 0);
  if (now < target.getTime()) return false;
  const last = db.prepare(
    "SELECT started_at FROM runs WHERE kind = 'daily' AND outcome IN ('ok','partial') ORDER BY started_at DESC LIMIT 1"
  ).get() as { started_at: number } | undefined;
  return !last || last.started_at < target.getTime();
}

if (!scheduledDailyIsDue()) {
  db.close();
  process.exit(0);
}

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
  insEvent.run(e.runId ?? runId, Date.now(), e.event, e.stage ?? null, e.phase ?? null,
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

    if (mode === 'fetch') {
      const ing = await ingestAll(db, 8, { dataDir });
      const en = await enrichPending(db, dataDir, 25, 5);
      finish('ok', { ...stats, fetched: ing.inserted, extracted: en.ok });
      return;
    }

    const provider = await resolveProvider(db);
    const opts = { dataDir, lang: readSettings(db).outputLang ?? 'zh-CN' };
    // Same runs as the app's buttons. With no AI they match watches by keywords.
    const result = mode === 'flashes' ? await runFlashCheck(db, provider, opts) : await runDaily(db, provider, opts);
    // Vectors are the one thing that grows without bound (~3.2 KB each).
    const pruned = mode === 'daily' && provider ? pruneVectors(db, 180) : 0;
    finish(result.failed > 0 ? 'partial' : 'ok', { ...stats, ...result, pruned });
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
void withRunContext(runId, main).catch((e) => {
  log({ event: 'worker.crashed', reasonDetail: String(e).slice(0, 200) });
  finish('failed', { mode, error: String(e).slice(0, 200) });
  process.exitCode = 1;
});
