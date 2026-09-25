import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

/**
 * Updating while the Mac sleeps.
 *
 * launchd never runs anything while the Mac is asleep; it only catches up on
 * wake. So the Mac has to be woken, and scheduling a wake (`pmset schedule
 * wake`) needs root. A small component is installed once, with the person's
 * administrator password:
 *
 *   /Library/LaunchDaemons/com.yb311.personal-newsroom.wake.plist
 *   /Library/Application Support/com.yb311.personal-newsroom/schedule-wakes.sh
 *
 * The script runs as root every hour and whenever the settings file changes,
 * and keeps the next day of wakes booked: at the daily time, and with flashes
 * every three hours after it. Each wake is at 15:50 past the hour, just before
 * the background agent's minute 16, which then does the work and keeps the Mac
 * awake until it is done.
 *
 * What runs as root is only that script, owned by root, calling the system's
 * own pmset and date. It reads `wake.conf` — the one file the app writes, so
 * changing the mode or hour never asks for the password again — and takes from
 * it only digits and a path it merely checks exists. Nothing from the app
 * bundle, which a user process can modify, ever runs as root.
 *
 * Whoever installs the app gets this from the same switch; it does not depend
 * on anything on the developer's Mac. An app dragged to the Trash stops being
 * woken for within the hour (the script checks the app is still where it was).
 */
export const WAKE_LABEL = 'com.yb311.personal-newsroom.wake';
const DIR = '/Library/Application Support/com.yb311.personal-newsroom';
const CONF = `${DIR}/wake.conf`;
const BOOKED = `${DIR}/wake.scheduled`;
const SCRIPT = `${DIR}/schedule-wakes.sh`;
const DAEMON = `/Library/LaunchDaemons/${WAKE_LABEL}.plist`;
/** Shown by `pmset -g sched` as the owner of each wake. */
const OWNER = '所闻';

export type WakeMode = 'off' | 'daily' | 'all';
export interface WakeState {
  installed: boolean;
  mode: WakeMode;
  /** The next booked wake, as a timestamp. */
  next: number | null;
}
export type WakeOutcome = 'ok' | 'cancelled' | 'failed';

const MODE_DIGIT: Record<WakeMode, string> = { off: '0', daily: '1', all: '2' };

const ROOT_SCRIPT = `#!/bin/sh
# 所闻：休眠时按时唤醒 Mac，让后台更新照常进行。
# 由 launchd 以 root 身份运行（${DAEMON}）。
# 只调用系统自带的 pmset 和 date；wake.conf 由 app 写入，只取其中的数字。
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
DIR="${DIR}"
CONF="$DIR/wake.conf"
BOOKED="$DIR/wake.scheduled"
OWNER="${OWNER}"

# wake.conf line 1: "<mode> <hour>" — mode 0 = off, 1 = the daily time,
# 2 = also every 3 hours. Line 2: where the app is. When it is gone (dragged to
# the Trash) nothing is booked, so an uninstalled app never wakes the Mac; the
# app writes its new place on its next launch if it was only moved.
mode=0; hour=7
if [ -f "$CONF" ]; then
  line=$(head -n 1 "$CONF" | tr -cd '0-9 ')
  set -- $line
  case "\${1:-}" in 0|1|2) mode=$1 ;; esac
  case "\${2:-}" in [0-9]|1[0-9]|2[0-3]) hour=$2 ;; esac
  app=$(sed -n 2p "$CONF")
  if [ -z "$app" ] || [ ! -d "$app" ]; then mode=0; fi
fi

# The next 26 hours of wakes, at 15:50 past each hour that is due.
now=$(date +%s)
wanted=""
if [ "$mode" != 0 ]; then
  for day in 0 1; do
    d=$(date -v+\${day}d +%Y-%m-%d)
    k=0
    while [ $k -lt 8 ]; do
      if [ "$mode" = 1 ] && [ $k -gt 0 ]; then break; fi
      h=$(( (hour + 3 * k) % 24 ))
      at=$(date -j -f "%Y-%m-%d %H:%M:%S" "$d $h:15:50" +%s)
      if [ "$at" -gt $((now + 60)) ] && [ "$at" -le $((now + 26 * 3600)) ]; then
        wanted="$wanted$(date -j -r "$at" "+%m/%d/%y %H:%M:%S")
"
      fi
      k=$((k + 1))
    done
  done
fi

# Cancel what this script booked before, then book the wanted set: rerunning
# is harmless, and a changed hour or mode leaves nothing stale behind.
old=""
if [ -f "$BOOKED" ]; then old=$(cat "$BOOKED"); fi
printf '%s\\n%s' "$old" "$wanted" | sort -u | while IFS= read -r t; do
  if [ -n "$t" ]; then pmset schedule cancel wake "$t" "$OWNER" >/dev/null 2>&1; fi
done
printf '%s' "$wanted" | while IFS= read -r t; do
  if [ -n "$t" ]; then pmset schedule wake "$t" "$OWNER" >/dev/null 2>&1; fi
done
printf '%s' "$wanted" > "$BOOKED"
chmod 644 "$BOOKED"
`;

