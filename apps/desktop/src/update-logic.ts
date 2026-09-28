/**
 * The parts of updating that need no Electron, so the offline tests cover them.
 * updater.ts wires them to electron-updater and the windows.
 */

export type UpdatePhase =
  | 'unsupported'   // development run, or not where macOS lets an app replace itself
  | 'idle'          // nothing checked yet in this session
  | 'checking'
  | 'upToDate'
  | 'downloading'
  | 'ready'         // downloaded; installs on restart or at the next quit
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  /** The newer version being downloaded or ready. */
  version: string | null;
  /** Download progress, 0–100. */
  percent: number | null;
  /** Why updating is unavailable, or why the last check failed — a code the interface translates. */
  reason: 'dev' | 'location' | 'offline' | 'failed' | null;
  checkedAt: number | null;
  auto: boolean;
}

/** How often a running app looks for a new version. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Left alone right after launch, so the first check does not compete with loading. */
export const FIRST_CHECK_DELAY_MS = 15 * 1000;

export const AUTO_UPDATE_KEY = 'update.auto';
export const MOVE_DECLINED_KEY = 'update.moveDeclined';

/** Automatic checks are on unless the person switched them off. */
export const autoEnabled = (stored: string | undefined): boolean => stored !== '0';

/** Whether this build can update itself at all, and why not. */
export function support(opts: { packaged: boolean; inApplications: boolean }): UpdateState['reason'] {
  if (!opts.packaged) return 'dev';
  // Squirrel replaces the bundle in place; a copy running from the disk image
  // or from a translocated Downloads folder cannot be replaced.
  if (!opts.inApplications) return 'location';
  return null;
}

/** Network failures are told apart from the rest: they fix themselves. */
export function failureReason(error: unknown): 'offline' | 'failed' {
  const text = String((error as { code?: string; message?: string })?.code ?? '') + ' ' + String((error as Error)?.message ?? error);
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|net::/i.test(text) ? 'offline' : 'failed';
}

/**
 * Release notes as plain text for a native dialog. GitHub hands them over as
 * HTML (the generated "What's Changed" list); a dialog shows text only.
 */
export function notesText(notes: unknown, max = 600): string {
  const raw = Array.isArray(notes)
    ? notes.map((n) => String((n as { note?: string })?.note ?? '')).join('\n')
    : String(notes ?? '');
  const text = raw
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|li|h\d|ul|ol)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    // GitHub's generated notes end with a compare link; it means nothing in a dialog.
    .replace(/^\s*\*?\*?Full Changelog\*?\*?:.*$/gim, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
