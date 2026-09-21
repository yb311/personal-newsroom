import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Client for the reader core (native/reader), a Go program built from
 * Miniflux's feed-reading packages and go-trafilatura.
 *
 * It turns downloaded bytes into clean data: it detects the charset, parses
 * RSS/Atom/RDF/JSON feeds and news sitemaps, extracts article bodies and
 * sanitises HTML. It never touches the network — see @pnr/core's download().
 *
 * One long-lived process serves the whole app. It starts on first use,
 * restarts if it dies, and is released (unref'd) while idle so a short-lived
 * worker can exit without closing it explicitly.
 */

export interface CoreItem {
  title: string;
  url: string;
  publishedAt: string;
  dateEstimated?: boolean;
  author?: string;
  summary?: string;
  contentHtml?: string;
  contentText?: string;
  words: number;
  imageUrl?: string;
  lang?: string;
}

export interface CoreFeed {
  items: CoreItem[];
  fetched: number;
  dropped: Record<string, number>;
  /** Child sitemap URLs, when the body was a sitemap index. */
  children?: string[];
}

export interface CoreArticle {
  url: string;
  html: string;
  text: string;
  words: number;
  title?: string;
  author?: string;
  publishedAt?: string;
  image?: string;
  lang?: string;
  engine: 'rules' | 'trafilatura';
}

export interface Cleaned { html: string; text: string; words: number }

/** A request the core answered with a failure; `reason` is a stable code. */
export class CoreError extends Error {
  override readonly name = 'CoreError';
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

const BINARY = 'pnr-reader';

/**
 * Where the binary is: an explicit override, then the packaged app's
 * Resources/bin (seen from the Electron main process or from the background
 * worker, which runs the app executable as Node), then the development build
 * found by walking up from the working directory or the running script.
 */
export function locateBinary(): string | null {
  const candidates: string[] = [];
  if (process.env['PNR_READER_BIN']) candidates.push(process.env['PNR_READER_BIN']);
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(join(resources, 'bin', BINARY));
  candidates.push(join(dirname(process.execPath), '..', 'Resources', 'bin', BINARY));
  for (const start of [process.cwd(), dirname(process.argv[1] ?? process.cwd())]) {
    for (let dir = start; ; dir = dirname(dir)) {
      candidates.push(join(dir, 'native', 'reader', 'bin', BINARY));
      if (dirname(dir) === dir) break;
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }

class ReaderCore {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = '';

  #start(): ChildProcessWithoutNullStreams {
    if (this.#child) return this.#child;
    const bin = locateBinary();
    if (!bin) throw new CoreError('core_missing', 'pnr-reader not found; run `npm run reader:build`');
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    // The core logs warnings to stderr; they are not part of the protocol.
    child.stderr.resume();
    child.on('exit', () => this.#onExit(child));
    child.on('error', () => this.#onExit(child));
    this.#child = child;
    return child;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id: number; result?: unknown; error?: { reason: string; detail?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CoreError(msg.error.reason, msg.error.detail));
      else p.resolve(msg.result);
    }
    this.#idle();
  }

  #onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#buffer = '';
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CoreError('core_crashed'));
    }
    this.#pending.clear();
  }

  // An idle child must not keep a finished worker process alive.
  #idle(): void {
    const c = this.#child;
    if (!c) return;
    const busy = this.#pending.size > 0;
    for (const s of [c, c.stdin, c.stdout, c.stderr] as unknown as { ref(): void; unref(): void }[]) {
      if (busy) s.ref(); else s.unref();
    }
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const child = this.#start();
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#idle();
        reject(new CoreError('core_timeout', method));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#idle();
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.#child?.stdin.end();
    this.#child = null;
  }
}

let core: ReaderCore | null = null;
const instance = (): ReaderCore => (core ??= new ReaderCore());

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/** Parses a downloaded feed ("feed"), Google News sitemap ("sitemap") or sitemap index. */
export const parseFeed = (baseUrl: string, kind: 'feed' | 'sitemap' | 'sitemap_index', body: Uint8Array): Promise<CoreFeed> =>
  instance().request('parseFeed', { baseUrl, kind, body: b64(body) });

/** Extracts the article body from a downloaded page. */
export const extractArticle = (url: string, body: Uint8Array, contentType: string): Promise<CoreArticle> =>
  instance().request('extract', { url, body: b64(body), contentType });

/** Sanitises HTML fragments (RSSHub descriptions, Telegram posts) and returns their text. */
export const cleanHtml = (items: { baseUrl: string; html: string }[]): Promise<Cleaned[]> =>
  items.length ? instance().request('clean', { items }) : Promise.resolve([]);

/** Turns titles and other short strings with markup or escaped entities into plain text. */
export const plainText = (texts: string[]): Promise<string[]> =>
  texts.length ? instance().request('plain', { texts }) : Promise.resolve([]);

/** Stops the core process. Only needed where exit must be immediate. */
export const closeReaderCore = (): void => { core?.close(); };
