import type { Db } from '@pnr/store';
import { readBody } from '@pnr/store';
import { getWatch } from '@pnr/watch';
import { localDateKey, type RichBlock } from '@pnr/core';
import { getDigest } from './digest.ts';
import { getFlash } from './flashes.ts';
import { openQuestions, timeline } from './progress.ts';
import { getReport } from './report.ts';
import { getChat } from './assistant.ts';
import { decodeEntities, readTranslation, withTranslation } from './translate.ts';
import type { ScreenFocus } from './screen.ts';

/**
 * 导出 — what is open, as a file to keep: Markdown, HTML, or (from the HTML) PDF.
 *
 * As with the assistant's view of the screen (screen.ts), the renderer only
 * says *which* thing is open; everything is read here from the database, in
 * full. Citations keep working outside the app: each numbered marker points at
 * a source list with the real headline, outlet, date and link, so nothing the
 * app wrote loses its sourcing on the way out.
 */
export type ExportFormat = 'markdown' | 'html' | 'pdf';

/** Words the file shows, in the interface language (from the renderer's dictionaries). */
export interface ExportLabels {
  digest: string; outside: string; flash: string; watch: string; report: string; chat: string; articles: string;
  intent: string; timeline: string; questions: string; why: string; whyMatters: string;
  /** The flag on a flash rated 8 or more of 10, as the 快讯 list marks it. */
  important: string;
  sources: string; original: string; noBody: string;
  /** The closing line, with `{{date}}`. */
  exported: string;
}

export interface ExportOptions {
  labels: ExportLabels;
  /** For dates, e.g. 'zh-CN'. */
  locale: string;
  /** How an article is shown in the reader; its translation is exported the same way. */
  translation?: { mode: 'original' | 'bilingual' | 'translation'; target: string } | undefined;
}

export interface ExportSource { title: string; url: string; publisher: string | null; publishedAt: number | null }
export interface ExportListItem { text: string; cites?: number[]; lead?: string; url?: string; meta?: string }
export type ExportBlock =
  | { type: 'heading'; text: string; level: 2 | 3; kicker?: string | undefined }
  | { type: 'paragraph'; text: string; cites?: number[]; label?: string; muted?: boolean }
  | { type: 'list'; ordered?: boolean; items: ExportListItem[] }
  | { type: 'quote'; text: string; cites?: number[] }
  | { type: 'table'; columns: string[]; rows: string[][]; cites?: number[] }
  | { type: 'image'; url: string; alt?: string | undefined; caption?: string | undefined }
  /** A stored article body: HTML already cleaned by the reader core. */
  | { type: 'html'; html: string };

export interface ExportDoc {
  title: string;
  /** Translated headline under the original, in 双语. */
  subtitle?: string | undefined;
  lang: string | null;
  meta: string[];
  /** The article's own page. */
  link?: string | undefined;
  blocks: ExportBlock[];
  /** Numbered from 1 in order of first citation. */
  sources: ExportSource[];
  /** The closing line. */
  footer: string;
}

// ── building ────────────────────────────────────────────────────────────────

/** Flashes rated this or more (of 10) are flagged 重要, as in the 快讯 list (Flashes.tsx). */
const IMPORTANT = 8;

type ItemRow = { id: string; title: string; url: string; publishedAt: number; author: string | null; snippet: string | null;
  bodyPath: string | null; lang: string | null; sourceName: string | null };
