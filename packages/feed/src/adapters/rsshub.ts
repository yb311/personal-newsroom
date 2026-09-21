import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { DiscoveredItem, SourceRecord } from '@pnr/core';
import { cleanUrl, domainOf, log, DownloadError } from '@pnr/core';
import { fetchFeed } from '../parse.ts';
import type { Adapter, ParseResult } from './types.ts';

/**
 * RSSHub, in one of two modes.
 *
 * `http`    — an instance the user runs or trusts, called over HTTP. It serves
 *             plain RSS, so the existing parser handles the response and there
 *             is no extra code path to keep correct.
 * `library` — the npm package, imported directly. It ships `dist-lib/` with one
 *             pre-bundled module per route and exports `init`/`request`, so
 *             there is no server to run, no port to manage and no crash loop
 *             (docs/SPIKES.zh-CN.md §2). RSSHub is AGPL-3.0 and so is this
 *             project, so linking it is fine.
 *
 * No public instance is hardcoded as a default. Pointing this at someone else's
 * server by default would quietly hand that server the list of things the user
 * reads, which is the opposite of what this app promises.
 */
export type RssHubMode = 'off' | 'http' | 'library';

export interface RssHubConfig {
  /** Base URL of an instance, e.g. http://127.0.0.1:1200 */
  instanceUrl?: string | undefined;
  /** Directory holding an installed copy of the package. */
  packageDir?: string | undefined;
}

let config: RssHubConfig = {};
export function configureRssHub(next: RssHubConfig): void {
  config = next;
  mod = undefined;
  initing = null;
}

interface RssHubModule {
  init(conf?: Record<string, unknown>): Promise<void>;
  request(path: string): Promise<{ title?: string; item?: RssHubItem[] }>;
}
interface RssHubItem {
  title?: string; link?: string; description?: string;
  pubDate?: string | Date; author?: string; image?: string;
}

let mod: RssHubModule | null | undefined;
let initing: Promise<void> | null = null;

async function load(): Promise<RssHubModule | null> {
  if (mod !== undefined) return mod;
  try {
    // These must be set BEFORE the import: RSSHub's logger reads them while the
    // module is being evaluated, so setting them afterwards has no effect.
    process.env['LOG_LEVEL'] ??= 'error';
    process.env['NO_LOGFILES'] ??= 'true';
    // NO_LOGFILES is not always honoured, so send log files to the temp dir
    // rather than letting them land in the working directory.
    process.env['LOGGER_DIR'] ??= join(tmpdir(), 'pnr-rsshub-logs');
    let spec = 'rsshub';
    if (config.packageDir) {
      const entry = join(config.packageDir, 'node_modules', 'rsshub', 'dist-lib', 'pkg.mjs');
      if (!existsSync(entry)) throw new Error('pack_entry_missing');
      // A dynamic import() of a plain filesystem path is not reliable in ESM;
      // it has to be a file:// URL.
      spec = pathToFileURL(entry).href;
    }
    mod = (await import(spec)) as unknown as RssHubModule;
    initing ??= mod.init({});
    await initing;
  } catch {
    mod = null;
    log({ event: 'rsshub.unavailable', reasonCode: 'not_installed' });
  }
  return mod;
}

/** Which mode is actually usable right now. */
export async function rssHubMode(): Promise<RssHubMode> {
  if (config.instanceUrl) return 'http';
  return (await load()) ? 'library' : 'off';
}

export const rssHubAvailable = async (): Promise<boolean> => (await rssHubMode()) !== 'off';

/**
 * Silences RSSHub's own output for the duration of one call.
 *
 * It writes through its own logger straight to the streams rather than through
 * `console`, and prints a full stack trace for something as ordinary as a route
 * that does not exist. Failures are reported through this adapter's diagnostics
 * instead, so the streams are muted rather than left to spew at a desktop user.
 */
let muted = 0;
let saved: { out: typeof process.stdout.write; err: typeof process.stderr.write;
             error: typeof console.error; warn: typeof console.warn; log: typeof console.log; info: typeof console.info } | null = null;

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  // Counted, because RSSHub sources are fetched concurrently: a second call
  // must not save the first call's no-op functions as the "originals", or the
  // streams would stay muted for the rest of the process.
  if (muted++ === 0) {
    saved = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr),
              error: console.error, warn: console.warn, log: console.log, info: console.info };
    const mute = (): boolean => true;
    process.stdout.write = mute as typeof process.stdout.write;
    process.stderr.write = mute as typeof process.stderr.write;
    console.error = () => {}; console.warn = () => {}; console.log = () => {}; console.info = () => {};
  }
  try { return await fn(); }
  finally {
    if (--muted === 0 && saved) {
      process.stdout.write = saved.out; process.stderr.write = saved.err;
      console.error = saved.error; console.warn = saved.warn; console.log = saved.log; console.info = saved.info;
      saved = null;
    }
  }
}

