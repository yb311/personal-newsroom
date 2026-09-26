import type { Db } from '@pnr/store';
import { getWatch } from '@pnr/watch';
import { blockText, localDateTime } from '@pnr/core';
import { getDigest } from './digest.ts';
import { getFlash } from './flashes.ts';
import { openQuestions, timeline } from './progress.ts';
import { getReport } from './report.ts';

/**
 * What the reader has open on the left while asking the assistant — so 「这篇讲了
 * 什么」 or 「这件事最近怎么样了」 need no restating.
 *
 * The renderer only says *which* thing is open; the text comes from the
 * database here, in full, never from what happens to be rendered. The app's own
 * writing (a brief, a timeline, a flash) is passed as it stands, and the articles
 * behind it become numbered sources, so an answer about it still cites reporting.
 */
export type ScreenFocus =
  | { kind: 'article'; itemId: string }
  /** An article list with nothing selected: the rows shown, newest first. */
  | { kind: 'articles'; title: string; itemIds: string[] }
  | { kind: 'digest'; date: string }
  | { kind: 'outside'; pickId: string }
  | { kind: 'flash'; flashId: string }
  | { kind: 'watch'; watchId: string }
  | { kind: 'report'; anchorItemId: string; lang: string };

/** From the renderer: what is open, and the short name it shows for it. */
export interface ScreenInput { focus: ScreenFocus; label: string }

/** A source the screen text points at with `[[key]]`: one of the reader's
 *  articles, or (for a deep report's search material) a page already read. */
export type ScreenSource = { key: string } & (
  | { itemId: string; full: boolean; brief: boolean }
  | { itemId?: undefined; title: string; url: string; publisher: string | null; publishedAt: number | null; material: string });

export interface ScreenMaterial { label: string; text: string; sources: ScreenSource[] }

/** Longest screen description sent; a watch with a long history is cut from its oldest end. */
const SCREEN_CHARS = 20_000;
const LIST_ROWS = 30;
const WATCH_ITEMS = 12;