const itemRow = (db: Db, id: string): ItemRow | undefined =>
  db.prepare(`SELECT i.id, i.title, i.url, i.published_at AS publishedAt, i.author, i.snippet, i.body_path AS bodyPath, i.lang,
    CASE WHEN s.id LIKE 'search:%' THEN NULL ELSE s.name END AS sourceName
    FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).get(id) as ItemRow | undefined;

/** Numbers sources as they are first cited; the same source keeps its number. */
function citations(db: Db) {
  const list: ExportSource[] = [];
  const numbers = new Map<string, number>();
  const add = (key: string, make: () => ExportSource | null): number | null => {
    const known = numbers.get(key); if (known) return known;
    const s = make(); if (!s) return null;
    list.push(s); numbers.set(key, list.length);
    return list.length;
  };
  const item = (id: string): number | null => add(`item:${id}`, () => {
    const r = itemRow(db, id);
    return r ? { title: r.title, url: r.url, publisher: r.sourceName, publishedAt: r.publishedAt } : null;
  });
  const items = (ids: string[] | undefined): number[] => (ids ?? []).map(item).filter((n): n is number => n !== null);
  return { list, add, item, items };
}

function dates(locale: string) {
  const format = (opts: Intl.DateTimeFormatOptions) => {
    try { return new Intl.DateTimeFormat(locale, opts); } catch { return new Intl.DateTimeFormat('en', opts); }
  };
  const long = format({ dateStyle: 'long' });
  const full = format({ dateStyle: 'long', timeStyle: 'short' });
  return {
    /** A YYYY-MM-DD calendar day, read as local noon so no timezone moves it. */
    day: (key: string): string => { const d = new Date(`${key}T12:00:00`); return Number.isNaN(d.getTime()) ? key : long.format(d); },
    at: (ts: number | null | undefined): string => (ts ? full.format(new Date(ts)) : '')
  };
}

/** The open screen as a document, or null when it no longer exists. */
export function buildExport(db: Db, focus: ScreenFocus, opts: ExportOptions): ExportDoc | null {
  const L = opts.labels;
  const when = dates(opts.locale);
  const c = citations(db);
  const footer = L.exported.replace('{{date}}', when.at(Date.now()));
  const f = focus;

  if (f.kind === 'article') {
    const it = itemRow(db, f.itemId); if (!it) return null;
    const body = readBody(it.bodyPath);
    const tr = opts.translation && opts.translation.mode !== 'original' ? opts.translation : null;
    const done = tr ? readTranslation(db, it.id, tr.target) : null;
    const html = body?.html && tr && done ? withTranslation(body.html, done.blocks, tr.mode === 'bilingual' ? 'bilingual' : 'translated') : body?.html;
    const translatedTitle = done?.title ?? null;
    const blocks: ExportBlock[] = html ? [{ type: 'html', html }]
      : [...(it.snippet ? [{ type: 'paragraph' as const, text: textOnly(it.snippet) }] : []), { type: 'paragraph', text: L.noBody, muted: true }];
    return {
      title: tr?.mode === 'translation' && translatedTitle ? translatedTitle : it.title,
      subtitle: tr?.mode === 'bilingual' && translatedTitle ? translatedTitle : undefined,
      lang: tr?.mode === 'translation' ? tr.target : it.lang,
      meta: [it.sourceName, when.at(it.publishedAt), it.author].filter((x): x is string => Boolean(x)),
      link: it.url, blocks, sources: [], footer
    };
  }

  if (f.kind === 'articles') {
    const rows = (f.itemIds ?? []).map((id) => itemRow(db, id)).filter((r): r is ItemRow => Boolean(r));
    return {
      title: String(f.title ?? L.articles), lang: null, meta: [L.articles], sources: [], footer,
      blocks: [{ type: 'list', items: rows.map((r) => ({ text: r.title, url: r.url, meta: [r.sourceName, when.at(r.publishedAt)].filter(Boolean).join(' · ') })) }]
    };
  }

  if (f.kind === 'digest') {
    const d = getDigest(db, f.date); if (!d) return null;
    return { title: d.title, lang: d.lang, meta: [L.digest, when.day(d.editionDate)], blocks: d.blocks.map((b) => richBlock(db, b, c)), sources: c.list, footer };
  }

  if (f.kind === 'outside') {
    const p = db.prepare('SELECT edition_date AS date, lang, event_title AS title, importance_reason AS reason, item_ids_json AS ids FROM outside_picks WHERE id = ?')
      .get(f.pickId) as { date: string; lang: string | null; title: string; reason: string; ids: string } | undefined;
    if (!p) return null;
    const cites = c.items(JSON.parse(p.ids) as string[]);
    return { title: p.title, lang: p.lang, meta: [L.outside, when.day(p.date)], sources: c.list, footer,
      blocks: [{ type: 'paragraph', label: L.why, text: p.reason, cites }] };
  }

  if (f.kind === 'flash') {
    const fl = getFlash(db, f.flashId); if (!fl) return null;
    const cites = c.items(fl.itemIds);
    return {
      title: fl.title, lang: fl.lang, meta: [L.flash, when.at(fl.publishedAt), ...(fl.importance >= IMPORTANT ? [L.important] : [])], sources: c.list, footer,
      blocks: [{ type: 'paragraph', text: fl.body, cites },
        ...(fl.importanceReason ? [{ type: 'paragraph' as const, label: L.whyMatters, text: fl.importanceReason }] : [])]
    };
  }

  if (f.kind === 'watch') {
    const w = getWatch(db, f.watchId); if (!w) return null;
    const blocks: ExportBlock[] = [{ type: 'heading', level: 2, text: L.intent }, { type: 'quote', text: w.intent }];
    const ms = timeline(db, w.id).reverse();
    if (ms.length) blocks.push({ type: 'heading', level: 2, text: L.timeline },
      { type: 'list', items: ms.map((m) => ({ lead: when.day(m.occurredOn), text: m.summary, cites: c.items(m.itemIds) })) });
    const qs = openQuestions(db, w.id);
    if (qs.length) blocks.push({ type: 'heading', level: 2, text: L.questions }, { type: 'list', items: qs.map((q) => ({ text: q.question })) });
    return { title: w.label, lang: w.outputLang ?? null, meta: [L.watch], blocks, sources: c.list, footer };
  }

  if (f.kind === 'report') {
    const r = getReport(db, { anchorItemId: f.anchorItemId, lang: f.lang }); if (!r) return null;
    const byRef = new Map(r.sources.map((s) => [s.refId, s]));
    const cite = (refs: string[]): number[] => refs.map((ref) => {
      const s = byRef.get(ref); if (!s) return null;
      return s.itemId ? c.item(s.itemId)
        : c.add(`report:${r.id}:${ref}`, () => ({ title: s.title, url: s.url, publisher: s.publisher, publishedAt: s.publishedAt }));
    }).filter((n): n is number => n !== null);
    const answers = r.messages.filter((m) => m.role === 'assistant' && m.status === 'complete' && m.answer);
    const blocks: ExportBlock[] = [];
    let first = true;
    for (const m of r.messages) {
      if (m.role === 'user' && m.question && !first) blocks.push({ type: 'heading', level: 2, text: m.question });
      if (m.role === 'assistant' && m.status === 'complete' && m.answer) {
        blocks.push(...units(m.answer.units, cite));
        first = false;
      }
    }
    return { title: answers[0]?.answer?.title || r.topic.split('\n')[0]!, lang: r.lang, meta: [L.report, when.at(r.updatedAt)], blocks, sources: c.list, footer };
  }
  return null;
}

/** One conversation with the news assistant, questions as headings. */
export function buildChatExport(db: Db, chatId: string, opts: ExportOptions): ExportDoc | null {
  const chat = getChat(db, chatId); if (!chat) return null;
  const when = dates(opts.locale);
  const c = citations(db);
  const byRef = new Map(chat.sources.map((s) => [s.refId, s]));
  const cite = (refs: string[]): number[] => refs.map((ref) => {
    const s = byRef.get(ref); if (!s) return null;
    return s.itemId ? c.item(s.itemId)
      : c.add(`chat:${chat.id}:${ref}`, () => ({ title: s.title, url: s.url, publisher: s.publisher, publishedAt: s.publishedAt }));
  }).filter((n): n is number => n !== null);
  const blocks: ExportBlock[] = [];
  for (const m of chat.messages) {
    if (m.role === 'user' && m.content) blocks.push({ type: 'heading', level: 2, text: m.content });
    else if (m.role === 'assistant' && m.status === 'complete' && m.answer) blocks.push(...units(m.answer.units, cite));
  }
  if (!blocks.length) return null;
  return { title: chat.title, lang: chat.lang, meta: [opts.labels.chat, when.at(chat.updatedAt)], blocks, sources: c.list,
    footer: opts.labels.exported.replace('{{date}}', when.at(Date.now())) };
}

/** Written units (deep reports, assistant answers) as blocks; consecutive list-like units become one list. */
function units(list: { kind: string; text: string; sourceRefIds: string[] }[], cite: (refs: string[]) => number[]): ExportBlock[] {
  const out: ExportBlock[] = [];
  for (const u of list) {
    const cites = cite(u.sourceRefIds ?? []);
    if (u.kind === 'paragraph' || u.kind === 'translation') out.push({ type: 'paragraph', text: u.text, cites });
    else if (u.kind === 'note') out.push({ type: 'paragraph', text: u.text, muted: true });
    else {
      const last = out.at(-1);
      if (last?.type === 'list') last.items.push({ text: u.text, cites });
      else out.push({ type: 'list', items: [{ text: u.text, cites }] });
    }
  }
  return out;
}

function richBlock(db: Db, b: RichBlock, c: ReturnType<typeof citations>): ExportBlock {
  switch (b.type) {
    case 'heading': return { type: 'heading', level: b.level, text: b.text, kicker: b.watchId ? getWatch(db, b.watchId)?.label : undefined };
    case 'paragraph': return { type: 'paragraph', text: b.text, cites: c.items(b.sourceRefIds) };
    case 'quote': return { type: 'quote', text: b.attribution ? `${b.text} — ${b.attribution}` : b.text, cites: c.items(b.sourceRefIds) };
    case 'list': {
      // The list's sources follow its last item, as in the app.
      const cites = c.items(b.sourceRefIds);
      return { type: 'list', ...(b.ordered ? { ordered: true } : {}), items: b.items.map((text, i) => ({ text, ...(i === b.items.length - 1 ? { cites } : {}) })) };
    }
    case 'table': return { type: 'table', columns: b.columns.map((col) => col.label), rows: b.rows.map((r) => b.columns.map((col) => r[col.key] ?? '')), cites: c.items(b.sourceRefIds) };
    case 'image': return { type: 'image', url: b.url, alt: b.alt, caption: b.caption };
  }
}

const textOnly = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const webUrl = (url: string | undefined): url is string => Boolean(url && /^https?:\/\//i.test(url));

// ── Markdown ────────────────────────────────────────────────────────────────

/** Markdown with footnote citations (`[^1]`), which Obsidian, Typora and GitHub show as linked notes. */
export function toMarkdown(doc: ExportDoc, labels: ExportLabels): string {
  const one = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const refs = (cites: number[] | undefined): string => (cites ?? []).map((n) => `[^${n}]`).join('');
  const out: string[] = [`# ${one(doc.title)}`];
  if (doc.subtitle) out.push(`*${one(doc.subtitle)}*`);
  const meta = [...doc.meta, ...(webUrl(doc.link) ? [`[${labels.original}](${doc.link})`] : [])];
  if (meta.length) out.push(meta.join(' · '));
  for (const b of doc.blocks) {
    if (b.type === 'heading') out.push(`${b.kicker ? `*${one(b.kicker)}*\n\n` : ''}${'#'.repeat(b.level)} ${one(b.text)}`);
    else if (b.type === 'paragraph') {
      const text = `${b.label ? `**${b.label}**　` : ''}${b.text.trim()}${refs(b.cites)}`;
      out.push(b.muted ? `*${text}*` : text);
    } else if (b.type === 'quote') out.push(`${b.text.trim()}${refs(b.cites)}`.split('\n').map((l) => `> ${l}`).join('\n'));
    else if (b.type === 'list') out.push(b.items.map((it, i) => {
      const text = webUrl(it.url) ? `[${one(it.text)}](${it.url})` : one(it.text);
      return `${b.ordered ? `${i + 1}.` : '-'} ${it.lead ? `**${it.lead}**　` : ''}${text}${refs(it.cites)}${it.meta ? ` — ${it.meta}` : ''}`;
    }).join('\n'));
    else if (b.type === 'table') {
      const cell = (s: string): string => one(s).replace(/\|/g, '\\|');
      out.push([`| ${b.columns.map(cell).join(' | ')} |`, `| ${b.columns.map(() => '---').join(' | ')} |`,
        ...b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + (b.cites?.length ? `\n\n${refs(b.cites)}` : ''));
    } else if (b.type === 'image') { if (webUrl(b.url)) out.push(`![${one(b.alt ?? '')}](${b.url})${b.caption ? `\n\n*${one(b.caption)}*` : ''}`); }
    else if (b.type === 'html') { const md = htmlToMarkdown(b.html); if (md) out.push(md); }
  }
  if (doc.sources.length) out.push(doc.sources.map((s, i) => `[^${i + 1}]: ${sourceLine(s, (t, u) => webUrl(u) ? `[${one(t)}](${u})` : one(t))}`).join('\n'));
  out.push('---', `*${doc.footer}*`);
  return out.join('\n\n') + '\n';
}

/** Headline (linked), outlet, date. `text` escapes the plain parts for the format. */
const sourceLine = (s: ExportSource, link: (title: string, url: string) => string, text: (s: string) => string = (x) => x): string =>
  [link(s.title, s.url), s.publisher ? text(s.publisher) : null, s.publishedAt ? localDateKey(s.publishedAt) : null].filter(Boolean).join(' · ');

type HNode = string | { tag: string; attrs: Record<string, string>; kids: HNode[] };
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'video', 'audio', 'picture']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'dl', 'dt', 'dd', 'details', 'summary']);
/** Stands for a <br> while whitespace is collapsed. */
const BR = '\u0001';

