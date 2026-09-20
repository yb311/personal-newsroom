const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_?|spm|from|share_|_hs|igshid|ncid|cmpid|smid)/i;

/** Strips tracking parameters while preserving parameters that identify content. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch { return raw; }
}

/**
 * Deduplication key, ported from daily-brief lib/evidence/evidence-source.ts.
 *
 * Folds www./m./amp. and scheme and host case and the trailing slash, but
 * deliberately KEEPS the query string, so sites that distinguish articles
 * purely by query string are never over-merged.
 */
export function canonicalDedupKey(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^(?:m|amp|mobile)\./, '');
    const path = (u.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    return `${host}${path}${u.search}`;
  } catch { return raw; }
}

export function domainOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
