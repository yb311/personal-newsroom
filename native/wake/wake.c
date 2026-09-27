/*
 * pnr-wake: what the wake daemon (com.yb311.personal-newsroom.wake) runs.
 *
 * It only hands the root-owned wake script to the system shell. It exists so
 * that the daemon's program carries 所闻's Developer ID signature: Background
 * Task Management attributes a daemon to an app (AssociatedBundleIdentifiers)
 * only when the program is signed by the same team, so a daemon running
 * /bin/sh is listed in Login Items as "sh" from an unidentified developer.
 *
 * It takes no arguments and runs one fixed path; keep SCRIPT in step with
 * DIR in apps/desktop/src/wake.ts. The installed copy lives in that
 * root-owned folder, never in the app bundle.
 */
#include <unistd.h>

#define SCRIPT "/Library/Application Support/com.yb311.personal-newsroom/schedule-wakes.sh"

int main(void) {
  char *const argv[] = { "sh", SCRIPT, 0 };
  char *const envp[] = { "PATH=/usr/bin:/bin:/usr/sbin:/sbin", 0 };
  execve("/bin/sh", argv, envp);
  return 127;
}