/** A forgiving tree of cleaned article HTML: unclosed elements close with their parent, stray closes are ignored. */
function parseHtml(html: string): HNode[] {
  const root: Exclude<HNode, string> = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html))) {
    const top = stack.at(-1)!;
    if (!m[2]) { if (!m[0].startsWith('<!--')) top.kids.push(decodeEntities(m[0])); continue; }
    const name = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.findLastIndex((n) => n.tag === name);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
      attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const el = { tag: name, attrs, kids: [] as HNode[] };
    top.kids.push(el);
    if (!VOID.has(name) && !m[4]) stack.push(el);
  }
  return root.kids;
}

const rawText = (n: HNode): string => (typeof n === 'string' ? n : n.kids.map(rawText).join(''));
const escapeMd = (s: string): string => s.replace(/([\\`*_[\]])/g, '\\$1');

function inline(n: HNode): string {
  if (typeof n === 'string') return escapeMd(n);
  if (SKIP.has(n.tag)) return '';
  const inner = (): string => n.kids.map(inline).join('');
  /** Markers hug the text: `**x** ` not `** x **`, which Markdown would not read as bold. */
  const wrap = (mark: string): string => {
    const [, lead, core, trail] = inner().match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return core ? `${lead}${mark}${core}${mark}${trail}` : `${lead}${trail}`;
  };
  switch (n.tag) {
    case 'br': return BR;
    case 'strong': case 'b': return wrap('**');
    case 'em': case 'i': case 'cite': return wrap('*');
    case 'del': case 's': case 'strike': return wrap('~~');
    case 'code': case 'kbd': case 'samp': { const t = rawText(n).replace(/\s+/g, ' '); return t ? `\`${t.replace(/`/g, 'ˋ')}\`` : ''; }
    case 'img': return webUrl(n.attrs['src']) ? `![${escapeMd(n.attrs['alt'] ?? '')}](${n.attrs['src']})` : '';
    case 'a': {
      const text = inner();
      const href = n.attrs['href'];
      return href && /^(https?|mailto):/i.test(href) ? (text.trim() ? `[${text.trim()}](${href})` : '') : text;
    }
    default: return inner();
  }
}

