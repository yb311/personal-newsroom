/**
 * The app's one way of downloading things from the web — feeds, sitemaps and
 * article pages alike.
 *
 * It stays in Node rather than in the reader core because some publishers
 * accept only clients whose TLS handshake they recognise: France 24 answers Go's
 * HTTP client and curl with 403 and Node's fetch with the article. Parsing and
 * extraction happen in the reader core on the bytes returned here.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const ACCEPT_FEED = 'application/rss+xml, application/atom+xml, application/rdf+xml, application/feed+json, application/xml, text/xml, */*;q=0.8';
export const ACCEPT_PAGE = 'text/html, application/xhtml+xml, */*;q=0.8';

export interface Downloaded {
  body: Uint8Array;
  contentType: string;
  /** Where the content was finally served from, after redirects. */
  url: string;
  etag: string | null;
  lastModified: string | null;
  /** The server confirmed nothing changed since the given ETag/Last-Modified. */
  notModified: boolean;
}

/** A failed download, with a reason code the UI can turn into a sentence. */
export class DownloadError extends Error {
  override readonly name = 'DownloadError';
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

const reasonForStatus = (status: number): string =>
  status === 401 ? 'unauthorized'
  : status === 403 ? 'forbidden'
  : status === 404 || status === 410 ? 'not_found'
  : status === 429 ? 'rate_limited'
  : status >= 500 ? 'server_error'
  : 'http_error';

export async function download(url: string, opts: {
  accept?: string; etag?: string | null; lastModified?: string | null;
  timeoutMs?: number; headers?: Record<string, string>;
} = {}): Promise<Downloaded> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: opts.accept ?? ACCEPT_PAGE,
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    ...(opts.etag ? { 'if-none-match': opts.etag } : {}),
    ...(opts.lastModified ? { 'if-modified-since': opts.lastModified } : {}),
    ...opts.headers
  };
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers });
    const meta = {
      contentType: res.headers.get('content-type') ?? '',
      url: res.url || url,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified')
    };
    if (res.status === 304) return { ...meta, body: new Uint8Array(), notModified: true };
    if (!res.ok) throw new DownloadError(reasonForStatus(res.status), `http_${res.status}`);
    return { ...meta, body: new Uint8Array(await res.arrayBuffer()), notModified: false };
  } catch (e) {
    if (e instanceof DownloadError) throw e;
    if (ctl.signal.aborted) throw new DownloadError('timeout');
    throw new DownloadError('network', (e as Error)?.message);
  } finally { clearTimeout(timer); }
}

const privateAddress = (address: string): boolean => {
  const value = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(value) === 4) {
    const [a = 0, b = 0] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff');
};

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DownloadError('unsafe_protocol');
  if (!url.hostname || url.username || url.password || url.hostname.toLowerCase() === 'localhost') throw new DownloadError('private_target');
  const direct = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (direct.length === 0 || direct.some((entry) => privateAddress(entry.address))) throw new DownloadError('private_target');
}

/** Safe mode for URLs supplied by search/model output. Every redirect is
 * re-resolved so DNS rebinding and public-to-private redirects are rejected. */
export async function downloadPublic(input: string, opts: {
  timeoutMs?: number; maxBytes?: number; maxRedirects?: number; signal?: AbortSignal;
} = {}): Promise<Downloaded> {
  const ctl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  try {
    let url = new URL(input);
    for (let redirects = 0; ; redirects++) {
      await assertPublic(url);
      const response = await fetch(url, { signal, redirect: 'manual', headers: { 'user-agent': UA, accept: ACCEPT_PAGE } });
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= (opts.maxRedirects ?? 5)) throw new DownloadError('too_many_redirects');
        const location = response.headers.get('location'); if (!location) throw new DownloadError('bad_redirect');
        url = new URL(location, url); continue;
      }
      if (!response.ok) throw new DownloadError(reasonForStatus(response.status), `http_${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new DownloadError('too_large');
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new DownloadError('too_large'); }
        chunks.push(value);
      }
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return { body, contentType: response.headers.get('content-type') ?? '', url: url.href,
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), notModified: false };
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (signal.aborted) throw new DownloadError('timeout');
    throw new DownloadError('network', String((error as Error)?.message ?? error));
  } finally { clearTimeout(timer); }
}
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
