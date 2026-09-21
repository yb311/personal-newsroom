/**
 * Dates as the person using the app sees them. "Today's" digest belongs to the
 * local calendar day: the scheduled run at 07:15 in Beijing is 23:15 UTC the
 * day before, and keying it by the UTC date filed it under yesterday.
 */
const pad = (n: number): string => String(n).padStart(2, '0');

/** YYYY-MM-DD in the local timezone. */
export function localDateKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD HH:mm in the local timezone, for prompts and logs. */
export function localDateTime(ts: number): string {
  const d = new Date(ts);
  return `${localDateKey(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