const collapse = (s: string): string => s.replace(/[ \t\r\n\f]+/g, ' ').replace(new RegExp(` ?${BR} ?`, 'g'), BR).trim()
  .replace(new RegExp(`^${BR}+|${BR}+$`, 'g'), '').replace(new RegExp(BR, 'g'), '  \n');

/** Block-level Markdown of a container's children; runs of inline content become paragraphs. */
function blocks(nodes: HNode[]): string[] {
  const out: string[] = [];
  let run = '';
  const flush = (): void => { const t = collapse(run); if (t) out.push(t); run = ''; };
  for (const n of nodes) {
    if (typeof n !== 'string' && BLOCKS.has(n.tag)) { flush(); out.push(...block(n)); }
    else run += inline(n);
  }
  flush();
  return out;
}

function block(n: Exclude<HNode, string>): string[] {
  const t = n.tag;
  if (/^h[1-6]$/.test(t)) {
    // The document title is the only level-1 heading; the body's headings sit below it.
    const text = collapse(n.kids.map(inline).join('')).replace(/  \n/g, ' ');
    return text ? [`${'#'.repeat(Math.min(6, Number(t[1]) + 1))} ${text}`] : [];
  }
  switch (t) {
    case 'hr': return ['---'];
    case 'pre': { const code = rawText(n).replace(/^\n|\n$/g, ''); return code.trim() ? [`\`\`\`\n${code.replace(/```/g, '`​``')}\n\`\`\``] : []; }
    case 'blockquote': { const inner = blocks(n.kids).join('\n\n'); return inner ? [inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')] : []; }
    case 'figcaption': { const text = collapse(n.kids.map(inline).join('')); return text ? [`*${text}*`] : []; }
    case 'ul': case 'ol': {
      const items = n.kids.filter((k): k is Exclude<HNode, string> => typeof k !== 'string' && k.tag === 'li');
      const start = Number(n.attrs['start']) || 1;
      const lines = items.map((li, i) => {
        const marker = t === 'ol' ? `${start + i}.` : '-';
        const body = blocks(li.kids).join('\n\n') || '';
        const pad = ' '.repeat(marker.length + 1);
        return `${marker} ${body.split('\n').map((l, j) => (j === 0 || !l ? l : pad + l)).join('\n')}`;
      });
      return lines.length ? [lines.join('\n')] : [];
    }
    case 'table': {
      const rows: string[][] = [];
      const walk = (x: HNode): void => {
        if (typeof x === 'string') return;
        if (x.tag === 'tr') rows.push(x.kids.filter((k): k is Exclude<HNode, string> => typeof k !== 'string' && (k.tag === 'td' || k.tag === 'th'))
          .map((cell) => collapse(cell.kids.map(inline).join('')).replace(/  \n/g, ' ').replace(/\|/g, '\\|')));
        else x.kids.forEach(walk);
      };
      n.kids.forEach(walk);
      const width = Math.max(0, ...rows.map((r) => r.length));
      if (!width) return [];
      const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return [[line(rows[0]!), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')];
    }
    case 'dt': { const text = collapse(n.kids.map(inline).join('')); return text ? [`**${text}**`] : []; }
    default: return SKIP.has(t) ? [] : blocks(n.kids);
  }
}

/** Cleaned article HTML as Markdown: headings, lists, quotes, tables, links and images survive; layout does not. */
export function htmlToMarkdown(html: string): string {
  return blocks(parseHtml(html)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── HTML ────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The language of a document with none recorded, from its script, so CJK text is justified as in the app. */
const scriptLang = (text: string): string => (/[぀-ヿ]/.test(text) ? 'ja' : /[一-鿿]/.test(text) ? 'zh' : 'en');

/**
 * One self-contained page in the reading area's look: daily-brief's paper, ink
 * and brick red, serif text. Nothing runs in it (the policy forbids scripts);
 * images are the only thing it loads. The same page is printed for PDF.
 */
export function toHtml(doc: ExportDoc, labels: ExportLabels): string {
  const one = (s: string): string => esc(s.replace(/\s+/g, ' ').trim());
  const para = (s: string): string => esc(s.trim()).replace(/\n+/g, '<br>');
  const refs = (cites: number[] | undefined): string => (cites ?? []).map((n) => `<sup class="cite"><a href="#source-${n}">${n}</a></sup>`).join('');
  const body: string[] = [];
  for (const b of doc.blocks) {
    if (b.type === 'heading') body.push(`${b.kicker ? `<p class="kicker">${one(b.kicker)}</p>` : ''}<h${b.level}>${one(b.text)}</h${b.level}>`);
    else if (b.type === 'paragraph') body.push(`<p${b.muted ? ' class="muted"' : ''}>${b.label ? `<strong class="label">${one(b.label)}</strong>` : ''}${para(b.text)}${refs(b.cites)}</p>`);
    else if (b.type === 'quote') body.push(`<blockquote><p>${para(b.text)}${refs(b.cites)}</p></blockquote>`);
    else if (b.type === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      body.push(`<${tag}${b.items.some((i) => i.lead) ? ' class="timeline"' : ''}>${b.items.map((it) =>
        `<li>${it.lead ? `<strong class="lead">${one(it.lead)}</strong>` : ''}${webUrl(it.url) ? `<a href="${esc(it.url)}">${one(it.text)}</a>` : para(it.text)}${refs(it.cites)}${it.meta ? `<span class="meta"> · ${one(it.meta)}</span>` : ''}</li>`).join('')}</${tag}>`);
    } else if (b.type === 'table') body.push(`<table><thead><tr>${b.columns.map((col) => `<th>${one(col)}</th>`).join('')}</tr></thead><tbody>${
      b.rows.map((r) => `<tr>${r.map((cell) => `<td>${one(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>${b.cites?.length ? `<p>${refs(b.cites)}</p>` : ''}`);
    else if (b.type === 'image') { if (webUrl(b.url)) body.push(`<figure><img src="${esc(b.url)}" alt="${esc(b.alt ?? '')}">${b.caption ? `<figcaption>${one(b.caption)}</figcaption>` : ''}</figure>`); }
    else if (b.type === 'html') body.push(`<div class="article-body">${b.html}</div>`);
  }
  const meta = [...doc.meta.map(one), ...(webUrl(doc.link) ? [`<a href="${esc(doc.link)}">${esc(labels.original)}</a>`] : [])];
  const sources = doc.sources.length ? `<section class="sources"><h2>${esc(labels.sources)}</h2><ol>${doc.sources.map((s, i) =>
    `<li id="source-${i + 1}">${sourceLine(s, (t, u) => (webUrl(u) ? `<a href="${esc(u)}">${one(t)}</a>` : one(t)), one)}</li>`).join('')}</ol></section>` : '';
  const lang = doc.lang || scriptLang(doc.title + doc.blocks.map((b) => ('text' in b ? b.text : '')).join(''));
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'">
<title>${one(doc.title)}</title>
<style>${CSS}</style>
</head>
<body>
<article>
<header>
<h1>${one(doc.title)}</h1>
${doc.subtitle ? `<p class="subtitle">${one(doc.subtitle)}</p>` : ''}
${meta.length ? `<p class="doc-meta">${meta.join(' · ')}</p>` : ''}
</header>
${body.join('\n')}
${sources}
<footer>${esc(doc.footer)}</footer>
</article>
</body>
</html>
`;
}

// The reading area's tokens (apps/renderer/src/styles/tokens.css), light and dark.
const CSS = `
:root { --bg: #f5f2eb; --fg: #1a1a1a; --muted: #7a7a7a; --border: #d0cdc4; --accent: #c0392b;
  --serif: 'Noto Serif SC', 'Playfair Display', Charter, 'Songti SC', 'STSong', Georgia, serif;
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace; color-scheme: light dark; }
@media screen and (prefers-color-scheme: dark) { :root { --bg: #0f0f0f; --fg: #e8e5dc; --muted: #b0ada4; --border: #2a2a2a; --accent: #e05a4e; } }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0; padding: 48px 20px 64px; font: 17px/1.75 var(--serif); }
article { max-width: 42em; margin: 0 auto; }
html:lang(zh) article, html:lang(ja) article { text-align: justify; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; text-wrap: pretty; text-align: start; }
h1 { font-size: 2em; margin: 0 0 .3em; }
h2 { font-size: 1.35em; margin: 1.8em 0 .5em; }
h3 { font-size: 1.15em; margin: 1.5em 0 .4em; }
.subtitle { font-size: 1.15em; color: var(--muted); margin: 0 0 .5em; }
.doc-meta, .kicker, .meta, .sources, footer { font-size: .8em; color: var(--muted); text-align: start; }
.doc-meta { margin: 0 0 2em; padding-bottom: 1em; border-bottom: 1px solid var(--border); }
.kicker { margin: 2em 0 -1.2em; color: var(--accent); letter-spacing: .02em; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.cite { font-size: .7em; line-height: 0; margin-left: .1em; }
.cite a::before { content: '['; } .cite a::after { content: ']'; }
.label { margin-right: .6em; }
.muted { color: var(--muted); }
blockquote { margin: 1.2em 0; padding: 0 0 0 1em; border-left: 3px solid var(--accent); }
ul.timeline { list-style: none; padding: 0; }
ul.timeline li { margin: 0 0 .9em; padding-left: 1em; border-left: 2px solid var(--border); }
.lead { display: block; font-size: .8em; color: var(--muted); }
img, video { max-width: 100%; height: auto; }
figure { margin: 1.5em 0; }
figcaption { font-size: .8em; color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-size: .9em; margin: 1.2em 0; }
th, td { border: 1px solid var(--border); padding: .35em .6em; text-align: start; vertical-align: top; }
pre, code { font-family: var(--mono); font-size: .85em; }
pre { white-space: pre-wrap; padding: .8em 1em; border: 1px solid var(--border); border-radius: 2px; }
.pnr-t { color: var(--muted); }
.sources { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--border); }
.sources h2 { font-size: 1em; margin: 0 0 .6em; color: var(--fg); }
.sources ol { padding-left: 1.6em; margin: 0; }
.sources li { margin: 0 0 .3em; word-break: break-word; }
footer { margin-top: 3em; }
@page { size: A4; margin: 18mm 16mm; }
@media print { html { background: #fff; color: #1a1a1a; } body { padding: 0; font-size: 11pt; } a { color: #1a1a1a; }
  .cite a, .doc-meta a { color: #c0392b; } h1, h2, h3 { break-after: avoid; } figure, blockquote, li { break-inside: avoid; } }
`;
