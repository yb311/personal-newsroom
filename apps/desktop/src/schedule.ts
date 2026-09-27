import { app } from 'electron';
import { dirname, join } from 'node:path';
import type { Db } from '@pnr/store';
import { WORKER_EXECUTABLE } from '../../../packaging/worker-helper.mjs';
import { WAKE_SERVICE, nextWake, writeWakeConfig } from './wake.ts';

/**
 * Background updates on macOS: two items inside the app bundle, both
 * registered through SMAppService, so they appear under 所闻 in System
 * Settings → General → Login Items & Extensions and go away with the app.
 *
 *   com.yb311.personal-newsroom.background (Contents/Library/LaunchAgents)
 *     runs 「所闻 后台更新」 (packaging/worker-helper.mjs) at minute 16 of every
 *     hour; the worker decides whether the day's run or a flash check is due,
 *     so changing the time never registers anything again.
 *   com.yb311.personal-newsroom.wakeup (Contents/Library/LaunchDaemons)
 *     pnr-wake, which wakes the Mac for the day's run (wake.ts).
 *
 * SMAppService accepts only a Developer ID–signed app, so development and
 * unsigned builds have no background updates; run the worker by hand there
 * (`npm run worker`). There is deliberately no fallback plist in
 * ~/Library/LaunchAgents: it listed the job under the certificate owner's
 * name, and the disabled record Background Task Management keeps for such a
 * label made SMAppService refuse that label for good.
 */
const AGENT = 'com.yb311.personal-newsroom.background.plist';
const FLASH_INTERVAL_HOURS = 3;

type LoginStatus = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found';
type Service = 'agentService' | 'daemonService';

export interface ScheduleState {
  /** Background updates are on (registered, possibly awaiting approval). */
  enabled: boolean;
  /** A packaged build; development cannot register with Login Items. */
  supported: boolean;
  status?: LoginStatus;
  dailyHour: number;
  flashIntervalHours: number;
  lastRun: { kind: string; at: number; outcome: string | null; stats: unknown } | null;
  /** Why switching something on did not take, as a reason code the window translates. */
  problem?: 'not_registered' | 'dev_build' | 'wake_not_registered';
  /** The background job's process name, as Activity Monitor shows it. */
  workerName: string;
  /** Waking the Mac for the day's run: chosen, its approval, the next booked wake. */
  wake: { on: boolean; status?: LoginStatus; next: number | null };
}

const loginStatus = (type: Service, serviceName: string): LoginStatus | undefined => {
  try { return app.getLoginItemSettings({ type, serviceName }).status as LoginStatus; }
  catch { return undefined; }
};
/** SMAppService reports refusals only on stderr, so the result is read back with loginStatus. */
const setLogin = (type: Service, serviceName: string, on: boolean): void => {
  try { app.setLoginItemSettings({ openAtLogin: on, type, serviceName }); } catch { /* read back */ }
};
const registeredOk = (s: LoginStatus | undefined): boolean => s === 'enabled' || s === 'requires-approval';

/** Where the app is: SMAppService resolves the bundled plists against it. */
const appLocation = (): string => join(dirname(process.execPath), '..', '..');
const hourOf = (db: Db): number => Number(getSetting(db, 'schedule.dailyHour') ?? '7');
/** Waking is on unless switched off. */
const wakeWanted = (db: Db): boolean => getSetting(db, 'schedule.wake') !== 'off';

export async function enableSchedule(db: Db, dataDir: string, dailyHour = 7): Promise<ScheduleState> {
  setSetting(db, 'schedule.dailyHour', String(dailyHour));
  if (!app.isPackaged) return { ...scheduleState(db), problem: 'dev_build' };
  setLogin('agentService', AGENT, true);
  if (!registeredOk(loginStatus('agentService', AGENT))) {
    setSetting(db, 'schedule.enabled', '0');
    applyWake(db, dataDir);
    return { ...scheduleState(db), problem: 'not_registered' };
  }
  setSetting(db, 'schedule.enabled', '1');
  setSetting(db, 'schedule.registeredVersion', app.getVersion());
  setSetting(db, 'schedule.registeredApp', appLocation());
  const problem = applyWake(db, dataDir);
  return { ...scheduleState(db), ...(problem ? { problem } : {}) };
}

