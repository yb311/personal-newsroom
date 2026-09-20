import { JSDOM, VirtualConsole } from 'jsdom';

/** Publisher pages carry CSS that jsdom's parser rejects. It is irrelevant to
 *  text extraction, and a desktop app must not spew parser warnings, so every
 *  JSDOM here gets a silent console. */
const quiet = (): VirtualConsole => new VirtualConsole();
const dom = (html: string, url?: string): JSDOM =>
  new JSDOM(html, { virtualConsole: quiet(), ...(url ? { url } : {}) });
import type { RichBlock } from '@pnr/core';
import { countWords } from '@pnr/core';

export interface Extraction {
  blocks: RichBlock[];
  words: number;
  engine: 'defuddle' | 'extractus' | 'structural';
  title?: string;
  author?: string;
  publishedAt?: string;
  leadImage?: string;
}

/** Below this an extraction is considered too thin to be the article body. */
export const MIN_WORDS = 120;
/** A structural fallback must beat the winner by this ratio to replace it. */
const STRUCTURAL_UPGRADE_RATIO = 1.3;
const UPGRADE_THRESHOLD_WORDS = 250;

const DROP_SELECTORS =
  'script,style,noscript,iframe,form,nav,aside,footer,header,figure>figcaption>a,' +
  '[class*="newsletter" i],[class*="promo" i],[class*="related" i],[class*="share" i],' +
  '[class*="subscribe" i],[class*="advert" i],[id*="comment" i]';

/**
 * Publisher boilerplate that survives readability extraction: image-gallery
 * captions, licensing notices, newsletter pitches, consent prompts.
 *
 * Split in two on purpose. ANCHORED patterns describe a whole paragraph and are
 * safe at any length. LOOSE patterns only describe boilerplate when they make up
 * most of a short line — a real article that happens to mention "purchase
 * licensing rights" inside a sentence must not be discarded.
 */
const ANCHORED = [
  /^item \d+ of \d+\b/i,
  /^\[\d+\/\d+\]/,
  /^(advertisement|sponsored(\s+content)?|ad feedback)$/i,
  /^(read more|related|see also|share this|follow us|more on this story)[:：]?$/i,
  /^sign up (for|to)\b/i,
  /^subscribe (to|now)\b/i,
  /^(we|this site) uses? cookies\b/i,
  /^(by\s+)?(reuters|ap|afp|getty)\s*$/i,
  /^\s*(图|photo|image|credit|摄)[:：]/i,
  /^(广告|推广|赞助内容)$/
];

/** Applied only to short lines (see LOOSE_MAX_CHARS). */
const LOOSE = [
  /purchase licensing rights/i,
  /opens? (in )?(a )?new tab/i,
  /all rights reserved/i,
  /版权所有|未经授权.{0,6}禁止转载/
];
const LOOSE_MAX_CHARS = 160;

const isBoilerplate = (text: string): boolean => {
  const t = text.trim();
  if (!t) return true;
  if (ANCHORED.some((re) => re.test(t))) return true;
  return t.length <= LOOSE_MAX_CHARS && LOOSE.some((re) => re.test(t));
};

/** Converts extracted article HTML into the shared RichBlock render contract. */
export function htmlToBlocks(html: string): RichBlock[] {
  const d = dom(`<body>${html}</body>`);
  const doc = d.window.document;
  for (const el of doc.querySelectorAll(DROP_SELECTORS)) el.remove();

  const blocks: RichBlock[] = [];
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  for (const el of doc.body.querySelectorAll('p,h2,h3,h4,blockquote,ul,ol,table,img,pre')) {
    // Skip nodes already covered by an ancestor we emitted.
    if (el.closest('blockquote,ul,ol,table') && !['BLOCKQUOTE','UL','OL','TABLE'].includes(el.tagName)) continue;
    const tag = el.tagName;
    if (tag === 'P' || tag === 'PRE') {
      const text = clean(el.textContent);
      if (text.length >= 2 && !isBoilerplate(text)) blocks.push({ type: 'paragraph', text });
    } else if (tag === 'H2' || tag === 'H3' || tag === 'H4') {
      const text = clean(el.textContent);
      if (text) blocks.push({ type: 'heading', level: tag === 'H2' ? 2 : 3, text });
    } else if (tag === 'BLOCKQUOTE') {
      const text = clean(el.textContent);
      if (text) blocks.push({ type: 'quote', text });
    } else if (tag === 'UL' || tag === 'OL') {
      const items = [...el.querySelectorAll(':scope > li')]
        .map((li) => clean(li.textContent))
        .filter((s) => s && !isBoilerplate(s));
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'OL', items });
    } else if (tag === 'TABLE') {
      const rowsEl = [...el.querySelectorAll('tr')];
      if (rowsEl.length < 2) continue;
      const head = [...rowsEl[0]!.querySelectorAll('th,td')].map((c) => clean(c.textContent));
      const columns = head.map((label, i) => ({ key: `c${i}`, label: label || `列 ${i + 1}` }));
      const rows = rowsEl.slice(1).map((tr) => {
        const cells = [...tr.querySelectorAll('td,th')].map((c) => clean(c.textContent));
        return Object.fromEntries(columns.map((c, i) => [c.key, cells[i] ?? '']));
      });
      if (rows.length) blocks.push({ type: 'table', columns, rows });
    } else if (tag === 'IMG') {
      const src = el.getAttribute('src');
      if (src && /^https?:/.test(src)) {
        const alt = clean(el.getAttribute('alt'));
        blocks.push({ type: 'image', url: src, ...(alt ? { alt } : {}) });
      }
    }
  }
  return blocks;
}

