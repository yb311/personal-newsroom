import { readBody } from '@pnr/store';
import { localDateTime } from '@pnr/core';

/** One article as the writing prompts see it. */
export interface Material {
  id: string;
  title: string;
  snippet: string | null;
  publishedAt: number;
  sourceName: string | null;
  bodyState: string;
  bodyPath: string | null;
}

/** Columns that fill a Material, for queries over `items i LEFT JOIN sources s`. */
export const MATERIAL_COLS = `i.id, i.title, i.snippet, i.published_at AS publishedAt, s.name AS sourceName,
  i.body_state AS bodyState, i.body_path AS bodyPath`;

/**
 * What the model reads for one item: the opening of the extracted article when
 * there is one, otherwise the feed's summary. Writing from headlines alone
 * produced rewritten headlines and filler; the body carries the facts.
 */
export function materialText(m: Material, maxChars: number): { text: string; fromBody: boolean } {
  const body = m.bodyState === 'ok' ? readBody(m.bodyPath) : null;
  if (body?.text) return { text: body.text.replace(/\n+/g, ' ').slice(0, maxChars), fromBody: true };
  return { text: (m.snippet ?? '').slice(0, Math.min(maxChars, 300)), fromBody: false };
}

/** `id | local time | source | title` then the material text on the next line. */
export function materialBlock(m: Material, maxChars: number): string {
  const { text, fromBody } = materialText(m, maxChars);
  const head = `${m.id} | ${localDateTime(m.publishedAt)} | ${m.sourceName ?? ''} | ${m.title}`;
  return text ? `${head}\n  ${fromBody ? '正文' : '摘要'}：${text}` : head;
}
