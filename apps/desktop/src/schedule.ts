import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Db } from '@pnr/store';
import { makeWorkerHelper, workerExecutable, WORKER_EXECUTABLE } from '../../../packaging/worker-helper.mjs';
import { installWake, removeWake, wakeState, writeWakeConfig, type WakeMode, type WakeOutcome, type WakeState } from './wake.ts';

const run = promisify(execFile);

/** The one background agent: hourly at minute 16, the worker decides what is due. */
export const LABEL = 'com.yb311.personal-newsroom.update';
const SERVICE = `${LABEL}.plist`;
/** Earlier versions ran two agents, a daily one and a flash one. Removed on upgrade. */
const LEGACY = ['com.yb311.personal-newsroom.daily', 'com.yb311.personal-newsroom.flashes'];
/** Bumped when the agents change shape, so an upgrade registers them again. */
const LAYOUT = '2';
const FLASH_INTERVAL_HOURS = 3;

/**
 * Background scheduling on macOS.
 *
 * launchd is the right tool rather than a timer inside the app, because the
 * promise is that this keeps working while the app is closed. launchd does not
 * run anything while the Mac sleeps — it runs a missed time once on wake — so
 * the wake component (wake.ts) wakes the Mac for it.
 *
 * One agent runs 「所闻 后台更新」 (packaging/worker-helper.mjs) at minute 16 of
 * every hour; the worker decides whether the day's run or a flash check is due,
 * so changing the hour never needs anything registered again. Activity
 * Monitor, Login Items and any permission prompt name the app it belongs to.
 *
 * Signed packaged builds register it through SMAppService (Electron's
 * `agentService`), so it appears under System Settings → General → Login Items
 * & Extensions and disappears when the app is dragged to the Trash.
 * SMAppService refuses anything without a Developer ID signature, so local
 * builds and dev runs use a plist in ~/Library/LaunchAgents instead (removed
 * again when switched off) — before this fallback the switch just flipped back.
 */
export interface ScheduleState {
  enabled: boolean;
  mode: 'agentService' | 'launchAgent' | 'unsupported';
  dailyHour: number;
  flashIntervalHours: number;
  lastRun: { kind: string; at: number; outcome: string | null; stats: unknown } | null;
  plistPath: string | null;
  status?: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found';
  /** Why switching it on did not take, as a reason code the window translates. */
  problem?: 'not_registered' | 'worker_missing' | 'launchd_failed' | 'wake_cancelled' | 'wake_failed';
  /** The background job's process name, as Activity Monitor shows it. */
  workerName: string;
  /** Waking the Mac from sleep: what is chosen, whether the component is installed, the next wake. */
  wake: WakeState & { choice: WakeMode };
}

const userAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
const agentPlist = (label: string): string => join(userAgentsDir, `${label}.plist`);
const uid = (): number => process.getuid?.() ?? 501;
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistXml(opts: { program: string; workerPath: string; dataDir: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.program)}</string>
    <string>-e</string>
    <string>${xml(`require(${JSON.stringify(opts.workerPath)})`)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>PNR_SCHEDULED_RUN</key><string>1</string>
    <key>PNR_WORKER_MODE</key><string>auto</string>
    <key>PNR_DATA_DIR</key><string>${xml(opts.dataDir)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>16</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict>
</plist>
`;
}

/** The named helper and the worker script for a plist of our own: inside the
 *  bundle when packaged, next to the dev Electron and in apps/worker otherwise. */
function agentPaths(): { program: string; worker: string } {
  const frameworks = join(dirname(process.execPath), '..', 'Frameworks');
  const program = workerExecutable(frameworks);
  if (app.isPackaged) return { program, worker: join(process.resourcesPath, 'app.asar', 'worker.cjs') };
  // Rebuilt when missing, e.g. after `npm ci` replaced the Electron download.
  if (!existsSync(program)) makeWorkerHelper(frameworks, { adhocSign: true });
  return { program, worker: join(app.getAppPath(), '..', 'worker', 'dist', 'worker.cjs') };
}

/** Where the app is, for the wake component to check it is still installed. */
const appLocation = (): string => app.isPackaged ? join(dirname(process.execPath), '..', '..') : app.getAppPath();

function loginItemStatus(service: string): ScheduleState['status'] | undefined {
  try { return app.getLoginItemSettings({ type: 'agentService', serviceName: service }).status as ScheduleState['status']; }
  catch { return undefined; }
}

/** Agents of earlier versions: unregistered and their plists removed. */
async function removeLegacy(): Promise<void> {
  for (const label of LEGACY) {
    if (app.isPackaged) {
      try { app.setLoginItemSettings({ openAtLogin: false, type: 'agentService', serviceName: `${label}.plist` }); } catch { /* not registered */ }
    }
    await run('launchctl', ['bootout', `gui/${uid()}/${label}`]).catch(() => undefined);
    if (existsSync(agentPlist(label))) rmSync(agentPlist(label), { force: true });
  }
}

export async function enableSchedule(db: Db, dataDir: string, dailyHour = 7): Promise<ScheduleState> {
  setSetting(db, 'schedule.dailyHour', String(dailyHour));
  await removeLegacy();
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true, type: 'agentService', serviceName: SERVICE }); }
    catch { /* read back below */ }
    const status = loginItemStatus(SERVICE);
    if (status === 'enabled' || status === 'requires-approval') {
      await removeAgent();   // a plist left from an earlier fallback would run twice
      registered(db, 'agentService');
      return state(db, 'agentService', dailyHour);
    }
    // SMAppService only accepts an app signed with a Developer ID; a local or
    // ad-hoc build is refused ("code signature doesn't meet the requirements").
    // A per-user launch agent runs the same worker without that requirement.
  }
  return installAgent(db, dataDir, dailyHour);
}

function registered(db: Db, mode: 'agentService' | 'launchAgent'): void {
  setSetting(db, 'schedule.enabled', '1');
  setSetting(db, 'schedule.mode', mode);
  setSetting(db, 'schedule.registeredVersion', `${app.getVersion()}/${LAYOUT}`);
  syncWake(db);
}

/** The launch agent as a plist in ~/Library/LaunchAgents, loaded with launchctl. */
async function installAgent(db: Db, dataDir: string, dailyHour: number): Promise<ScheduleState> {
  const off = (problem: NonNullable<ScheduleState['problem']>): ScheduleState => {
    setSetting(db, 'schedule.enabled', '0'); syncWake(db);
    return { ...state(db, 'launchAgent', dailyHour), problem };
  };
  let paths: { program: string; worker: string };
  try { paths = agentPaths(); } catch { return off('launchd_failed'); }
  if (!app.isPackaged && !existsSync(paths.worker)) return off('worker_missing');
  mkdirSync(userAgentsDir, { recursive: true });
  const path = agentPlist(LABEL);
  writeFileSync(path, plistXml({ program: paths.program, workerPath: paths.worker, dataDir }));
  // bootout first so re-enabling picks up a changed plist.
  await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]).catch(() => undefined);
  const ok = await run('launchctl', ['bootstrap', `gui/${uid()}`, path]).then(() => true, () => false);
  if (!ok) return off('launchd_failed');
  registered(db, 'launchAgent');
  return state(db, 'launchAgent', dailyHour);
}

async function removeAgent(): Promise<void> {
  await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]).catch(() => undefined);
  if (existsSync(agentPlist(LABEL))) rmSync(agentPlist(LABEL), { force: true });
}

export async function disableSchedule(db: Db): Promise<ScheduleState> {
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: false, type: 'agentService', serviceName: SERVICE }); }
    catch { /* ignore */ }
  }
  await removeAgent();
  await removeLegacy();
  setSetting(db, 'schedule.enabled', '0');
  // No updates to wake for; the component stays, booking nothing.
  syncWake(db);
  return scheduleState(db);
}

/**
 * At launch: a new version of the app ships a new worker bundle and may ship
 * changed launch agents, so a job registered by an older version is registered
 * again — which also retries Login Items after a fallback, in case this build
 * is the signed one. Development rewrites its plist, whose paths can move
 * between checkouts. The wake component learns where the app is now.
 */
export async function refreshSchedule(db: Db, dataDir: string): Promise<void> {
  syncWake(db);
  if (getSetting(db, 'schedule.enabled') !== '1') return;
  if (app.isPackaged && getSetting(db, 'schedule.registeredVersion') === `${app.getVersion()}/${LAYOUT}`) return;
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: false, type: 'agentService', serviceName: SERVICE }); } catch { /* not registered */ }
  }
  await enableSchedule(db, dataDir, Number(getSetting(db, 'schedule.dailyHour') ?? '7'));
}

// ── waking from sleep ───────────────────────────────────────────────────────

/** What the person chose; waking every three hours unless they said otherwise. */
const wakeChoice = (db: Db): WakeMode => {
  const v = getSetting(db, 'schedule.wake');
  return v === 'off' || v === 'daily' ? v : 'all';
};

/** Tells the installed component what to book: nothing while updates are off. */
function syncWake(db: Db): void {
  const on = getSetting(db, 'schedule.enabled') === '1';
  writeWakeConfig(on ? wakeChoice(db) : 'off', Number(getSetting(db, 'schedule.dailyHour') ?? '7'), appLocation());
}

/**
 * Chooses how the Mac is woken. The first time it is needed the component is
 * installed, which shows the macOS administrator prompt (with `prompt` as its
 * text); after that only the settings file changes.
 */
export async function setWake(db: Db, choice: WakeMode, prompt: string): Promise<ScheduleState> {
  setSetting(db, 'schedule.wake', choice);
  let problem: ScheduleState['problem'];
  if (choice !== 'off' && !wakeState().installed) {
    const on = getSetting(db, 'schedule.enabled') === '1';
    const outcome: WakeOutcome = await installWake(on ? choice : 'off', Number(getSetting(db, 'schedule.dailyHour') ?? '7'), appLocation(), prompt);
    if (outcome !== 'ok') {
      // Declined or not an administrator: remember "off", so it is not asked again unprompted.
      setSetting(db, 'schedule.wake', 'off');
      problem = outcome === 'cancelled' ? 'wake_cancelled' : 'wake_failed';
    }
  }
  syncWake(db);
  return { ...scheduleState(db), ...(problem ? { problem } : {}) };
}

/** Removes the component entirely (administrator prompt), cancelling every booked wake. */
export async function uninstallWake(db: Db, prompt: string): Promise<ScheduleState> {
  const outcome = await removeWake(prompt);
  if (outcome === 'ok') setSetting(db, 'schedule.wake', 'off');
  return { ...scheduleState(db), ...(outcome === 'failed' ? { problem: 'wake_failed' as const } : {}) };
}

export function scheduleState(db: Db): ScheduleState {
  const mode = app.isPackaged && getSetting(db, 'schedule.mode') !== 'launchAgent' ? 'agentService' : 'launchAgent';
  return state(db, mode, Number(getSetting(db, 'schedule.dailyHour') ?? '7'));
}

function state(db: Db, mode: ScheduleState['mode'], dailyHour: number): ScheduleState {
  const last = db.prepare(
    `SELECT kind, started_at AS at, outcome, stats_json AS stats FROM runs
     WHERE kind IN ('daily', 'flashes', 'fetch') AND COALESCE(outcome, '') != 'skipped' ORDER BY started_at DESC LIMIT 1`
  ).get() as any;
  const status = app.isPackaged && mode === 'agentService' ? loginItemStatus(SERVICE) : undefined;
  const wanted = getSetting(db, 'schedule.enabled') === '1';
  // A plist of our own that has gone (removed by hand, or by a cleanup tool) is off.
  const present = mode !== 'launchAgent' || existsSync(agentPlist(LABEL));
  let stats: unknown = null;
  try { stats = last?.stats ? JSON.parse(last.stats) : null; } catch { /* keep null */ }
  return {
    enabled: wanted && present && (!status || status === 'enabled' || status === 'requires-approval'),
    mode, dailyHour, flashIntervalHours: FLASH_INTERVAL_HOURS, workerName: WORKER_EXECUTABLE,
    lastRun: last ? { kind: last.kind, at: last.at, outcome: last.outcome, stats } : null,
    plistPath: mode === 'launchAgent' ? agentPlist(LABEL) : null,
    wake: { ...wakeState(), choice: wakeChoice(db) },
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
