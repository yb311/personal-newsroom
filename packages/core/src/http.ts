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
