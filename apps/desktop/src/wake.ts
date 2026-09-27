import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Updating while the Mac sleeps: the app's side.
 *
 * launchd runs nothing while the Mac sleeps; a missed hourly run happens once
 * on wake. So flashes catch up by themselves the moment the Mac wakes, and
 * the one thing worth waking it for is the day's brief, ready when the person
 * sits down. That wake needs root, and so is the job of pnr-wake
 * (native/wake/wake.c): a launch daemon inside the app bundle, registered
 * through SMAppService (Electron's `daemonService`, see schedule.ts) and
 * approved once in System Settings. macOS launches it only while it carries
 * 所闻's signature, lists it under 所闻 in Login Items, and removes it with the
 * app.
 *
 * The app tells it what to do through one file in the data folder,
 * wake.conf: "1 7" (wake at 7:15:50) or "0 7" (don't). The daemon reads it at
 * load and every 15 minutes, so a changed time takes effect within a quarter
 * of an hour.
 */
export const WAKE_SERVICE = 'com.yb311.personal-newsroom.wakeup.plist';
/** Shown by `pmset -g sched` as the owner of the wake; pnr-wake books under it. */
const OWNER = '所闻';

export const wakeConfText = (on: boolean, hour: number): string =>
  `${on ? 1 : 0} ${Math.min(23, Math.max(0, Math.round(hour)))}\n`;

/** Writes wake.conf when it changed. */
export function writeWakeConfig(dataDir: string, on: boolean, hour: number): void {
  const path = join(dataDir, 'wake.conf');
  const text = wakeConfText(on, hour);
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
    writeFileSync(path, text);
  } catch { /* the daemon then books nothing */ }
}

/** The next wake booked under 所闻, from `pmset -g sched` output. */
export function parseNextWake(sched: string, now = Date.now()): number | null {
  const times: number[] = [];
  for (const line of sched.split('\n')) {
    const m = /wake(?:orpoweron)? at (\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d) by '([^']*)'/.exec(line);
    if (!m || m[7] !== OWNER) continue;
    const at = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    if (at > now) times.push(at);
  }
  return times.sort((a, b) => a - b)[0] ?? null;
}

export function nextWake(): number | null {
  try { return parseNextWake(execFileSync('/usr/bin/pmset', ['-g', 'sched'], { encoding: 'utf8', timeout: 3000 })); }
  catch { return null; }
}