export async function disableSchedule(db: Db, dataDir: string): Promise<ScheduleState> {
  if (app.isPackaged) setLogin('agentService', AGENT, false);
  setSetting(db, 'schedule.enabled', '0');
  applyWake(db, dataDir);
  return scheduleState(db);
}

/** Switches waking for the day's run on or off. */
export async function setWake(db: Db, dataDir: string, on: boolean): Promise<ScheduleState> {
  setSetting(db, 'schedule.wake', on ? 'on' : 'off');
  const problem = applyWake(db, dataDir);
  return { ...scheduleState(db), ...(problem ? { problem } : {}) };
}

/**
 * Writes wake.conf and registers or unregisters the wake daemon to match.
 * Registering the first time asks for approval in System Settings. Switched
 * off, wake.conf says so first, but the daemon is unregistered at once, so a
 * wake it already booked for the next morning still happens once.
 */
function applyWake(db: Db, dataDir: string): ScheduleState['problem'] {
  const on = getSetting(db, 'schedule.enabled') === '1' && wakeWanted(db);
  writeWakeConfig(dataDir, on, hourOf(db));
  if (!app.isPackaged) return undefined;
  setLogin('daemonService', WAKE_SERVICE, on);
  return on && !registeredOk(loginStatus('daemonService', WAKE_SERVICE)) ? 'wake_not_registered' : undefined;
}

/**
 * At launch. SMAppService resolves the bundled plists against the app, so a
 * new version, or the same version at another location (a moved app), is
 * registered again; otherwise the job keeps running the copy it was
 * registered from. wake.conf is rewritten in case it was lost.
 */
export async function refreshSchedule(db: Db, dataDir: string): Promise<void> {
  if (!app.isPackaged) return;
  if (getSetting(db, 'schedule.enabled') !== '1') { applyWake(db, dataDir); return; }
  if (getSetting(db, 'schedule.registeredVersion') !== app.getVersion()
      || getSetting(db, 'schedule.registeredApp') !== appLocation()) {
    setLogin('agentService', AGENT, false);
    await enableSchedule(db, dataDir, hourOf(db));
    return;
  }
  applyWake(db, dataDir);
}

export function scheduleState(db: Db): ScheduleState {
  const last = db.prepare(
    `SELECT kind, started_at AS at, outcome, stats_json AS stats FROM runs
     WHERE kind IN ('daily', 'flashes', 'fetch') AND COALESCE(outcome, '') != 'skipped' ORDER BY started_at DESC LIMIT 1`
  ).get() as any;
  const supported = app.isPackaged;
  const status = supported ? loginStatus('agentService', AGENT) : undefined;
  const enabled = supported && getSetting(db, 'schedule.enabled') === '1' && registeredOk(status);
  const wakeOn = enabled && wakeWanted(db);
  const wakeStatus = wakeOn ? loginStatus('daemonService', WAKE_SERVICE) : undefined;
  let stats: unknown = null;
  try { stats = last?.stats ? JSON.parse(last.stats) : null; } catch { /* keep null */ }
  return {
    enabled, supported, dailyHour: hourOf(db), flashIntervalHours: FLASH_INTERVAL_HOURS, workerName: WORKER_EXECUTABLE,
    lastRun: last ? { kind: last.kind, at: last.at, outcome: last.outcome, stats } : null,
    wake: { on: wakeWanted(db), next: wakeStatus === 'enabled' ? nextWake() : null, ...(wakeStatus ? { status: wakeStatus } : {}) },
    ...(status ? { status } : {})
  };
}

const getSetting = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

const setSetting = (db: Db, key: string, value: string): void => {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, Date.now());
};

/** Recent runs, for the settings page. A background job the user cannot see is
 *  a background job the user will not trust. */
export function recentRuns(db: Db, limit = 8): unknown[] {
  return db.prepare(
    `SELECT id, kind, started_at AS startedAt, finished_at AS finishedAt, outcome, stats_json AS stats
     FROM runs ORDER BY started_at DESC LIMIT ?`
  ).all(limit);
}
