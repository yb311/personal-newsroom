/*
 * pnr-wake: wakes the Mac for the day's brief.
 *
 * launchd never runs anything while the Mac sleeps, so on the day's time the
 * Mac has to be woken, which needs root. This program is that one privileged
 * piece: a launch daemon (Contents/Library/LaunchDaemons/
 * com.yb311.personal-newsroom.wakeup.plist) that 所闻 registers through
 * SMAppService and the person approves once in System Settings → General →
 * Login Items & Extensions. macOS only launches it while its signature is
 * 所闻's, and it goes away with the app.
 *
 * Every run (at load and every 15 minutes while awake) it keeps exactly one
 * wake booked, at HH:15:50 on the next day's time — just before the background
 * agent's minute 16 — and cancels any other wake it booked earlier. It reads
 * the choice from wake.conf in the logged-in person's data folder, which the
 * app writes: "1 7" (wake, at 7) or "0 7" (don't). Only those digits are
 * taken from the file; nothing in it is executed.
 *
 * Wakes are booked through IOKit, the API behind `pmset schedule`, under the
 * owner name 所闻, so `pmset -g sched` shows whose they are and only our own
 * are ever cancelled.
 *
 *   pnr-wake --plan <wake.conf> <unix time>   prints the wake it would book
 *                                              (offline test; books nothing)
 */
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <fcntl.h>
#include <math.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define OWNER "所闻"
/* The app's data folder (defaultDataDir in packages/store/src/db.ts). */
#define CONF "/Library/Application Support/personal-newsroom/wake.conf"

/* The hour to wake at, or -1 for no wake. `owner` is the uid the file must
 * belong to, or -1 to skip that check (--plan). Symlinks are not followed. */
static int read_conf(const char *path, uid_t owner) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  struct stat st;
  char buf[16] = {0};
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || (owner != (uid_t)-1 && st.st_uid != owner)) {
    close(fd);
    return -1;
  }
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n < 3 || buf[0] != '1' || buf[1] != ' ' || buf[2] < '0' || buf[2] > '9') return -1;
  int hour = buf[2] - '0';
  if (buf[3] >= '0' && buf[3] <= '9') hour = hour * 10 + (buf[3] - '0');
  return hour <= 23 ? hour : -1;
}

/* The next HH:15:50 in local time at least a minute away. */
static time_t next_wake(int hour, time_t now) {
  struct tm t;
  localtime_r(&now, &t);
  t.tm_hour = hour; t.tm_min = 15; t.tm_sec = 50; t.tm_isdst = -1;
  time_t at = mktime(&t);
  if (at <= now + 60) {
    localtime_r(&now, &t);
    t.tm_mday += 1; t.tm_hour = hour; t.tm_min = 15; t.tm_sec = 50; t.tm_isdst = -1;
    at = mktime(&t);
  }
  return at;
}

/* Leaves exactly `want` booked under OWNER (nothing when want is 0). */
static void book(time_t want) {
  CFStringRef owner = CFStringCreateWithCString(NULL, OWNER, kCFStringEncodingUTF8);
  CFStringRef wake = CFSTR(kIOPMAutoWake);
  CFAbsoluteTime target = (CFAbsoluteTime)want - kCFAbsoluteTimeIntervalSince1970;
  int have = 0;
  CFArrayRef events = IOPMCopyScheduledPowerEvents();
  if (events) {
    for (CFIndex i = 0; i < CFArrayGetCount(events); i++) {
      CFDictionaryRef e = CFArrayGetValueAtIndex(events, i);
      CFStringRef app = CFDictionaryGetValue(e, CFSTR(kIOPMPowerEventAppNameKey));
      CFStringRef type = CFDictionaryGetValue(e, CFSTR(kIOPMPowerEventTypeKey));
      CFDateRef at = CFDictionaryGetValue(e, CFSTR(kIOPMPowerEventTimeKey));
      if (!app || !type || !at || CFStringCompare(app, owner, 0) != kCFCompareEqualTo) continue;
      if (want && !have && CFEqual(type, wake) && fabs(CFDateGetAbsoluteTime(at) - target) < 1) { have = 1; continue; }
      IOPMCancelScheduledPowerEvent(at, app, type);
    }
    CFRelease(events);
  }
  if (want && !have) {
    CFDateRef at = CFDateCreate(NULL, target);
    IOPMSchedulePowerEvent(at, owner, wake);
    CFRelease(at);
  }
  CFRelease(owner);
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "--plan") == 0) {
    int hour = read_conf(argv[2], (uid_t)-1);
    if (hour < 0) puts("none");
    else printf("%ld\n", (long)next_wake(hour, (time_t)atoll(argv[3])));
    return 0;
  }
  if (argc != 1 || geteuid() != 0) return 64;
  /* The person at the screen. At the login window nobody is, and the
   * background agent cannot run either: leave the booking as it is. */
  struct stat console;
  if (stat("/dev/console", &console) != 0 || console.st_uid == 0) return 0;
  struct passwd *pw = getpwuid(console.st_uid);
  if (!pw || !pw->pw_dir) return 0;
  char path[1024];
  if (snprintf(path, sizeof path, "%s%s", pw->pw_dir, CONF) >= (int)sizeof path) return 0;
  int hour = read_conf(path, console.st_uid);
  book(hour < 0 ? 0 : next_wake(hour, time(NULL)));
  return 0;
}
