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
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { openDb, defaultDataDir, acquireLock, renewLock, releaseLock, HEARTBEAT_MS } from '@pnr/store';
import { ingestAll } from '@pnr/feed';
import { enrichPending } from '@pnr/reader';
import { resolveProvider, readSettings, pruneVectors } from '@pnr/ai';
import { runDaily, runFlashCheck } from '@pnr/generate';
import { setSink, log, withRunContext, localDateKey } from '@pnr/core';

type Mode = 'daily' | 'flashes' | 'fetch';

/**
 * `auto` is what the background agent runs: it wakes at minute 16 of every hour
 * — including right after the Mac was woken from sleep for it (see the app's
 * wake.ts) — and decides here what is due: the day's run after the chosen
 * hour, else a flash check every three hours, else nothing. One agent rather
 * than two keeps the two from starting together and judging the same articles
 * twice.
 */
const requested = (process.env['PNR_WORKER_MODE'] ?? process.argv[2] ?? 'daily') as Mode | 'auto';
const scheduled = process.env['PNR_SCHEDULED_RUN'] === '1';
const dataDir = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const db = openDb(join(dataDir, 'newsroom.db'));
const setting = (key: string): string | undefined =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

/** The day's run is due only after the chosen local time, not when 全部更新
 * already ran since then, and at most once per local day — moving the hour
 * later in the afternoon must not buy a second full run. */
const SCHEDULED_DAY = 'schedule.lastDailyDate';
function dailyDue(now = Date.now()): boolean {
  if (setting(SCHEDULED_DAY) === localDateKey(now)) return false;
  const hour = Math.min(23, Math.max(0, Number(setting('schedule.dailyHour') ?? '7')));
  const target = new Date(now);
  target.setHours(hour, 15, 0, 0);
  if (now < target.getTime()) return false;
  const last = db.prepare(
    "SELECT started_at FROM runs WHERE kind = 'daily' AND outcome IN ('ok','partial') ORDER BY started_at DESC LIMIT 1"
  ).get() as { started_at: number } | undefined;
  return !last || last.started_at < target.getTime();
}

/** Flashes every three hours; the agent fires hourly, so a quarter of an hour's
 * slack keeps a check that ran at 7:16 from missing the one at 10:16. A full
 * run writes flashes too, so it counts. */
const FLASH_HOURS = 3;
function flashesDue(now = Date.now()): boolean {
  const last = db.prepare(
    "SELECT started_at FROM runs WHERE kind IN ('flashes','daily') AND outcome IN ('ok','partial') ORDER BY started_at DESC LIMIT 1"
  ).get() as { started_at: number } | undefined;
  return !last || last.started_at <= now - (FLASH_HOURS * 60 - 15) * 60_000;
}

const mode: Mode | null = requested === 'auto' ? (dailyDue() ? 'daily' : flashesDue() ? 'flashes' : null)
  // Agents registered by earlier versions name their mode; they get the same checks.
  : scheduled && requested === 'daily' ? (dailyDue() ? 'daily' : null)
  : scheduled && requested === 'flashes' ? (flashesDue() ? 'flashes' : null)
  : requested;
if (!mode) {
  db.close();
  process.exit(0);
}
process.title = mode === 'daily' ? '所闻 后台更新 · 每日更新'
  : mode === 'flashes' ? '所闻 后台更新 · 快讯检查' : '所闻 后台更新 · 新闻抓取';

if (scheduled) {
  // Hold the Mac awake until this run is done: after a scheduled wake macOS
  // goes back to sleep within a minute or two. caffeinate lets go when this
  // process exits, whatever way it exits.
  try { spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' }).unref(); }
  catch { /* keep going; it only shortens how long the Mac stays awake */ }
}

/** Just after a wake Wi-Fi may still be joining; wait up to half a minute. */
async function networkReady(): Promise<void> {
  for (let i = 0; i < 15; i++) {
    try { await lookup('www.apple.com'); return; } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
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

const finish = (outcome: 'ok' | 'partial' | 'failed' | 'skipped', stats: Record<string, unknown>): void => {
  db.prepare('UPDATE runs SET finished_at = ?, outcome = ?, stats_json = ? WHERE id = ?')
    .run(Date.now(), outcome, JSON.stringify(stats), runId);
};

async function main(): Promise<void> {
  const lockName = mode === 'flashes' ? 'flashes' : 'daily';
  if (!acquireLock(db, lockName)) {
    // The app is doing this right now. Missing one scheduled run is correct;
    // running it twice is not. Recorded as skipped, not ok, so the next hour
    // still sees the day's run as due.
    log({ event: 'worker.skipped', reasonCode: 'locked' });
    finish('skipped', { skipped: 'locked' });
    db.close();
    return;
  }
  if (scheduled && mode === 'daily') {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(SCHEDULED_DAY, localDateKey(), Date.now());
  }
  // The daily run also writes flashes, unless a flash check holds that lock.
  const extra = mode === 'daily' && acquireLock(db, 'flashes') ? ['flashes'] : [];
  const held = [lockName, ...extra];
  const beat = setInterval(() => { for (const l of held) renewLock(db, l); }, HEARTBEAT_MS);

  try {
    const stats: Record<string, unknown> = { mode, scheduled };
    if (scheduled) await networkReady();

    if (mode === 'fetch') {
      const ing = await ingestAll(db, 8, { dataDir });
      const en = await enrichPending(db, dataDir, 25, 5);
      finish('ok', { ...stats, fetched: ing.inserted, extracted: en.ok });
      return;
    }

    const provider = await resolveProvider(db);
    const opts = { dataDir, lang: readSettings(db).outputLang ?? 'zh-CN', flashes: held.includes('flashes') };
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
    for (const l of held) releaseLock(db, l);
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
