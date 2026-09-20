import type { DiscoveredItem } from '@pnr/core';
import { cleanUrl, log } from '@pnr/core';
import type { Db } from '@pnr/store';
import type { Adapter, ParseResult, SourceRecord } from './types.ts';

/**
 * GDELT DOC 2.0. Optional, off by default.
 *
 * Measured behaviour (docs/SPIKES.zh-CN.md §3): the documented "one request per
 * five seconds" is optimistic. Once tripped, the IP stays blocked for tens of
 * minutes, and community testing shows that BACKING OFF MAKES IT WORSE — at a
 * 6s interval only 1 request in 7 succeeds, at 16s only 4 in 12. The correct
 * pattern is a circuit breaker: on rejection, stop calling entirely for a long
 * window and fail fast in the meantime.
 *
 * Three response shapes must be handled:
 *   1. normal JSON
 *   2. plain-text 429 (not JSON)
 *   3. HTTP 200 whose body is an error string, e.g. a keyword under 3 characters
 */
const ENDPOINT = 'gdelt.doc';
const OPEN_MS = 30 * 60_000;
const MIN_KEYWORD = 3;

function circuitOpen(db: Db | undefined): boolean {
  if (!db) return false;
  const row = db.prepare('SELECT state, reopen_at FROM circuit_breakers WHERE endpoint = ?').get(ENDPOINT) as
    | { state: string; reopen_at: number | null } | undefined;
  if (!row || row.state !== 'open') return false;
  if (row.reopen_at && Date.now() >= row.reopen_at) {
    db.prepare("UPDATE circuit_breakers SET state='closed', failure_count=0 WHERE endpoint=?").run(ENDPOINT);
    return false;
  }
  return true;
}

function trip(db: Db | undefined, reason: string): void {
  if (!db) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO circuit_breakers (endpoint, state, opened_at, reopen_at, failure_count, last_reason)
     VALUES (?, 'open', ?, ?, 1, ?)
     ON CONFLICT(endpoint) DO UPDATE SET state='open', opened_at=excluded.opened_at,
       reopen_at=excluded.reopen_at, failure_count=circuit_breakers.failure_count+1,
       last_reason=excluded.last_reason`
  ).run(ENDPOINT, now, now + OPEN_MS, reason);
  log({ event: 'gdelt.circuit_open', reasonCode: reason, attrs: { reopenInMin: OPEN_MS / 60_000 } });
}

/** `url` holds the query. Language/country become GDELT query operators —
 *  which is how one request can cover several languages at once. */
export const gdeltAdapter: Adapter = async (source, ctx) => {
  const db = ctx.db;
  if (circuitOpen(db)) {
    // Fail silently. GDELT is always a bonus source, never a dependency.
    return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { circuit_open: 1 } } };
  }

  let query = source.url.trim();
  if (!query) return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { empty_query: 1 } } };
  if (query.split(/\s+/).some((w) => w.replace(/["']/g, '').length < MIN_KEYWORD)) {
    // Would return HTTP 200 with "keyword was too short"; do not spend a request.
    return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { keyword_too_short: 1 } } };
  }
  if (source.lang) query += ` sourcelang:${source.lang}`;
  if (source.country) query += ` sourcecountry:${source.country}`;

  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + `?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=250&timespan=1d&format=json`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  let body: string;
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'personal-newsroom/0.1' } });
    body = await res.text();
    if (res.status === 429) { trip(db, 'http_429'); return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { http_429: 1 } } }; }
    if (!res.ok) { trip(db, `http_${res.status}`); return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { [`http_${res.status}`]: 1 } } }; }
  } catch {
    return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { network: 1 } } };
  } finally { clearTimeout(timer); }

  // Shape 3: HTTP 200 with a plain-text error, and shape 2 leaking through.
  if (!body.trimStart().startsWith('{')) {
    const rateLimited = /limit requests/i.test(body);
    if (rateLimited) trip(db, 'text_429');
    return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { [rateLimited ? 'text_429' : 'text_error']: 1 } } };
  }

  let payload: { articles?: any[] };
  try { payload = JSON.parse(body); }
  catch { return { items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { bad_json: 1 } } }; }

  const arts = payload.articles ?? [];
  const dropped: Record<string, number> = {};
  const items: DiscoveredItem[] = [];
  for (const a of arts) {
    const title = String(a.title ?? '').trim();
    const link = String(a.url ?? '').trim();
    const ts = parseSeenDate(String(a.seendate ?? ''));
    if (!title) { dropped['no_title'] = (dropped['no_title'] ?? 0) + 1; continue; }
    if (!link) { dropped['no_url'] = (dropped['no_url'] ?? 0) + 1; continue; }
    if (!Number.isFinite(ts)) { dropped['no_date'] = (dropped['no_date'] ?? 0) + 1; continue; }
    items.push({
      title, url: cleanUrl(link), publishedAt: new Date(ts).toISOString(),
      sourceId: source.id, sourceName: String(a.domain ?? source.name), domain: String(a.domain ?? ''),
      ...(a.language ? { lang: String(a.language) } : {}),
      ...(a.socialimage ? { imageUrl: String(a.socialimage) } : {})
    });
  }
  return { items, diagnostics: { fetched: arts.length, kept: items.length, droppedByReason: dropped } };
};

/** GDELT stamps dates as YYYYMMDDTHHMMSSZ. */
function parseSeenDate(s: string): number {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return Date.parse(s);
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}
