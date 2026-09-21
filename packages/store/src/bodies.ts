import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Article bodies live on disk, not in the database: they are large, they are
 * never queried by content, and keeping them as files makes backup a folder copy.
 */
export interface StoredBody {
  itemId: string;
  url: string;
  /** Sanitised by the reader core; safe to render as it is. */
  html: string;
  /** The same content as plain text, one block per line, for AI input. */
  text: string;
  words: number;
  lang: string | null;
  /** 'feed' when the feed carried the full article, 'page' when it was extracted. */
  source: 'feed' | 'page';
  engine: string;
  extractedAt: number;
}

export function bodyPathFor(dataDir: string, itemId: string): string {
  return join(dataDir, 'bodies', itemId.slice(0, 2), `${itemId}.json`);
}

export function writeBody(dataDir: string, body: StoredBody): string {
  const path = bodyPathFor(dataDir, body.itemId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
  return path;
}

export function readBody(path: string | null | undefined): StoredBody | null {
  if (!path || !existsSync(path)) return null;
  try {
    const b = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredBody>;
    return typeof b.html === 'string' ? (b as StoredBody) : null;
  } catch { return null; }
}
