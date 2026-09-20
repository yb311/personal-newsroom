import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Db } from '@pnr/store';

const run = promisify(execFile);

export const LABEL_DAILY = 'com.yb311.personal-newsroom.daily';
export const LABEL_FLASHES = 'com.yb311.personal-newsroom.flashes';

/**
 * Background scheduling on macOS.
 *
 * launchd is the right tool rather than a timer inside the app, because the
 * promise is that this keeps working while the app is closed. Its behaviour
 * also happens to be exactly what a news reader wants: it does not run while
 * the Mac is asleep, and on wake it runs the missed occurrence ONCE rather than
 * every one it slept through.
 *
 * Packaged builds register through SMAppService (Electron's `agentService`), so
 * the job appears under System Settings → General → Login Items and disappears
 * when the app is dragged to the Trash. Unpackaged dev builds fall back to a
 * plist in ~/Library/LaunchAgents, which has to be removed explicitly.
 */
export interface ScheduleState {
  enabled: boolean;
  mode: 'agentService' | 'launchAgent' | 'unsupported';
  dailyHour: number;
  flashIntervalHours: number;
  lastRun: { kind: string; at: number; outcome: string | null; stats: unknown } | null;
  plistPath: string | null;
}

const userAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
const devPlist = (label: string): string => join(userAgentsDir, `${label}.plist`);

function plistXml(opts: {
  label: string; nodePath: string; workerPath: string; mode: string;
  dataDir: string; calendarHour?: number; intervalSeconds?: number;
}): string {
  const schedule = opts.calendarHour !== undefined
    ? `  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${opts.calendarHour}</integer><key>Minute</key><integer>15</integer></dict>`
    : `  <key>StartInterval</key>
  <integer>${opts.intervalSeconds ?? 10800}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.workerPath}</string>
    <string>${opts.mode}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PNR_DATA_DIR</key><string>${opts.dataDir}</string></dict>
${schedule}
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict>
</plist>
`;
}

function paths(dataDir: string): { node: string; worker: string } {
  if (app.isPackaged) {
    // The packaged app carries its own Node; the worker never depends on one
    // being installed on the user's machine.
    return {
      node: join(process.resourcesPath, 'node'),
      worker: join(process.resourcesPath, 'worker.cjs')
    };
  }
  return { node: process.execPath.includes('Electron') ? 'node' : process.execPath,
           worker: join(app.getAppPath(), '..', 'worker', 'dist', 'worker.cjs') };
}

export async function enableSchedule(db: Db, dataDir: string, dailyHour = 7): Promise<ScheduleState> {
  const { node, worker } = paths(dataDir);
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: false, type: 'agentService', serviceName: LABEL_DAILY });
      app.setLoginItemSettings({ openAtLogin: false, type: 'agentService', serviceName: LABEL_FLASHES });
      setSetting(db, 'schedule.enabled', '1');
      return state(db, 'agentService', dailyHour);
    } catch { /* fall through to the plist path */ }
  }

  mkdirSync(userAgentsDir, { recursive: true });
  const jobs: [string, string, Record<string, number>][] = [
    [LABEL_DAILY, 'daily', { calendarHour: dailyHour }],
    [LABEL_FLASHES, 'flashes', { intervalSeconds: 3 * 3600 }]
  ];
  for (const [label, mode, when] of jobs) {
    const path = devPlist(label);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plistXml({ label, nodePath: node, workerPath: worker, mode, dataDir, ...when }));
    // bootout first so re-enabling picks up a changed plist.
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${label}`]).catch(() => undefined);
    await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, path]).catch(() => undefined);
  }
  setSetting(db, 'schedule.enabled', '1');
  setSetting(db, 'schedule.dailyHour', String(dailyHour));
  return state(db, 'launchAgent', dailyHour);
}

export async function disableSchedule(db: Db): Promise<ScheduleState> {
  for (const label of [LABEL_DAILY, LABEL_FLASHES]) {
    if (app.isPackaged) {
      try { app.setLoginItemSettings({ openAtLogin: false, type: 'agentService', serviceName: label }); }
      catch { /* ignore */ }
    }
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${label}`]).catch(() => undefined);
    const p = devPlist(label);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  setSetting(db, 'schedule.enabled', '0');
  return state(db, app.isPackaged ? 'agentService' : 'launchAgent', 7);
}

export function scheduleState(db: Db): ScheduleState {
  const mode = app.isPackaged ? 'agentService' : 'launchAgent';
  return state(db, mode, Number(getSetting(db, 'schedule.dailyHour') ?? '7'));
}

function state(db: Db, mode: ScheduleState['mode'], dailyHour: number): ScheduleState {
  const last = db.prepare(
    'SELECT kind, started_at AS at, outcome, stats_json AS stats FROM runs ORDER BY started_at DESC LIMIT 1'
  ).get() as any;
  return {
    enabled: getSetting(db, 'schedule.enabled') === '1',
    mode, dailyHour, flashIntervalHours: 3,
    lastRun: last ? { kind: last.kind, at: last.at, outcome: last.outcome,
                      stats: last.stats ? JSON.parse(last.stats) : null } : null,
    plistPath: app.isPackaged ? null : devPlist(LABEL_DAILY)
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