export function describeScreen(db: Db, input: ScreenInput | null | undefined): ScreenMaterial | null {
  if (!input?.focus) return null;
  const label = String(input.label ?? '').trim().slice(0, 120);
  const sources: ScreenSource[] = [];
  const keys = new Map<string, string>();
  /** A marker for one article; the same article keeps the same marker. */
  const cite = (itemId: string, opts: { full?: boolean; brief?: boolean } = {}): string => {
    let key = keys.get(itemId);
    if (!key) {
      key = `a${keys.size + 1}`; keys.set(itemId, key);
      sources.push({ key, itemId, full: opts.full ?? false, brief: opts.brief ?? false });
    }
    return `[[${key}]]`;
  };
  const cites = (ids: string[] | undefined): string => (ids ?? []).map((id) => cite(id)).join('');
  const lines: string[] = [];
  const f = input.focus;
  let named = '';

  if (f.kind === 'article') {
    const it = itemRow(db, f.itemId); if (!it) return null;
    named = it.title;
    lines.push('An article open in the reader; its full text is the first material below.',
      `${cite(it.id, { full: true })} ${it.title} — ${it.sourceName ?? ''}, ${localDateTime(it.publishedAt)}`);
  } else if (f.kind === 'articles') {
    const ids = (f.itemIds ?? []).slice(0, LIST_ROWS);
    const rows = ids.map((id) => itemRow(db, id)).filter((r): r is ItemRow => Boolean(r));
    lines.push(`The article list 「${String(f.title ?? '').slice(0, 80)}」, with no article selected. Its first ${rows.length} rows, newest first:`);
    for (const r of rows) lines.push(`${cite(r.id, { brief: true })} ${localDateTime(r.publishedAt)} · ${r.sourceName ?? ''} · ${r.title}`);
  } else if (f.kind === 'digest') {
    const d = getDigest(db, f.date); if (!d) return null;
    lines.push(`The app's daily brief for ${d.editionDate}, as written: 「${d.title}」`);
    for (const b of d.blocks) {
      const text = blockText(b).trim(); if (!text) continue;
      const refs = 'sourceRefIds' in b ? cites(b.sourceRefIds) : '';
      lines.push(b.type === 'heading' ? `\n## ${text}` : b.type === 'list' ? b.items.map((x) => `- ${x}`).join('\n') + refs : text + refs);
    }
  } else if (f.kind === 'outside') {
    const p = db.prepare('SELECT edition_date AS date, event_title AS title, importance_reason AS reason, item_ids_json AS ids FROM outside_picks WHERE id = ?')
      .get(f.pickId) as { date: string; title: string; reason: string; ids: string } | undefined;
    if (!p) return null;
    lines.push(`An event the app picked for 「关注之外」 (important news outside the reader's watches) on ${p.date}:`,
      `${p.title}${cites(JSON.parse(p.ids) as string[])}`, `Why it was picked: ${p.reason}`);
  } else if (f.kind === 'flash') {
    const fl = getFlash(db, f.flashId); if (!fl) return null;
    lines.push(`A news flash the app wrote at ${localDateTime(fl.publishedAt)} (importance ${fl.importance}/5):`,
      `${fl.title}${cites(fl.itemIds)}`, fl.body, fl.importanceReason ? `Why it matters: ${fl.importanceReason}` : '');
  } else if (f.kind === 'watch') {
    const w = getWatch(db, f.watchId); if (!w) return null;
    lines.push(`A watch (a story the reader follows) named 「${w.label}」. The reader's own words for it:`, w.intent);
    const ms = timeline(db, w.id).reverse();
    if (ms.length) {
      lines.push('\nIts timeline of developments, newest first (「新」 = not yet seen by the reader):');
      // Sources for the latest developments only; older lines keep their text.
      let cited = 0;
      for (const m of ms) {
        const refs = cited < WATCH_ITEMS ? cites(m.itemIds.slice(0, 2)) : '';
        cited += refs ? 1 : 0;
        lines.push(`- ${m.occurredOn}${m.isNew ? ' 「新」' : ''} ${m.summary}${refs}`);
      }
    }
    const qs = openQuestions(db, w.id);
    if (qs.length) lines.push('\nOpen questions it is waiting on:', ...qs.map((q) => `- ${q.question}`));
    const recent = db.prepare(`SELECT i.id FROM matches m JOIN items i ON i.id = m.item_id
      WHERE m.watch_id = ? AND m.passed_gate = 1 ORDER BY i.published_at DESC LIMIT ?`).all(w.id, WATCH_ITEMS) as { id: string }[];
    const rows = recent.map((r) => itemRow(db, r.id)).filter((r): r is ItemRow => Boolean(r));
    if (rows.length) lines.push('\nIts latest related reporting:', ...rows.map((r) => `${cite(r.id, { brief: true })} ${localDateTime(r.publishedAt)} · ${r.sourceName ?? ''} · ${r.title}`));
  } else if (f.kind === 'report') {
    const r = getReport(db, { anchorItemId: f.anchorItemId, lang: f.lang }); if (!r) return null;
    const answer = r.messages.findLast((m) => m.role === 'assistant' && m.status === 'complete' && m.answer)?.answer;
    lines.push(`A deep report the app wrote on: ${r.topic.split('\n')[0]}`);
    const bySource = new Map(r.sources.map((s) => [s.refId, s]));
    const own = (ref: string): string => {
      const s = bySource.get(ref); if (!s) return '';
      if (s.itemId) return cite(s.itemId);
      const key = `r${ref}`;
      if (!sources.some((x) => x.key === key)) sources.push({ key, title: s.title, url: s.url, publisher: s.publisher, publishedAt: s.publishedAt, material: s.materialText });
      return `[[${key}]]`;
    };
    if (answer) {
      lines.push(`「${answer.title}」`);
      for (const u of answer.units) lines.push(`${u.kind === 'paragraph' ? '' : '- '}${u.text}${u.sourceRefIds.map(own).join('')}`);
    } else {
      lines.push('It has not been written yet.');
      cite(r.anchorItemId, { full: true });
    }
  }

  let text = lines.filter((l) => l !== '').join('\n');
  if (text.length > SCREEN_CHARS) text = `${text.slice(0, SCREEN_CHARS)}\n…`;
  return { label: (label || named || text.split('\n')[0]!).slice(0, 120), text, sources };
}

type ItemRow = { id: string; title: string; publishedAt: number; sourceName: string | null };
const itemRow = (db: Db, id: string): ItemRow | undefined =>
  db.prepare(`SELECT i.id, i.title, i.published_at AS publishedAt,
    CASE WHEN s.id LIKE 'search:%' THEN NULL ELSE s.name END AS sourceName
    FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).get(id) as ItemRow | undefined;
