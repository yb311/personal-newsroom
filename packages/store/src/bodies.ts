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
    if (typeof b.html !== 'string') return null;
    return { ...(b as StoredBody), html: dropPromoHtml(b.html), text: dropPromoText(b.text ?? '') };
  } catch { return null; }
}

/**
 * Newsletter pitches that sit between paragraphs as a paragraph of their own
 * ("Sign up here.", "Subscribe to our newsletter"). Only a short block whose
 * whole text is the pitch is dropped; a sentence that merely mentions
 * subscribing stays. Applied on read so bodies saved earlier are cleaned too.
 */
const PROMO = /^(?:(?:click|tap) here to )?(?:sign(?:ing)? up|subscribe|register|get (?:our|the) newsletter)\b.*\b(?:here|now|today|newsletters?|inbox)\b.*$|^(?:sign up|subscribe)[\s.!:]*$|^(?:点击)?(?:订阅|注册)(?:我们的)?(?:新闻)?(?:通讯|简报|邮件|电子报)?[。！!\s]*$/i;

export function isPromo(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 120 && PROMO.test(t);
}

const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&');

export function dropPromoHtml(html: string): string {
  return html.replace(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi, (block, _tag, inner: string) => isPromo(plain(inner)) ? '' : block);
}

export function dropPromoText(text: string): string {
  return text.split('\n').filter((line) => !isPromo(line)).join('\n');
}