/**
 * Reason codes for RSSHub failures, from its error message:
 * - route_not_found: the path matches no route (RSSHub gives an empty message)
 * - needs_browser: the route fell back to a headless browser, which the pack
 *   does not ship
 * - upstream_blocked / upstream_error: the site itself refused or failed
 */
function classify(message: string): string {
  if (!message.trim() || /does not exist|has been deleted|NotFoundError/i.test(message)) return 'route_not_found';
  if (/browserType\.launch|Executable doesn't exist|playwright|puppeteer/i.test(message)) return 'needs_browser';
  const status = Number(message.match(/:\s*(\d{3})\b/)?.[1]);
  if (status === 403 || status === 401 || status === 412 || status === 429) return 'upstream_blocked';
  if (status >= 400) return 'upstream_error';
  return 'route_error';
}

const miss = (code: string): ParseResult =>
  ({ items: [], diagnostics: { fetched: 0, kept: 0, droppedByReason: { [code]: 1 } } });

/** `url` holds the route path, e.g. "/telegram/channel/durov". */
export const rssHubAdapter: Adapter = async (source) => {
  const path = normalizeRoute(source.url);
  const mode = await rssHubMode();
  if (mode === 'off') return miss('rsshub_not_available');
  return mode === 'http' ? viaHttp(path, source) : viaLibrary(path, source);
};

async function viaHttp(path: string, source: SourceRecord): Promise<ParseResult> {
  const base = (config.instanceUrl ?? '').replace(/\/$/, '');
  try {
    // An instance serves plain RSS, so the normal parser applies unchanged.
    // Estimated dates are allowed here for the same reason as the library path:
    // several routes publish undated items, and dropping them loses the source.
    const res = await fetchFeed(source, { url: `${base}${path}`, allowEstimatedDate: true, timeoutMs: 30_000 });
    return { ...res, items: res.items.map((i) => ({ ...i, domain: i.domain || domainOf(base) })) };
  } catch (e) {
    const reason = e instanceof DownloadError ? e.reason : 'error';
    if (reason === 'not_found') return miss('route_not_found');
    // Anything else is the instance's problem, not the route's — an overloaded
    // or misconfigured instance must not be reported as "this source is dead".
    return miss(`instance_${reason}`);
  }
}

async function viaLibrary(path: string, source: SourceRecord): Promise<ParseResult> {
  const lib = await load();
  if (!lib) return miss('rsshub_not_available');

  let data: { title?: string; item?: RssHubItem[]; error?: { message?: string } };
  try {
    data = await quietly(() => lib.request(path));
  } catch (e) {
    return miss(classify(String((e as Error)?.message ?? e)));
  }
  // RSSHub reports failures in the result rather than by throwing. Which
  // failure it is matters to the person: a mistyped route, a route that needs
  // a browser, and a site refusing the request each call for different advice.
  if (data.error) return miss(classify(data.error.message ?? ''));
  const raw = data.item ?? [];
  if (raw.length === 0) return miss('empty');

  const dropped: Record<string, number> = {};
  const items: DiscoveredItem[] = [];
  // Several routes (Zhihu Daily among them) carry no publication date at all.
  // Dropping those loses the whole source, so the discovery time is used and
  // explicitly flagged rather than passed off as a publication time.
  const now = Date.now();
  for (const it of raw) {
    const title = String(it.title ?? '').trim();
    const link = String(it.link ?? '').trim();
    const parsed = it.pubDate ? new Date(it.pubDate).getTime() : NaN;
    const hasDate = Number.isFinite(parsed);
    const ts = hasDate ? parsed : now;
    if (!title) { dropped['no_title'] = (dropped['no_title'] ?? 0) + 1; continue; }
    if (!link || !/^https?:/i.test(link)) { dropped['no_url'] = (dropped['no_url'] ?? 0) + 1; continue; }
    if (!hasDate) dropped['date_estimated'] = (dropped['date_estimated'] ?? 0) + 1;
    const clean = cleanUrl(link);
    // Titles and descriptions are cleaned by the reader core at ingest, with
    // everything else that did not come through a feed parser.
    items.push({
      title, url: clean, publishedAt: new Date(ts).toISOString(),
      ...(hasDate ? {} : { publishedAtEstimated: true }),
      sourceId: source.id, sourceName: source.name || String(data.title ?? path),
      domain: domainOf(clean),
      ...(it.description ? { contentHtml: String(it.description) } : {}),
      ...(it.author ? { author: String(it.author) } : {}),
      ...(it.image ? { imageUrl: String(it.image) } : {}),
      ...(source.lang ? { lang: source.lang } : {})
    });
  }
  return { items, diagnostics: { fetched: raw.length, kept: items.length, droppedByReason: dropped } };
}

/** Accepts a bare route, a full rsshub.app URL, or a local instance URL. */
export function normalizeRoute(input: string): string {
  const s = input.trim();
  const m = s.match(/^https?:\/\/[^/]+(\/.*)$/);
  const path = m?.[1] ?? s;
  return path.startsWith('/') ? path : `/${path}`;
}