/** Last resort: pull the densest article-ish container straight out of the DOM.
 *  daily-brief added this because readability engines are sometimes overly
 *  aggressive — e.g. the <article> element on BBC holds 350 words that defuddle
 *  throws away. */
function structural(html: string): RichBlock[] {
  const doc = dom(html).window.document;
  for (const el of doc.querySelectorAll(DROP_SELECTORS)) el.remove();
  const candidates = [...doc.querySelectorAll('article,main,[role="main"],[itemprop="articleBody"],.article-body,.story-body')];
  let best: Element | null = null, bestLen = 0;
  for (const c of candidates) {
    const len = (c.textContent ?? '').length;
    if (len > bestLen) { best = c; bestLen = len; }
  }
  return best ? htmlToBlocks(best.innerHTML) : [];
}

const extractusPromise = import('@extractus/article-extractor').catch(() => null);

/**
 * Runs both readability engines in parallel and keeps whichever produced more
 * words, then lets a structural pass override if it is clearly richer.
 * This dual-engine approach is ported wholesale from daily-brief, where it was
 * tuned against real publisher markup.
 */
export async function extractArticle(html: string, url: string): Promise<Extraction | null> {
  const [defuddleRes, extractusRes] = await Promise.allSettled([
    (async () => {
      const { default: Defuddle } = await import('defuddle');
      const d = dom(html, url);
      // Defuddle builds very long removal selectors that jsdom's selector engine
      // rejects (>2048 chars). It catches that internally and still returns
      // content, but logs the whole stack. Silence it: this is a desktop app,
      // not a server, and the extraction result is unaffected.
      const realError = console.error;
      console.error = () => {};
      try {
        const r = new Defuddle(d.window.document, { url }).parse();
        return { html: r.content ?? '', title: r.title, author: r.author, published: r.published, image: r.image };
      } finally { console.error = realError; }
    })(),
    (async () => {
      const mod = await extractusPromise;
      if (!mod) return null;
      const r = await mod.extractFromHtml(html, url);
      return r ? { html: r.content ?? '', title: r.title, author: r.author, published: r.published, image: r.image } : null;
    })()
  ]);

  const cands: { blocks: RichBlock[]; words: number; engine: Extraction['engine']; meta: any }[] = [];
  const push = (r: PromiseSettledResult<any>, engine: 'defuddle' | 'extractus'): void => {
    if (r.status !== 'fulfilled' || !r.value?.html) return;
    const blocks = htmlToBlocks(r.value.html);
    if (blocks.length) cands.push({ blocks, words: countWords(blocks), engine, meta: r.value });
  };
  push(defuddleRes, 'defuddle');
  push(extractusRes, 'extractus');

  cands.sort((a, b) => b.words - a.words);
  let winner = cands[0];

  if (!winner || winner.words < UPGRADE_THRESHOLD_WORDS) {
    const s = structural(html);
    const sw = countWords(s);
    if (s.length && (!winner || sw > winner.words * STRUCTURAL_UPGRADE_RATIO)) {
      winner = { blocks: s, words: sw, engine: 'structural', meta: winner?.meta ?? {} };
    }
  }
  if (!winner) return null;

  const m = winner.meta ?? {};
  return {
    blocks: winner.blocks, words: winner.words, engine: winner.engine,
    ...(m.title ? { title: String(m.title) } : {}),
    ...(m.author ? { author: String(m.author) } : {}),
    ...(m.published ? { publishedAt: String(m.published) } : {}),
    ...(m.image ? { leadImage: String(m.image) } : {})
  };
}