const DAEMON_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WAKE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${SCRIPT}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>WatchPaths</key><array><string>${CONF}</string></array>
</dict>
</plist>
`;

/** The script, for the offline test. */
export const wakeScriptForTest = ROOT_SCRIPT;

export function wakeState(): WakeState {
  const installed = existsSync(DAEMON) && existsSync(SCRIPT);
  let mode: WakeMode = 'off';
  let next: number | null = null;
  if (installed) {
    try {
      const digit = readFileSync(CONF, 'utf8').split('\n')[0]!.trim().split(/\s+/)[0];
      mode = digit === '2' ? 'all' : digit === '1' ? 'daily' : 'off';
    } catch { /* unreadable → off */ }
    try {
      const now = Date.now();
      next = readFileSync(BOOKED, 'utf8').split('\n').map(parseBooked)
        .filter((t): t is number => t !== null && t > now).sort((a, b) => a - b)[0] ?? null;
    } catch { /* nothing booked yet */ }
  }
  return { installed, mode, next };
}

/** "09/25/26 07:15:50" in local time. */
function parseBooked(line: string): number | null {
  const m = /^(\d\d)\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(line.trim());
  return m ? new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() : null;
}

const confText = (mode: WakeMode, hour: number, appPath: string): string =>
  `${MODE_DIGIT[mode]} ${Math.min(23, Math.max(0, Math.round(hour)))}\n${appPath.replace(/\n/g, '')}\n`;

/** Changes what is booked. Needs no password: only wake.conf is written. */
export function writeWakeConfig(mode: WakeMode, hour: number, appPath: string): boolean {
  if (!existsSync(DAEMON)) return false;
  try {
    const text = confText(mode, hour, appPath);
    // Unchanged: leave the file alone, so launchd's WatchPaths does not fire.
    if (existsSync(CONF) && readFileSync(CONF, 'utf8') === text) return true;
    writeFileSync(CONF, text); return true;
  } catch { return false; }
}

/** Runs shell commands as root after the macOS administrator prompt. */
async function asAdmin(commands: string, prompt: string): Promise<WakeOutcome> {
  const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  try {
    await run('/usr/bin/osascript', ['-e', `do shell script ${quote(commands)} with prompt ${quote(prompt)} with administrator privileges`]);
    return 'ok';
  } catch (e) {
    // -128: the person pressed Cancel.
    return /-128|User canceled|用户已取消/.test(String((e as { stderr?: string }).stderr ?? e)) ? 'cancelled' : 'failed';
  }
}

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The root commands that install the component from files staged in `staged`. */
export function installCommands(staged: string, uid: number): string {
  return [
    'set -e',
    `mkdir -p ${sh(DIR)}`, `chown root:wheel ${sh(DIR)}`, `chmod 755 ${sh(DIR)}`,
    `install -o root -g wheel -m 755 ${sh(join(staged, 'schedule-wakes.sh'))} ${sh(SCRIPT)}`,
    // The one file the app writes afterwards, so it belongs to the person.
    `install -o ${uid} -g staff -m 644 ${sh(join(staged, 'wake.conf'))} ${sh(CONF)}`,
    `install -o root -g wheel -m 644 ${sh(join(staged, 'wake.plist'))} ${sh(DAEMON)}`,
    `launchctl bootout system/${WAKE_LABEL} 2>/dev/null || true`,
    `launchctl bootstrap system ${sh(DAEMON)}`
  ].join('\n');
}

/** The root commands that cancel every booked wake and remove the component. */
export function removeCommands(): string {
  return [
    `launchctl bootout system/${WAKE_LABEL} 2>/dev/null || true`,
    `if [ -f ${sh(BOOKED)} ]; then while IFS= read -r t; do [ -n "$t" ] && pmset schedule cancel wake "$t" ${sh(OWNER)} >/dev/null 2>&1; done < ${sh(BOOKED)}; fi`,
    `rm -f ${sh(DAEMON)}`, `rm -rf ${sh(DIR)}`
  ].join('\n');
}

export async function installWake(mode: WakeMode, hour: number, appPath: string, prompt: string): Promise<WakeOutcome> {
  const tmp = mkdtempSync(join(tmpdir(), 'pnr-wake-'));
  try {
    writeFileSync(join(tmp, 'schedule-wakes.sh'), ROOT_SCRIPT);
    writeFileSync(join(tmp, 'wake.plist'), DAEMON_PLIST);
    writeFileSync(join(tmp, 'wake.conf'), confText(mode, hour, appPath));
    return await asAdmin(installCommands(tmp, process.getuid?.() ?? 501), prompt);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Cancels every booked wake and removes the component. */
export async function removeWake(prompt: string): Promise<WakeOutcome> {
  return asAdmin(removeCommands(), prompt);
}
