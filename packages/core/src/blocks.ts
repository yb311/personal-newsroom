/**
 * Rich content blocks — the render contract shared by extracted article bodies,
 * AI-written summaries and deep dives.
 *
 * Ported from daily-brief lib/core/schemas/digest.ts, with the bilingual field
 * pairs (zh/en) collapsed to a single `text`, because output language here is a
 * user setting rather than a fixed pair of sites.
 */
export type ClaimType = 'fact' | 'claim' | 'estimate' | 'preliminary';

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
  claimType?: ClaimType;
  /** Bound source ids. Models may reference these but may never invent URLs. */
  sourceRefIds?: string[];
}
export interface HeadingBlock { type: 'heading'; level: 2 | 3; text: string }
export interface ListBlock {
  type: 'list'; ordered?: boolean; items: string[]; sourceRefIds?: string[];
}
export interface QuoteBlock {
  type: 'quote'; text: string; attribution?: string; claimType?: ClaimType; sourceRefIds?: string[];
}
export interface TableColumn { key: string; label: string }
export interface TableBlock {
  type: 'table'; columns: TableColumn[]; rows: Array<Record<string, string>>;
  caption?: string; sourceRefIds?: string[];
}
export interface ImageBlock { type: 'image'; url: string; alt?: string; caption?: string }

export type RichBlock =
  | ParagraphBlock | HeadingBlock | ListBlock | QuoteBlock | TableBlock | ImageBlock;

export const blockText = (b: RichBlock): string => {
  switch (b.type) {
    case 'paragraph': case 'heading': case 'quote': return b.text;
    case 'list': return b.items.join(' ');
    case 'table': return b.rows.map((r) => Object.values(r).join(' ')).join(' ');
    case 'image': return b.caption ?? b.alt ?? '';
  }
};

export const countWords = (blocks: RichBlock[]): number => {
  const text = blocks.map(blockText).join(' ');
  const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const latin = (text.replace(/[一-鿿぀-ヿ]/g, ' ').match(/\b[\w'-]+\b/g) ?? []).length;
  return cjk + latin;
};
